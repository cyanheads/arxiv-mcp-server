/**
 * @fileoverview OAI-PMH harvester for arXiv `arXivRaw` metadata.
 * Implements `ListRecords` with resumption-token paging, tombstone handling,
 * recovery from a rejected token via `from=<last datestamp>` checkpoints (once
 * per checkpoint datestamp), and, for `mirror:init`, a wait through an
 * upstream outage that re-sends the same request.
 * @module services/arxiv/mirror/harvester
 */

import {
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
  timeout as timeoutError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import type { ArxivRawRecord, ArxivRawVersion, ArxivTombstone, OaiPage } from './types.js';

const USER_AGENT = 'arxiv-mcp-server-mirror (+https://github.com/cyanheads/arxiv-mcp-server)';

/** Configuration for the harvester. */
export interface HarvesterOptions {
  /** OAI base URL — defaults to `https://oaipmh.arxiv.org/oai`. */
  baseUrl: string;
  /** Minimum delay between OAI requests (ms). */
  requestDelayMs: number;
  /** Per-request timeout (ms). */
  requestTimeoutMs: number;
  /**
   * Wait out an upstream outage instead of failing (`mirror:init`; refresh
   * leaves it unset). A page fetch still failing with `Timeout` or
   * `ServiceUnavailable` after {@link PAGE_RETRY} waits, then re-sends the same
   * request, with no limit on the number of waits. See {@link OUTAGE_WAIT}. A
   * 4xx still ends the run, whether or not its body arrives.
   */
  waitOutOutages?: boolean;
}

/**
 * Retry policy for one page fetch. `maxDelayMs` is also the longest
 * `Retry-After` a retry honors (a longer one fails the fetch at once), so it —
 * not the exponential backoff — bounds each wait.
 */
const PAGE_RETRY = { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 30_000 } as const;

/**
 * The wait between failed page fetches under `waitOutOutages`: 1 minute,
 * doubling to 15, never shorter than the response's `Retry-After`, and back to
 * 1 minute once a page lands.
 */
const OUTAGE_WAIT = { firstMs: 60_000, maxMs: 900_000 } as const;

/** Longest delay `setTimeout` holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Longest one page fetch can take before it settles: every attempt running to
 * the request timeout, the longest wait between attempts, and the etiquette
 * delay that precedes the next request. A harvest with a deadline reserves
 * this much before it starts another page.
 */
export function worstCasePageFetchMs(options: HarvesterOptions): number {
  const attempts = PAGE_RETRY.maxRetries + 1;
  return (
    attempts * options.requestTimeoutMs +
    PAGE_RETRY.maxRetries * PAGE_RETRY.maxDelayMs +
    options.requestDelayMs
  );
}

/**
 * Pull one OAI `ListRecords` page. Returns parsed records, tombstones, and the
 * next resumption token (if any). Callers thread the token back in to continue.
 */
export function fetchListRecordsPage(
  params: { from?: string; metadataPrefix?: string; resumptionToken?: string },
  options: HarvesterOptions,
  ctx: {
    log?: { warning?: (msg: string, meta?: Readonly<Record<string, unknown>>) => void };
    signal: AbortSignal;
  },
): Promise<OaiPage> {
  const url = buildOaiUrl(options.baseUrl, params);
  return withRetry(
    async () => {
      const xml = await fetchOai(url, options.requestTimeoutMs, ctx.signal);
      return parseListRecords(xml);
    },
    { operation: 'arxivMirrorListRecords', signal: ctx.signal, ...PAGE_RETRY },
  );
}

/**
 * Orchestrate a full or incremental harvest. Streams pages via async
 * generator; the caller is responsible for batching writes and persisting
 * resumption state.
 *
 * A failed page fetch takes one path, in order:
 * 1. A cancelled `ctx.signal` rethrows at once.
 * 2. A rejected resumption token restarts from the latest checkpointed
 *    datestamp after the etiquette delay — unless the previous recovery
 *    restarted from that same datestamp, which fails the run with
 *    `token_recovery_stalled`. Only a later checkpoint counts as progress.
 * 3. With `options.waitOutOutages`, a `Timeout` or `ServiceUnavailable` waits
 *    ({@link OUTAGE_WAIT}) and re-sends the same request, unless it is marked
 *    not retryable (a 501, or a 4xx whose body stalled or dropped).
 * 4. Anything else rethrows.
 *
 * @param startToken - Resume from this token if provided.
 * @param from - Datestamp checkpoint (`YYYY-MM-DD`). The start of an
 *   incremental refresh, and the recovery point when a resumption token is
 *   rejected before any page has arrived.
 */
export async function* harvestPages(
  startToken: string | undefined,
  from: string | undefined,
  options: HarvesterOptions,
  ctx: {
    log?: { warning?: (m: string, meta?: Readonly<Record<string, unknown>>) => void };
    signal: AbortSignal;
  },
): AsyncGenerator<OaiPage> {
  let token: string | undefined = startToken;
  let useFrom: string | undefined = startToken ? undefined : from;
  // Latest datestamp of a page the consumer has taken. The generator resumes
  // only once the consumer has applied and checkpointed the page it yielded,
  // so this matches the caller's persisted checkpoint.
  let checkpoint: string | undefined = from;
  // The checkpoint the last token recovery restarted from.
  let recoveredFrom: string | undefined;
  let outageWaitMs: number = OUTAGE_WAIT.firstMs;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const request = token
      ? { resumptionToken: token }
      : { metadataPrefix: 'arXivRaw', ...(useFrom && { from: useFrom }) };
    let page: OaiPage;
    try {
      page = await fetchListRecordsPage(request, options, ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      // OAI `from` is inclusive and pages run in datestamp order, so a restart
      // from the checkpoint skips nothing past it.
      if (token && checkpoint && isTokenRejected(err)) {
        if (recoveredFrom === checkpoint) {
          throw validationError(
            `arXiv OAI-PMH rejected resumption token '${token}' again after the harvest restarted from ${checkpoint}, so token recovery made no progress. Check that ${options.baseUrl} accepts the resumption tokens it issues.`,
            { reason: 'token_recovery_stalled', resumptionToken: token, from: checkpoint },
            { cause: err },
          );
        }
        ctx.log?.warning?.('Resumption token rejected; recovering from datestamp', {
          resumptionToken: token,
          from: checkpoint,
        });
        recoveredFrom = checkpoint;
        token = undefined;
        useFrom = checkpoint;
        if (options.requestDelayMs > 0) await sleep(options.requestDelayMs, ctx.signal);
        continue;
      }
      if (options.waitOutOutages && isOutage(err)) {
        const waitMs = Math.min(Math.max(outageWaitMs, retryAfterMs(err) ?? 0), MAX_TIMER_MS);
        ctx.log?.warning?.('arXiv OAI-PMH unavailable; waiting, then re-sending the same request', {
          error: err.message,
          request,
          waitMs,
        });
        await sleep(waitMs, ctx.signal);
        outageWaitMs = Math.min(outageWaitMs * 2, OUTAGE_WAIT.maxMs);
        continue;
      }
      throw err;
    }

    outageWaitMs = OUTAGE_WAIT.firstMs;
    pages += 1;
    yield page;

    const stamp = pickLatestDatestamp(page);
    if (stamp && (!checkpoint || stamp > checkpoint)) checkpoint = stamp;

    if (!page.resumptionToken) return;
    token = page.resumptionToken;
    useFrom = undefined;

    // Etiquette delay between pages.
    if (options.requestDelayMs > 0) await sleep(options.requestDelayMs, ctx.signal);

    // Suppress runaway logs but emit a heartbeat every 100 pages.
    if (pages % 100 === 0) {
      ctx.log?.warning?.('Harvest progress', { pages, lastDatestamp: pickLatestDatestamp(page) });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function buildOaiUrl(
  baseUrl: string,
  params: { from?: string; metadataPrefix?: string; resumptionToken?: string },
): string {
  const sp = new URLSearchParams();
  sp.set('verb', 'ListRecords');
  if (params.resumptionToken) sp.set('resumptionToken', params.resumptionToken);
  if (params.metadataPrefix) sp.set('metadataPrefix', params.metadataPrefix);
  if (params.from) sp.set('from', params.from);
  return `${baseUrl}?${sp.toString()}`;
}

async function fetchOai(url: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: combined,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml' },
    });
  } catch (err) {
    throw transportError(err, url, timeoutMs, signal);
  }

  if (!response.ok) {
    if (response.status >= 500 && response.status < 600) {
      const failure = await httpErrorFromResponse(response, {
        service: 'arxiv-oai',
        codeOverride: (s) =>
          s >= 500 && s < 600 ? JsonRpcErrorCode.ServiceUnavailable : undefined,
      });
      // The body capture swallows a cancellation that lands mid-read.
      if (signal.aborted) throw signal.reason;
      throw failure;
    }
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      throw transportError(err, url, timeoutMs, signal, response.status);
    }
    throw invalidRequest(`arXiv OAI-PMH returned HTTP ${response.status}`, {
      url,
      status: response.status,
      body: body.slice(0, 500),
    });
  }

  // The request timeout also covers the body, which can stall or drop after
  // the headers arrive.
  try {
    return await response.text();
  } catch (err) {
    throw transportError(err, url, timeoutMs, signal);
  }
}

