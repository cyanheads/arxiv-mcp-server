/**
 * @fileoverview OAI-PMH harvester for arXiv `arXivRaw` metadata.
 * Implements `ListRecords` with resumption-token paging, daily token-expiry
 * recovery via `from=<last datestamp>` checkpoints, and tombstone handling.
 * @module services/arxiv/mirror/harvester
 */

import {
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
  timeout as timeoutError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
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
}

/**
 * Pull one OAI `ListRecords` page. Returns parsed records, tombstones, and the
 * next resumption token (if any). Callers thread the token back in to continue.
 */
export function fetchListRecordsPage(
  params: { from?: string; metadataPrefix?: string; resumptionToken?: string },
  options: HarvesterOptions,
  ctx: { log?: { warning?: (msg: string, meta?: object) => void }; signal: AbortSignal },
): Promise<OaiPage> {
  const url = buildOaiUrl(options.baseUrl, params);
  const ctxLike = ctx as unknown as RequestContext;
  return withRetry(
    async () => {
      const xml = await fetchOai(url, options.requestTimeoutMs, ctx.signal);
      return parseListRecords(xml);
    },
    {
      operation: 'arxivMirrorListRecords',
      context: ctxLike,
      signal: ctx.signal,
      maxRetries: 2,
      baseDelayMs: 5000,
    },
  );
}

/**
 * Orchestrate a full or incremental harvest. Streams pages via async
 * generator; the caller is responsible for batching writes and persisting
 * resumption state.
 *
 * @param startToken - Resume from this token if provided.
 * @param from - Datestamp checkpoint (`YYYY-MM-DD`). Used both for incremental
 *   refresh and as recovery when a resumption token has expired.
 */
export async function* harvestPages(
  startToken: string | undefined,
  from: string | undefined,
  options: HarvesterOptions,
  ctx: { log?: { warning?: (m: string, meta?: object) => void }; signal: AbortSignal },
): AsyncGenerator<OaiPage> {
  let token: string | undefined = startToken;
  let useFrom: string | undefined = startToken ? undefined : from;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let page: OaiPage;
    try {
      page = await fetchListRecordsPage(
        token
          ? { resumptionToken: token }
          : { metadataPrefix: 'arXivRaw', ...(useFrom && { from: useFrom }) },
        options,
        ctx,
      );
    } catch (err) {
      // Daily expiry recovery: token expired or invalid → restart from the
      // last datestamp we observed.
      if (isTokenExpiredError(err) && from) {
        ctx.log?.warning?.('Resumption token expired; recovering from datestamp', { from });
        token = undefined;
        useFrom = from;
        continue;
      }
      throw err;
    }

    pages += 1;
    yield page;

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
    if (signal.aborted) throw err;
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw timeoutError(
        `arXiv OAI-PMH timed out after ${timeoutMs}ms`,
        { url, timeoutMs },
        { cause: err },
      );
    }
    throw serviceUnavailable('arXiv OAI-PMH network error', { url }, { cause: err });
  }

  if (!response.ok) {
    if (response.status >= 500 && response.status < 600) {
      throw await httpErrorFromResponse(response, {
        service: 'arxiv-oai',
        codeOverride: (s) =>
          s >= 500 && s < 600 ? JsonRpcErrorCode.ServiceUnavailable : undefined,
      });
    }
    const body = await response.text();
    throw invalidRequest(`arXiv OAI-PMH returned HTTP ${response.status}`, {
      url,
      status: response.status,
      body: body.slice(0, 500),
    });
  }

  return response.text();
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
    return new McpError(JsonRpcErrorCode.ValidationError, `OAI badResumptionToken: ${message}`, {
      code,
      reason: 'token_expired',
    });
  }
  if (code === 'noRecordsMatch') {
    return new McpError(JsonRpcErrorCode.NotFound, `OAI noRecordsMatch: ${message}`, { code });
  }
  return new McpError(JsonRpcErrorCode.ValidationError, `OAI ${code}: ${message}`, { code });
}

/**
 * Detect the "resumption token expired" condition. arXiv returns
 * `badResumptionToken` for expired or unknown tokens, which our parser maps to
 * an `McpError(ValidationError, …, { reason: 'token_expired' })`.
 */
function isTokenExpiredError(err: unknown): boolean {
  return err instanceof McpError && err.data?.reason === 'token_expired';
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