/**
 * Classify a failed request or body read: a cancelled `signal` passes through
 * as is, the request timeout becomes `Timeout`, and anything else is a network
 * error (`ServiceUnavailable`). Each message names the host, and a network
 * error its transport cause, but never the query string.
 *
 * @param clientErrorStatus - The 4xx whose body failed to arrive. Its status
 *   has already refused the request, and a re-send can't change that, so the
 *   error is marked not retryable: sent once, never waited out.
 */
function transportError(
  err: unknown,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  clientErrorStatus?: number,
): unknown {
  if (signal.aborted) return err;
  // A base URL that `fetch` rejects may not parse here either, and classifying it must not throw.
  const endpoint = url.split('?')[0] ?? url;
  const host = URL.canParse(url) ? new URL(url).host : endpoint;
  const during =
    clientErrorStatus === undefined
      ? ''
      : ` while reading the body of an HTTP ${clientErrorStatus} response`;
  const verdict =
    clientErrorStatus === undefined ? {} : { status: clientErrorStatus, retryable: false };
  if (err instanceof Error && err.name === 'TimeoutError') {
    return timeoutError(
      `arXiv OAI-PMH request to ${host} timed out after ${timeoutMs}ms${during}`,
      { url, timeoutMs, ...verdict },
      { cause: err },
    );
  }
  const cause = transportCause(err)?.replaceAll(url, endpoint);
  return serviceUnavailable(
    `arXiv OAI-PMH network error reaching ${host}${during}${cause ? `: ${cause}` : ''}`,
    { url, ...verdict },
    { cause: err },
  );
}

/**
 * The innermost error in a cause chain that carries a transport `code` (Bun
 * sets it on the error `fetch` raises, Node one `cause` down), as its message,
 * prefixed with the code when the message omits it.
 */
function transportCause(err: unknown): string | undefined {
  let detail: string | undefined;
  for (let node: unknown = err; node instanceof Error; node = node.cause) {
    const { code } = node as { code?: unknown };
    if (typeof code === 'string') {
      detail = node.message.includes(code) ? node.message : `${code}: ${node.message}`;
    }
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) =>
    typeof jpath === 'string' &&
    ['OAI-PMH.ListRecords.record', 'OAI-PMH.ListRecords.record.metadata.arXivRaw.version'].includes(
      jpath,
    ),
});

/** Parse a `ListRecords` response. Exported for tests. */
export function parseListRecords(xml: string): OaiPage {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed['OAI-PMH'] as Record<string, unknown> | undefined;
  if (!root) throw serializationError('OAI-PMH response missing OAI-PMH root', {});
  const err = root.error as { '@_code'?: string; '#text'?: string } | undefined;
  if (err) {
    const code = err['@_code'] ?? 'unknown';
    const message = err['#text'] ?? 'OAI-PMH error';
    throw oaiProtocolError(code, message);
  }
  const list = root.ListRecords as
    | {
        record?: Array<{
          header: {
            identifier: string;
            datestamp: string;
            '@_status'?: string;
          };
          metadata?: { arXivRaw?: ArxivRawXml };
        }>;
        resumptionToken?: string | { '@_expirationDate'?: string; '#text'?: string };
      }
    | undefined;
  if (!list) {
    // Some terminal responses omit the ListRecords element entirely.
    return { records: [], tombstones: [] };
  }

  const records: ArxivRawRecord[] = [];
  const tombstones: ArxivTombstone[] = [];
  for (const rec of list.record ?? []) {
    if (rec.header['@_status'] === 'deleted') {
      tombstones.push({
        paper_id: extractPaperId(rec.header.identifier),
        datestamp: rec.header.datestamp,
      });
      continue;
    }
    const md = rec.metadata?.arXivRaw;
    if (!md) continue;
    records.push(normalizeArxivRaw(md, rec.header.datestamp, rec.header.identifier));
  }

  let resumptionToken: string | undefined;
  if (typeof list.resumptionToken === 'string') {
    resumptionToken = list.resumptionToken.trim() || undefined;
  } else if (list.resumptionToken && typeof list.resumptionToken === 'object') {
    const text = list.resumptionToken['#text'];
    resumptionToken = typeof text === 'string' && text.trim() ? text.trim() : undefined;
  }

  return {
    records,
    tombstones,
    ...(resumptionToken !== undefined && { resumptionToken }),
  };
}

interface ArxivRawXml {
  abstract?: string;
  authors?: string;
  categories?: string;
  comments?: string;
  doi?: string;
  id?: string;
  'journal-ref'?: string;
  license?: string;
  'report-no'?: string;
  title?: string;
  version?: Array<{ '@_version'?: string; date?: string; size?: string; source_type?: string }>;
}

function normalizeArxivRaw(md: ArxivRawXml, datestamp: string, identifier: string): ArxivRawRecord {
  const versions: ArxivRawVersion[] = (md.version ?? []).map((v) => ({
    version: v['@_version'] ?? 'v1',
    date: v.date ?? '',
    ...(v.size && { size: v.size }),
    ...(v.source_type && { source_type: v.source_type }),
  }));
  return {
    paper_id: (md.id ?? extractPaperId(identifier)).trim(),
    identifier,
    datestamp,
    title: md.title ?? '',
    authors: md.authors ?? '',
    abstract: md.abstract ?? '',
    categories: md.categories ?? '',
    versions: versions.length > 0 ? versions : [{ version: 'v1', date: datestamp }],
    ...(md.comments && { comments: md.comments }),
    ...(md.doi && { doi: md.doi }),
    ...(md['journal-ref'] && { journal_ref: md['journal-ref'] }),
    ...(md.license && { license: md.license }),
    ...(md['report-no'] && { report_no: md['report-no'] }),
  };
}

function extractPaperId(identifier: string): string {
  return identifier.replace(/^oai:arXiv\.org:/, '');
}

/**
 * Maximum OAI datestamp across a page's records + tombstones. Used both for
 * checkpoint persistence (runner) and harvest heartbeat logs (this module).
 */
export function pickLatestDatestamp(page: {
  records: { datestamp: string }[];
  tombstones: { datestamp: string }[];
}): string | undefined {
  if (page.records.length === 0 && page.tombstones.length === 0) return;
  const stamps = [
    ...page.records.map((r) => r.datestamp),
    ...page.tombstones.map((t) => t.datestamp),
  ].filter(Boolean);
  stamps.sort();
  return stamps[stamps.length - 1];
}

function oaiProtocolError(code: string, message: string): McpError {
  if (code === 'badResumptionToken') {
    return validationError(`OAI badResumptionToken: ${message}`, {
      code,
      reason: 'token_rejected',
    });
  }
  if (code === 'noRecordsMatch') {
    return notFound(`OAI noRecordsMatch: ${message}`, { code });
  }
  return validationError(`OAI ${code}: ${message}`, { code });
}

/**
 * Detect a rejected resumption token. arXiv answers `badResumptionToken` for a
 * token it cannot decode (it stamps an `expirationDate` but never checks it),
 * which the parser maps to `McpError(ValidationError, …, { reason: 'token_rejected' })`.
 */
function isTokenRejected(err: unknown): boolean {
  return err instanceof McpError && err.data?.reason === 'token_rejected';
}

/**
 * Detect an upstream outage: a request timeout, network error, or 5xx, as
 * `fetchOai` classifies them, that is not marked non-retryable (a 501, or a
 * 4xx whose body stalled or dropped).
 */
function isOutage(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    (err.code === JsonRpcErrorCode.Timeout || err.code === JsonRpcErrorCode.ServiceUnavailable) &&
    err.data?.retryable !== false
  );
}

/**
 * The wait (ms) a `Retry-After` on the failed response asks for, in either
 * RFC 9110 form: delta-seconds (digits only) or an HTTP-date. Any other value
 * asks for nothing.
 */
function retryAfterMs(err: McpError): number | undefined {
  const raw = err.data?.retryAfter;
  if (typeof raw !== 'string') return;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = parseHttpDate(raw);
  return at === undefined ? undefined : Math.max(0, at - Date.now());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The three HTTP-date forms a recipient must accept (RFC 9110 §5.6.7), all in GMT. */
const HTTP_DATE_FORMS = [
  // IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/,
  // rfc850-date: Sunday, 06-Nov-94 08:49:37 GMT
  /^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<day>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/,
  // asctime-date: Sun Nov  6 08:49:37 1994
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>[A-Z][a-z]{2}) (?<day>[ \d]\d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/,
];

/** Epoch ms of an HTTP-date, or `undefined` for a value that isn't one. */
function parseHttpDate(value: string): number | undefined {
  for (const form of HTTP_DATE_FORMS) {
    const parts = form.exec(value)?.groups;
    if (!parts) continue;
    const month = MONTHS.indexOf(parts.month ?? '');
    const day = Number(parts.day);
    const [hours, minutes, seconds] = (parts.time ?? '').split(':').map(Number);
    let year = Number(parts.year);
    if (parts.year?.length === 2) {
      // rfc850-date: a two-digit year more than 50 years ahead is the last century's.
      const thisYear = new Date().getUTCFullYear();
      year += thisYear - (thisYear % 100);
      if (year > thisYear + 50) year -= 100;
    }
    const at = Date.UTC(year, month, day, hours, minutes, seconds);
    // Date.UTC rolls an out-of-range field over (a 24th hour, a 30 Feb); reject those.
    const back = new Date(at);
    const exact =
      month >= 0 &&
      back.getUTCDate() === day &&
      back.getUTCHours() === hours &&
      back.getUTCMinutes() === minutes &&
      back.getUTCSeconds() === seconds;
    return exact ? at : undefined;
  }
  return;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
