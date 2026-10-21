/**
 * @fileoverview ArxivService — search, metadata lookup, and HTML content fetching
 * for the arXiv academic paper repository. Handles rate limiting, retry with
 * exponential backoff via the framework's withRetry, and Atom XML parsing.
 * @module services/arxiv/arxiv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serializationError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import { getServerConfig } from '@/config/server-config.js';
import {
  categorySearchTerm,
  categorySubtree,
  SEARCHABLE_CATEGORY_CODES,
  suggestCategories,
} from './categories.js';
import {
  intersectBounds,
  isCalendarDate,
  submittedDateBounds,
  submittedDateClause,
} from './date-window.js';
import {
  expandCategoryOperands,
  isDriverError,
  MIRROR_SEARCH_MATCH_CAP,
  type MirrorNotReady,
  type MirrorQuery,
  type MirrorSearcher,
  type MirrorSearchOutcome,
  openReaderStore,
  type PaperRow,
  type ReadyMirror,
  searchInWorker,
  translateQuery,
} from './mirror/index.js';
import { extractInWorker, type PdfTextExtractor } from './pdf-text.js';
import {
  ARXIV_API_RESULT_LIMIT,
  type OutlineEntry,
  type PaperContent,
  type PaperContentSource,
  type PaperLookupMiss,
  type PaperLookupResult,
  type PaperMetadata,
  type ReadContentOptions,
  type SearchOptions,
  type SearchResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SORT_BY_MAP: Record<string, string> = {
  relevance: 'relevance',
  submitted: 'submittedDate',
  updated: 'lastUpdatedDate',
};

/**
 * User-Agent identifying this client to arXiv. arXiv's API guidance and
 * established community clients (e.g. arxiv.py) include a descriptive UA so
 * arXiv operators can identify and contact maintainers if a client misbehaves.
 */
const USER_AGENT = 'arxiv-mcp-server (+https://github.com/cyanheads/arxiv-mcp-server)';

/**
 * Cap on server-side cooldown derived from a `Retry-After` header. Prevents a
 * pathological upstream value from blocking the queue indefinitely. 30s aligns
 * with typical interactive-client timeouts.
 */
const MAX_COOLDOWN_MS = 30_000;

/**
 * Default cooldown applied when arXiv returns the plain-text `Rate exceeded.`
 * body without a `Retry-After` header. Conservative — gives arXiv breathing
 * room without blocking the queue for too long.
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that wakes immediately when `signal` aborts. Used for the cooldown
 * wait so a cancelled request doesn't hang for the full Retry-After window.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse an HTTP `Retry-After` header (RFC 9110 §10.2.3). Accepts both
 * delta-seconds (`"60"`) and HTTP-date (`"Wed, 21 Oct 2015 07:28:00 GMT"`)
 * formats. Returns the wait duration in milliseconds, or `null` if the value
 * is unparseable.
 */
function parseRetryAfter(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Retry predicate for arXiv calls. Excludes both `RateLimited` and `Timeout`
 * from the framework's default transient set:
 *
 * - `RateLimited`: surfaced when arXiv signals throttle (HTTP 429 or a 200 OK
 *   with `Rate exceeded.` body). Retrying violates arXiv's documented 3-second
 *   crawl etiquette and amplifies the throttle. See issue #8.
 * - `Timeout`: when arXiv is throttling at the connection layer (instead of
 *   returning a `Rate exceeded.` body), fetches hang until our 15s timeout
 *   fires. A retry just spends another 15s waiting for the same throttled
 *   connection, doubling caller-visible latency and upstream load. Treat
 *   timeouts the same as explicit rate-limits — surface immediately.
 *
 * Only `ServiceUnavailable` (5xx and raw network blips) and unknown non-McpError
 * throws stay retryable. Everything else defers to `defaultIsTransient` rather
 * than mirroring the framework's code set, so a change there — including its
 * `data.retryable === false` opt-out — reaches these calls too.
 */
function isArxivTransient(err: unknown): boolean {
  if (
    err instanceof McpError &&
    (err.code === JsonRpcErrorCode.RateLimited || err.code === JsonRpcErrorCode.Timeout)
  ) {
    return false;
  }
  return defaultIsTransient(err);
}

/**
 * One deadline for a whole `readContent` call: the metadata lookup (its wait for
 * the API queue included), every content rung, each retry, and the waits between
 * them. Per-request timeouts alone cannot bound the read, since it chains the
 * lookup and up to three content requests, retries the lookup, and replays the
 * content chain once. Every request and wait the read makes carries `signal`, so
 * it settles once `ARXIV_READ_TIMEOUT_MS` has passed, inside the request timeout
 * of the client waiting on it. See #69.
 */
interface ReadDeadline {
  /** The `Timeout` the read fails with once `signal` has fired; `detail` says what was pending. */
  exceeded(detail: string): McpError;
  /** Aborts once the read's time is up. */
  readonly signal: AbortSignal;
}

function startReadDeadline(paperId: string, timeoutMs: number): ReadDeadline {
  const signal = AbortSignal.timeout(timeoutMs);
  return {
    signal,
    exceeded: (detail) =>
      timeout(
        `Reading arXiv paper '${paperId}' timed out after ${timeoutMs}ms; ${detail}.`,
        { paperId, timeoutMs },
        { cause: signal.reason },
      ),
  };
}

/** The signal a call's waits end on: the caller's, joined by the read's deadline when it has one. */
function callSignal(ctx: Context, deadline?: ReadDeadline): AbortSignal {
  return deadline ? AbortSignal.any([ctx.signal, deadline.signal]) : ctx.signal;
}

/** One request's signal: the call's, plus the request's own timeout. */
function requestSignal(ctx: Context, timeoutMs: number, deadline?: ReadDeadline): AbortSignal {
  return AbortSignal.any([callSignal(ctx, deadline), AbortSignal.timeout(timeoutMs)]);
}

/** A request as its failures describe it. */
interface RequestSite {
  /** Context every failure of the request carries. */
  readonly data: Record<string, unknown>;
  /** The host as messages name it: `${label} timed out after …`, `${label} network error`. */
  readonly label: string;
  readonly timeoutMs: number;
}

/**
 * Classify a failed request: the `fetch` itself, or the read of a body that
 * stalled or dropped after its headers arrived — both fail the same way. A
 * caller cancellation is rethrown as the caller's own reason, and a read out of
 * time throws its deadline's `Timeout`; both end the call. Anything else is
 * returned for the caller to throw or hold: `Timeout` when the request's own
 * timeout fired (never retried, per `isArxivTransient` — a hang is
 * overwhelmingly throttling at the connection layer), `ServiceUnavailable` for a
 * network error (retried).
 */
function requestFailure(
  err: unknown,
  ctx: Context,
  site: RequestSite,
  deadline?: ReadDeadline,
): McpError {
  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (deadline?.signal.aborted) {
    throw deadline.exceeded(`the request to ${site.label} was still open`);
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return timeout(
      `${site.label} timed out after ${site.timeoutMs}ms`,
      { ...site.data, timeoutMs: site.timeoutMs },
      { cause: err },
    );
  }
  return serviceUnavailable(`${site.label} network error`, site.data, { cause: err });
}

/**
 * The error a content host's 5xx fails its rung with: `ServiceUnavailable`, 500
 * and 501 included, so `withRetry` replays the chain. Capturing the error body
 * for the message is a body read too: one that ran into the request's timeout or
 * deadline, or outlived a cancellation, fails as `requestFailure` says.
 */
async function serverErrorFailure(
  response: Response,
  service: string,
  signal: AbortSignal,
  ctx: Context,
  site: RequestSite,
  deadline: ReadDeadline,
): Promise<McpError> {
  const failure = await httpErrorFromResponse(response, {
    service,
    codeOverride: (s) => (s >= 500 && s < 600 ? JsonRpcErrorCode.ServiceUnavailable : undefined),
  });
  return signal.aborted ? requestFailure(signal.reason, ctx, site, deadline) : failure;
}

// ---------------------------------------------------------------------------
// Raw XML types (fast-xml-parser output shapes)
// ---------------------------------------------------------------------------

interface RawAtomLink {
  '@_href'?: string;
  '@_rel'?: string;
  '@_title'?: string;
  '@_type'?: string;
}

interface RawAtomEntry {
  'arxiv:comment'?: string;
  'arxiv:doi'?: string;
  'arxiv:journal_ref'?: string;
  'arxiv:primary_category'?: { '@_term': string };
  author?: { name: string }[];
  category?: { '@_term': string }[];
  id: string;
  link?: RawAtomLink[];
  published?: string;
  summary?: string;
  title?: string;
  updated?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an arXiv API URL preserving raw colons and commas in query values.
 * arXiv's API interprets `%3A` differently than `:` in field prefixes
 * (ti:, au:, cat:, etc.), so standard URLSearchParams encoding breaks queries.
 */
function buildApiUrl(baseUrl: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2C/gi, ',')}`,
    )
    .join('&');
  return `${baseUrl}/query?${query}`;
}

/**
 * Strip HTML boilerplate (head, site shell, nav chrome, site footer) so
 * truncation targets paper content. Tries to find the LaTeXML article element;
 * falls back to stripping just <head>.
 *
 * The article runs to the last `</article>`, tag kept: everything after it is
 * the site footer on both HTML rungs (build-log links, logos, error-reporting
 * instructions, scripts), while appendices and the bibliography sit inside it.
 * See issue #43.
 */
export function stripHtmlHead(html: string): string {
  // Best: find <article> which wraps the actual paper in arXiv/ar5iv HTML. An
  // opener counts once a `>` follows it: one literal search plus one `>`
  // lookup, linear in page length. See issue #52.
  const articleStart = html.search(/<article\b/i);
  if (articleStart !== -1 && html.indexOf('>', articleStart) !== -1) {
    const articleClose = html.lastIndexOf('</article>');
    return articleClose > articleStart
      ? html.slice(articleStart, articleClose + '</article>'.length)
      : html.slice(articleStart);
  }

  // Fallback: find LaTeXML page main content
  const ltxMain = html.match(/<div\s+class="ltx_page_main"/i);
  if (ltxMain) return html.slice(html.indexOf(ltxMain[0]));

  // Last resort: strip <head> and <body> tag
  const headEnd = html.indexOf('</head>');
  if (headEnd === -1) return html;
  let bodyStart = headEnd + '</head>'.length;
  const bodyTagMatch = html.slice(bodyStart, bodyStart + 200).match(/^\s*<body[^>]*>/i);
  if (bodyTagMatch) bodyStart += bodyTagMatch[0].length;
  return html.slice(bodyStart);
}

/** The notice LaTeXML leaves in a page whose conversion aborted. */
const CONVERSION_FAILURE_NOTICE = 'Conversion to HTML had a Fatal error';
/** An `ltx_ERROR` span and its text — the span ar5iv writes the notice into. */
const ERROR_SPAN = /<span class="ltx_ERROR\b[^"<>]*">([^<]*)<\/span>/g;

/**
 * Whether an HTML page is a converter's failure notice rather than a render:
 * the article carries LaTeXML's fatal-error notice and no other text. ar5iv
 * answers an aborted conversion with HTTP 200 and an empty `<article>` followed
 * by the notice; a partial render that keeps the notice beside paper text, or a
 * paper whose prose quotes it, still counts as a render. See issue #54.
 *
 * Only a page holding the notice is scanned further. The `ltx_ERROR` span that
 * carries the notice is dropped, then every tag, and whatever text is left is
 * paper content. Each span scan and each tag scan stops at the next `<`, so the
 * check stays linear in page length.
 */
export function isConversionFailurePage(html: string): boolean {
  if (!html.includes(CONVERSION_FAILURE_NOTICE)) return false;
  const text = stripHtmlHead(html)
    .replace(ERROR_SPAN, (span, spanText: string) =>
      spanText.includes(CONVERSION_FAILURE_NOTICE) ? '' : span,
    )
    .replace(/<[^<>]*>/g, '');
  return !/\S/.test(text);
}

/** Heading classes that mark document structure; theorem, proof, abstract, and contents titles do not. */
const OUTLINE_HEADING_CLASS =
  /\bltx_title_(?:part|chapter|section|subsection|subsubsection|paragraph|appendix|bibliography)\b/;
/** An `<hN>` opener whose class marks document structure: a heading `buildOutline` lists. */
const STRUCTURAL_HEADING = new RegExp(`<h[1-6]\\s[^<>]*${OUTLINE_HEADING_CLASS.source}`);
/**
 * LaTeXML's rendering of a `pdfpages` `\includepdf`: "See pages R of", or a
 * bare "See", then a link to the included file. The file's pages never reach
 * the HTML. Group 1 is the link's attributes.
 */
const INCLUDEPDF_PLACEHOLDER = /See (?:pages [^<>]{0,200} of )?<a\s([^<>]*)>[^<>]*<\/a>/g;
/** The class LaTeXML gives the placeholder's link (`ltx:ref`). */
const LTX_REF_CLASS = /\bclass="ltx_ref"/;

/**
 * Whether an HTML page is a render that holds none of the paper: its article
 * has no structural heading (none of the headings `buildOutline` lists) and
 * either carries an `\includepdf` placeholder or has no text at all. LaTeXML
 * renders each included PDF as one placeholder sentence, so a paper whose
 * source wraps PDFs comes back from both HTML rungs as HTTP 200 with those
 * sentences, at most beside front matter, while its PDF holds the pages. Both
 * rungs also answer 200 with an empty article, ar5iv's "No content available"
 * page among them. A page with a structural heading is a render whatever
 * placeholders it holds, like a thesis whose cover is an included page. See
 * issue #57.
 *
 * Each scan stops at the next `<` or `>`, or after a bounded run, so the check
 * stays linear in page length.
 */
export function isPlaceholderRender(html: string): boolean {
  const article = stripHtmlHead(html);
  if (STRUCTURAL_HEADING.test(article)) return false;
  for (const [, attributes = ''] of article.matchAll(INCLUDEPDF_PLACEHOLDER)) {
    if (LTX_REF_CLASS.test(attributes)) return true;
  }
  return !/\S/.test(article.replace(/<[^<>]*>/g, ''));
}

/**
 * Class tokens that mark document structure (sections, headings, bibliography,
 * abstract, etc.). The `ltx_*` classes generally carry no information a reader
 * benefits from, but these specific tokens identify section boundaries: the
 * outline (`buildOutline`) reads them from the cleaned body, and a caller can
 * navigate the paper by them without re-fetching from upstream.
 */
const LATEXML_STRUCTURAL_CLASS =
  /\bltx_(?:section|subsection|subsubsection|paragraph|subparagraph|appendix|bibliography|abstract|acknowledgements?|title|part|chapter)\b/;

/**
 * Collapse `<math>…</math>` elements to their LaTeX source, preserving the
 * inline-vs-block distinction. A typical inline `70%` expands to ~250 chars of
 * presentation MathML; the same content is present in the
 * `<annotation encoding="application/x-tex">` child as ~4 chars. On math-heavy
 * papers the MathML markup consumes the majority of the response budget while
 * carrying no incremental signal for a reader who can parse LaTeX. See issue #4.
 *
 * Preference order for the LaTeX source:
 *   1. `<annotation encoding="application/x-tex">…</annotation>` child
 *   2. `alttext="…"` attribute on the `<math>` element
 * If neither is present, the math element is dropped entirely.
 *
 * HTML entities (`&lt;`, `&gt;`, `&amp;`) in the LaTeX source are decoded so the
 * downstream consumer sees the raw TeX literally.
 *
 * A single forward pass: an element runs from `<math` to the first `>` and on to
 * the first `</math>` after it, and the scan resumes past that closer. An opener
 * with no `>` or no closer after it means none of the later ones has either, so
 * the pass stops there and leaves the rest as written. Linear in page length.
 * See issue #52.
 */
export function collapseMathML(html: string): string {
  const parts: string[] = [];
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = html.indexOf('<math', from);
    if (open === -1) break;
    const attrsStart = open + '<math'.length;
    if (/\w/.test(html.charAt(attrsStart))) {
      from = attrsStart; // `<mathvariant`, not a <math> element
      continue;
    }
    const tagEnd = html.indexOf('>', attrsStart);
    if (tagEnd === -1) break;
    const close = html.indexOf('</math>', tagEnd + 1);
    if (close === -1) break;
    parts.push(
      html.slice(copied, open),
      mathToTex(html.slice(attrsStart, tagEnd), html.slice(tagEnd + 1, close)),
    );
    copied = from = close + '</math>'.length;
  }
  parts.push(html.slice(copied));
  return parts.join('');
}

/** The TeX one `<math>` element collapses to, from its attributes and inner markup. */
function mathToTex(attrs: string, inner: string): string {
  const block = /\bdisplay=["']block["']/i.test(attrs);
  const tex = texAnnotation(inner) ?? attrs.match(/\balttext=["']([^"']*)["']/)?.[1];
  if (!tex) return '';
  const decoded = tex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return block ? `$$${decoded}$$` : `$${decoded}$`;
}

const TEX_ENCODING = /encoding=["']application\/x-tex["']/;

/**
 * Content of the first `<annotation …encoding="application/x-tex"…>` in `inner`,
 * up to its `</annotation>`. Forward pass on the same terms as `collapseMathML`:
 * an opener whose tag lacks the x-tex encoding is skipped past its `>` (any
 * opener inside that tag sees a suffix of it, so it lacks the encoding too).
 */
function texAnnotation(inner: string): string | undefined {
  let from = 0;
  for (;;) {
    const open = inner.indexOf('<annotation', from);
    if (open === -1) return;
    const tagEnd = inner.indexOf('>', open + '<annotation'.length);
    if (tagEnd === -1) return;
    if (TEX_ENCODING.test(inner.slice(open + '<annotation'.length, tagEnd))) {
      const close = inner.indexOf('</annotation>', tagEnd + 1);
      return close === -1 ? undefined : inner.slice(tagEnd + 1, close);
    }
    from = tagEnd + 1;
  }
}

/**
 * Strip LaTeXML-generated class/id noise, collapse MathML to LaTeX, and collapse
 * redundant break runs. LaTeXML emits `class="ltx_..."` and generated `id="..."`
 * on nearly every element, and renders inline math as full MathML trees whose
 * `<annotation encoding="application/x-tex">` child already carries the same
 * content in a fraction of the bytes. Stripping these typically shrinks a
 * math-heavy paper's HTML by an order of magnitude with zero content loss.
 *
 * Exception: class attributes containing a structural marker (see
 * LATEXML_STRUCTURAL_CLASS) are preserved verbatim so section boundaries remain
 * identifiable for downstream tooling.
 *
 * The class and id passes start a match only at the first character of a
 * whitespace run (`(?<!\s)`), which keeps them linear in page length. The
 * leftmost match already starts there, so the output is the same either way.
 * See issue #52.
 */
export function stripLatexmlNoise(html: string): string {
  return (
    collapseMathML(html)
      .replace(/(?<!\s)\s+class="(ltx_[^"]*)"/gi, (match, value) =>
        LATEXML_STRUCTURAL_CLASS.test(value) ? match : '',
      )
      .replace(/(?<!\s)\s+id="[^"]*"/gi, '')
      // Collapse runs of 2+ <br> tags (LaTeXML emits these around display math)
      .replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br>\n')
  );
}

/** A URL that names its own scheme (`https:`, `mailto:`) — already absolute. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/**
 * Rewrite each relative `src`, `href`, and `data` value to an absolute URL,
 * resolved against `baseUrl` — the URL that served the page — the way a browser
 * resolves it. LaTeXML figure paths are relative to the page
 * (`1706.03762v7/Figures/x.png` on arxiv.org, `/html/1706.03762/assets/x.png` on
 * ar5iv), so a caller holding only the body cannot fetch them. Fragment links
 * (`#bib.bib13`) stay as written: they read as citation and section keys, not
 * anything fetchable. See issue #43.
 *
 * `<[a-zA-Z][^<>]*>` stops each tag scan at the next `<` or `>`, so tag scans
 * never overlap and the pass stays linear in body length.
 */
export function resolveRelativeUrls(html: string, baseUrl: string): string {
  return html.replace(/<[a-zA-Z][^<>]*>/g, (tag) =>
    tag.replace(/(\s(?:src|href|data)=")([^"]*)"/g, (attr, prefix: string, value: string) => {
      if (value === '' || value.startsWith('#') || URL_SCHEME.test(value)) return attr;
      const resolved = URL.parse(value, baseUrl);
      return resolved ? `${prefix}${resolved.href}"` : attr;
    }),
  );
}

/** Most entries an outline carries; past it, the deepest heading levels are dropped whole. */
const OUTLINE_MAX_ENTRIES = 200;
/** Longest outline title, in characters. */
const OUTLINE_TITLE_MAX = 120;
/** Longest heading markup read for a title; a longer span is a heading that never closes. */
const HEADING_SOURCE_MAX = 4000;

/**
 * A cleaned LaTeXML heading opener, `<hN …>`, group 2 its attributes.
 * `stripLatexmlNoise` drops the `id` but keeps a structural class and any
 * other attribute beside it, such as the `style` LaTeXML gives a resized
 * heading (`<h4 class="ltx_title ltx_title_section" style="font-size:90%;">`).
 * The attribute scan stops at the next `<` or `>`. See issue #66.
 */
const HEADING_OPENER = /<h([1-6])(\s[^<>]*)?>/y;

const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"',
};

function decodeCharacterReferences(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z]+));/g,
    (ref, dec?: string, hex?: string, name?: string) => {
      if (name) return NAMED_CHARACTER_REFERENCES[name] ?? ref;
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
    },
  );
}

/**
 * An HTML tag: a name, then attributes after whitespace. Collapsed TeX keeps its
 * `<` and `>` raw (`$0<h<1$`, `$a<b$ and $c>d$`), and none of it reads as a tag.
 */
const HTML_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g;
/** A heading opener tag, `<h1`–`<h6` then whitespace or `>`. */
const HEADING_TAG = /<h[1-6][\s>]/g;

/** Heading markup to its title: tags stripped, references decoded, whitespace collapsed. */
function headingTitle(markup: string): string {
  const text = decodeCharacterReferences(markup.replace(HTML_TAG, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > OUTLINE_TITLE_MAX ? `${text.slice(0, OUTLINE_TITLE_MAX - 1)}…` : text;
}

/**
 * Section outline of a cleaned HTML body: each part, chapter, section,
 * subsection, subsubsection, paragraph, appendix, and bibliography heading, in
 * document order, with the offset of its `<hN` tag. `level` follows the tag
 * (h2 = 1), not the class — a paper with no `\section` renders its subsections
 * as `<h2>`. Past `OUTLINE_MAX_ENTRIES`, the deepest level is dropped whole until
 * the rest fit, and the dropped levels are returned. The shallowest level is
 * never dropped: when it alone passes the cap, its first `OUTLINE_MAX_ENTRIES`
 * entries are kept and `continuesAt` is the offset of the first one left out.
 * See issue #44.
 *
 * One forward pass. Each candidate `<h` is matched against a sticky opener
 * that stops at the next `<` or `>`, so no two candidates scan the same
 * characters, and the closer lookup is cached — a heading's closer is the first
 * `</h` after its content, which later headings reuse until they pass it — so
 * the scan stays linear in body length.
 */
export function buildOutline(body: string): {
  continuesAt?: number;
  entries: OutlineEntry[];
  omittedLevels: number[];
} {
  let entries: OutlineEntry[] = [];
  let close = -1;
  let pos = 0;
  for (;;) {
    pos = body.indexOf('<h', pos);
    if (pos === -1) break;
    HEADING_OPENER.lastIndex = pos;
    const opener = HEADING_OPENER.exec(body);
    if (!opener?.[1] || !OUTLINE_HEADING_CLASS.test(opener[2] ?? '')) {
      pos += 2;
      continue;
    }
    const contentStart = pos + opener[0].length;
    if (close < contentStart) {
      close = body.indexOf('</h', contentStart);
      if (close === -1) break; // nothing after this point closes a heading
    }
    // A heading whose span holds another heading tag never closed; that one takes the closer.
    HEADING_TAG.lastIndex = contentStart;
    const nextOpener = HEADING_TAG.exec(body)?.index ?? -1;
    if (
      close - contentStart <= HEADING_SOURCE_MAX &&
      (nextOpener === -1 || nextOpener > close) &&
      body.startsWith(`</h${opener[1]}>`, close)
    ) {
      entries.push({
        level: Number(opener[1]) - 1,
        title: headingTitle(body.slice(contentStart, close)),
        start: pos,
      });
    }
    if (nextOpener === -1) break;
    pos = nextOpener;
  }

  const omittedLevels: number[] = [];
  const shallowest = Math.min(...entries.map((entry) => entry.level));
  while (entries.length > OUTLINE_MAX_ENTRIES) {
    const deepest = entries.reduce((max, entry) => Math.max(max, entry.level), 0);
    const firstLeftOut = entries[OUTLINE_MAX_ENTRIES];
    if (deepest === shallowest && firstLeftOut) {
      return {
        entries: entries.slice(0, OUTLINE_MAX_ENTRIES),
        omittedLevels,
        continuesAt: firstLeftOut.start,
      };
    }
    omittedLevels.push(deepest);
    entries = entries.filter((entry) => entry.level < deepest);
  }
  return { entries, omittedLevels };
}

function stripVersion(id: string): string {
  return id.replace(/v\d+$/, '');
}

/**
 * Version an arXiv ID pins explicitly, or `undefined` when it is unversioned.
 * `2401.12345` → undefined, `2401.12345v7` → 7.
 */
function parseVersion(id: string): number | undefined {
  const match = /v(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether `id` is an old-style ID (`archive/YYMMNNN`) pinned to a version. IDs
 * reach the service in canonical form, where only an old-style ID has a slash.
 */
function isPinnedOldStyleId(id: string): boolean {
  return id.includes('/') && parseVersion(id) !== undefined;
}

/** Whether `err` is arXiv's API answering HTTP 500 (and not another 5xx). */
function isHttp500(err: unknown): boolean {
  return err instanceof McpError && err.data?.status === 500;
}

/**
 * Explain a pinned old-style version arXiv's API would not serve: the lookup
 * holding it answered HTTP 500, and the unversioned request sent in its place
 * returned `latest`. When other superseded versions shared that lookup, any of
 * them may be the one arXiv fails on, so each is told to go alone. See issue #53.
 */
function describeUnservedVersion(
  id: string,
  latest: number,
  sharedLookup: boolean,
): PaperLookupMiss {
  return {
    id,
    reason: 'version_not_served',
    detail: [
      `arXiv's API answered HTTP 500 for the lookup holding this version, so its metadata could not be returned; the latest version is v${latest}.`,
      `Request '${stripVersion(id)}v${latest}', or the ID without a version suffix, for the latest; this version's PDF is at https://arxiv.org/pdf/${id}.`,
      sharedLookup &&
        `Other superseded versions shared that lookup, and arXiv serves some of them on their own. Request '${id}' alone to try it again.`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * Match each requested arXiv ID to a candidate record, slot-aligned with `ids`
 * (`undefined` where nothing satisfies the request).
 *
 * An ID that pins a version resolves only to the candidate carrying that exact
 * version, so two versions of one paper in the same batch stay distinct
 * (issue #28) and a stored row holding a different version reads as a miss
 * rather than a silent substitution (issue #25). An unversioned ID resolves to
 * the highest-versioned candidate sharing its base ID — arXiv's latest-version
 * semantics, and the only version the mirror stores.
 */
function resolveRequestedIds<T>(
  ids: readonly string[],
  candidates: readonly T[],
  idOf: (candidate: T) => string,
): (T | undefined)[] {
  const byVersionedId = new Map<string, T>();
  const latestByBaseId = new Map<string, { candidate: T; version: number }>();
  for (const candidate of candidates) {
    const id = idOf(candidate);
    byVersionedId.set(id, candidate);
    const base = stripVersion(id);
    const version = parseVersion(id) ?? 0;
    const latest = latestByBaseId.get(base);
    if (!latest || version >= latest.version) latestByBaseId.set(base, { candidate, version });
  }
  return ids.map((id) =>
    parseVersion(id) === undefined ? latestByBaseId.get(id)?.candidate : byVersionedId.get(id),
  );
}

function extractPaperId(idUrl: string): string {
  return idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
}

/**
 * Convert a mirror `PaperRow` to the canonical `PaperMetadata` shape. The
 * mirror stores the latest version only — the returned `id` reflects that.
 * Authors are best-effort split on commas; arXivRaw stores authors as a free
 * text block, so split fidelity varies by submission style.
 */
function rowToMetadata(row: PaperRow): PaperMetadata {
  const versionedId = row.version ? `${row.id}v${row.version}` : row.id;
  const authors = row.authors
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const categories = row.categories.split(/\s+/).filter(Boolean);
  return {
    id: versionedId,
    title: row.title,
    authors,
    abstract: row.abstract,
    primary_category: row.primary_category,
    categories,
    published: row.published,
    updated: row.updated,
    ...(row.comment && { comment: row.comment }),
    ...(row.journal_ref && { journal_ref: row.journal_ref }),
    ...(row.doi && { doi: row.doi }),
    pdf_url: `https://arxiv.org/pdf/${versionedId}`,
    // Every ID-derived field carries the version the record reports, matching
    // what the live Atom `<link>` elements return. A bare abstract URL renders
    // whichever revision is current, contradicting the `id` beside it. See #34.
    abstract_url: `https://arxiv.org/abs/${versionedId}`,
  };
}

/**
 * Explain why a requested ID the mirror could not serve, and the live API was
 * never asked for, produced no metadata. When the mirror holds the paper at a
 * different version, the ID is unreachable in this configuration rather than
 * absent from arXiv — say which, and name the version that can be served. See
 * issue #35.
 */
function describeLookupMiss(id: string, rows: readonly PaperRow[]): PaperLookupMiss {
  if (parseVersion(id) !== undefined) {
    const stored = rows.find((row) => row.id === stripVersion(id));
    if (stored) {
      return {
        id,
        reason: 'version_not_in_mirror',
        detail: `The local mirror holds version ${stored.version} only and live arXiv fallback is disabled. Request '${stored.id}v${stored.version}' instead, or omit the version suffix for the latest.`,
      };
    }
  }
  return { id, reason: 'not_in_arxiv' };
}

/**
 * Whether a failed live patch-up is an outage a later call can get past: arXiv
 * unavailable (a 5xx after its retry, a network error), timed out, or
 * throttled. A lookup arXiv rejected outright would fail the same way again.
 */
function isLiveOutage(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    (err.code === JsonRpcErrorCode.ServiceUnavailable ||
      err.code === JsonRpcErrorCode.Timeout ||
      err.code === JsonRpcErrorCode.RateLimited)
  );
}

/**
 * Explain an ID the mirror could not serve whose live lookup failed: name the
 * failure, say a later call may serve it, and name the version the mirror
 * holds when it holds the paper at another one. See issue #67.
 */
function describeLiveLookupFailure(
  id: string,
  rows: readonly PaperRow[],
  err: McpError,
): PaperLookupMiss {
  const stored =
    parseVersion(id) === undefined ? undefined : rows.find((row) => row.id === stripVersion(id));
  return {
    id,
    reason: 'live_lookup_failed',
    detail: [
      `The local mirror cannot serve this ID, and the live arXiv lookup for it failed: ${err.message}.`,
      'The same call made again may serve it.',
      stored &&
        `The mirror holds version ${stored.version}: request '${stored.id}v${stored.version}' to read that one now.`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * Log a mirror file a reader open cannot serve, and report an older schema no
 * writer is migrating to `onSchemaOutdated`, the hook that starts the writer
 * that migrates it. Shared by the request thread's open and the reader
 * worker's own.
 */
function reportMirrorNotReady(
  ctx: Context,
  reader: MirrorNotReady,
  onSchemaOutdated: (() => void) | undefined,
): void {
  ctx.log.debug('Mirror not ready; using live API', {
    reason: reader.status,
    ...((reader.status === 'older_schema' || reader.status === 'migrating') && {
      schemaVersion: reader.version,
    }),
  });
  if (reader.status === 'older_schema') onSchemaOutdated?.();
}

/**
 * Log a mirror open that threw; the call goes live. Shared by the request
 * thread's open and the reader worker's own, so neither puts the store's
 * error in front of the caller.
 */
function reportMirrorOpenFailed(ctx: Context, err: unknown): void {
  ctx.log.warning('Mirror open failed; using live API', {
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Open the mirror store lazily and verify it has usable data. Returns the store
 * and its path when the mirror is enabled and a full harvest has ever
 * completed; otherwise returns undefined so the caller falls through to the
 * live API.
 *
 * The open is query-only and never writes (issue #55). A file it cannot serve —
 * missing, with no recorded schema, or on an older schema version — is not
 * ready: logged at debug, opened afresh on the next call, and never created or
 * migrated here. An older schema with no writer migrating it is reported to
 * `onSchemaOutdated`, the hook that starts the writer that migrates it; one a
 * writer is migrating already (`migrating`) is not (issue #71).
 *
 * Readiness keys off the durable `completed_at` marker, NOT the live `status`.
 * The mirror's tables stay transactionally queryable during an incremental
 * refresh, so an in-progress (or failed) refresh on top of a complete mirror
 * keeps serving the existing dataset instead of dropping every query to the
 * throttled live API. Only a never-completed cold init reports not-ready. See
 * issue #21.
 *
 * Failures opening the SQLite file (e.g. corrupt, permissions) are caught and
 * surfaced as `undefined` — the caller transparently falls back to live. The
 * upstream operator sees the failure via the next `mirror:verify` run.
 */
async function tryReadyMirror(
  ctx: Context,
  onSchemaOutdated: (() => void) | undefined,
): Promise<ReadyMirror | undefined> {
  const config = getServerConfig();
  if (!config.mirrorEnabled) return;
  try {
    const opened = await openReaderStore(config.mirrorPath);
    if (opened.status !== 'open') {
      reportMirrorNotReady(ctx, opened, onSchemaOutdated);
      return;
    }
    const { store } = opened;
    const state = store.readHarvestState();
    if (state.completed_at == null) {
      ctx.log.debug('Mirror not ready (no completed harvest yet); using live API', {
        status: state.status,
      });
      return;
    }
    return { path: config.mirrorPath, store };
  } catch (err) {
    reportMirrorOpenFailed(ctx, err);
    return;
  }
}

/**
 * Compose the one arXiv-syntax query string that carries every filter dimension
 * the caller asked for: their terms, the category subtree, and the submitted-date
 * window. The live API receives it verbatim, and BOTH paths echo it back as
 * `effective_query`, so replaying the echo as `query` reproduces the same result
 * set instead of silently widening it.
 *
 * The caller's query is wrapped in parens so every appended `AND` scopes to the
 * whole expression. Without them arXiv's parser binds `AND` tighter than the
 * implicit conjunction between bare terms — "mixture of experts AND cat:cs.CL"
 * parses as "mixture ∧ of ∧ (experts AND cat:cs.CL)", leaking earlier terms
 * across all categories.
 *
 * Any `cat:` operand the caller wrote is expanded to its subtree first, so it
 * carries the meaning the mirror has always given it and the tool's `query`
 * description has always advertised (issue #36). Everything else in the query
 * reaches arXiv exactly as written.
 */
function buildSearchQuery(query: string, options: SearchOptions): string {
  const expanded = expandCategoryOperands(query);
  const clauses = [
    options.category ? categorySearchTerm(options.category) : undefined,
    submittedDateClause(options.submittedFrom, options.submittedTo),
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length === 0 ? expanded : `(${expanded}) AND ${clauses.join(' AND ')}`;
}

/**
 * Detect queries that should bypass the mirror to cover the nightly-update
 * gap — sort-by-submitted-descending with recent-window > 0.
 */
function shouldBypassForRecency(options: SearchOptions, recentDaysLive: number): boolean {
  if (recentDaysLive <= 0) return false;
  if (options.sortBy !== 'submitted') return false;
  return (options.sortOrder ?? 'descending') === 'descending';
}

// ---------------------------------------------------------------------------
// ArxivService
// ---------------------------------------------------------------------------

/** Hooks the server wires into the service at setup. */
export interface ArxivServiceOptions {
  /**
   * Where mirror searches run: the reader worker by default (issue #58).
   * `searchInThread` runs them on the request thread's own store, where a
   * test can observe the store calls.
   */
  mirrorSearcher?: MirrorSearcher;
  /**
   * Called each time a mirror read finds the file on an older schema version
   * than this build reads, with no writer migrating it — the cue to start the
   * writer that migrates it.
   */
  onMirrorSchemaOutdated?: () => void;
  /**
   * Where PDF text is extracted: a worker thread per extraction by default
   * (issue #73). `extractInThread` extracts on the request thread, so a test on
   * a fake clock is not raced by a worker replying on the real one.
   */
  pdfTextExtractor?: PdfTextExtractor;
}

export class ArxivService {
  private readonly parser: XMLParser;
  private apiQueue: Promise<void> = Promise.resolve();
  /**
   * Epoch ms until which queued API calls should pause. Set when arXiv signals
   * rate-limit (429 with `Retry-After`, or 200 OK with `Rate exceeded.` body).
   * Subsequent queued requests honor it server-side so a single throttle event
   * doesn't trigger N parallel rate-limit failures across the queue.
   */
  private cooldownUntilMs = 0;
  /**
   * Count of rate-limit events since the last successful API response. Drives
   * geometric cooldown growth so a session that keeps tripping the limit backs
   * off increasingly rather than thrashing at the 5s minimum. Reset to 0 on the
   * next successful response. See issue #9.
   */
  private consecutiveRateLimits = 0;
  private readonly mirrorSearcher: MirrorSearcher;
  private readonly pdfTextExtractor: PdfTextExtractor;

  constructor(private readonly options: ArxivServiceOptions = {}) {
    this.mirrorSearcher = options.mirrorSearcher ?? searchInWorker;
    this.pdfTextExtractor = options.pdfTextExtractor ?? extractInWorker;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      // Element text stays the upstream string: a title of "1.10" or a comment
      // of "0" is text, not a number to re-spell or drop. The mirror harvester
      // parses with the same setting. See issue #45.
      parseTagValue: false,
      isArray: (_name, jpath) =>
        typeof jpath === 'string' &&
        ['feed.entry', 'feed.entry.author', 'feed.entry.category', 'feed.entry.link'].includes(
          jpath,
        ),
    });
  }

  /** Search arXiv papers by query with optional category filter, sorting, and pagination. */
  async search(query: string, options: SearchOptions, ctx: Context): Promise<SearchResult> {
    const config = getServerConfig();

    if (options.category && !SEARCHABLE_CATEGORY_CODES.has(options.category)) {
      const suggestions = suggestCategories(options.category);
      const hint =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(', ')}?`
          : ' Use arxiv_list_categories to list valid codes.';
      throw validationError(`Unknown arXiv category '${options.category}'.${hint}`, {
        category: options.category,
        suggestions,
        reason: 'unknown_category',
      });
    }

    this.assertValidDateWindow(options);

    // Built before the path split so the mirror echoes the same string the live
    // API would have received — one definition of "what was actually searched".
    const searchQuery = buildSearchQuery(query, options);
    const translated = translateQuery(query);
    // The mirror's answer, or `undefined` when it is not ready, the query's
    // free-text term is over its match cap, or the query is one the mirror
    // cannot answer as arXiv does (#65) — such a query never falls back to it,
    // so the mirror answers only what it can answer faithfully and within its cap.
    const fromMirror = async () => {
      if (translated.route === 'live') {
        if (config.mirrorEnabled) {
          ctx.log.info('The mirror cannot answer this query as arXiv does; not using it', {
            query,
            reason: translated.reason,
          });
        }
        return;
      }
      const ready = await tryReadyMirror(ctx, this.options.onMirrorSchemaOutdated);
      return (
        ready && (await this.searchMirror(ready, translated, query, searchQuery, options, ctx))
      );
    };

    // Mirror path: enabled, harvest complete, the query isn't sort-by-recent
    // (which needs the up-to-the-minute live API to cover the nightly gap), and
    // its free-text term is narrow enough for the mirror to count and rank.
    const bypassForRecency = shouldBypassForRecency(options, config.mirrorRecentDaysLive);
    if (!bypassForRecency) {
      const mirrored = await fromMirror();
      if (mirrored) return mirrored;
    }

    // arXiv answers HTTP 500 to any request reaching past its result limit, so a
    // page is cut at the limit and a start with nothing left before it never
    // goes out. Under the recency bypass the mirror still serves such a page.
    const start = options.start ?? 0;
    if (start >= ARXIV_API_RESULT_LIMIT) {
      const mirrored = bypassForRecency ? await fromMirror() : undefined;
      if (mirrored) return mirrored;
      throw validationError(
        `start ${start} is past the matches arXiv serves: its API returns only the first ${ARXIV_API_RESULT_LIMIT} results of a query, so start must be below ${ARXIV_API_RESULT_LIMIT}.`,
        { start, resultLimit: ARXIV_API_RESULT_LIMIT, reason: 'start_beyond_result_limit' },
      );
    }

    const url = buildApiUrl(config.apiBaseUrl, {
      search_query: searchQuery,
      start: String(start),
      max_results: String(Math.min(options.maxResults ?? 10, ARXIV_API_RESULT_LIMIT - start)),
      sortBy: SORT_BY_MAP[options.sortBy ?? 'relevance'] ?? 'relevance',
      sortOrder: options.sortOrder ?? 'descending',
    });

    try {
      return await withRetry(
        async () => {
          const xml = await this.fetchApi(url, ctx);
          const feed = this.parseAtomFeed(xml);
          return {
            total_results: feed.totalResults,
            start: feed.startIndex,
            papers: feed.entries,
            effective_query: searchQuery,
            result_limit: ARXIV_API_RESULT_LIMIT,
          };
        },
        {
          operation: 'arxivSearch',
          context: ctx as unknown as RequestContext,
          signal: ctx.signal,
          isTransient: isArxivTransient,
          maxRetries: 1,
        },
      );
    } catch (err) {
      // A cancelled call is over: answering it from the mirror would turn the
      // caller's cancellation into a success nobody is waiting for.
      if (!bypassForRecency || ctx.signal.aborted) throw err;
      // The mirror stands in for a live call that already failed, so a mirror
      // that throws leaves that failure standing, unless the caller cancelled
      // meanwhile. See issue #76.
      const mirrored = await fromMirror().catch((mirrorErr: unknown) => {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        ctx.log.warning('Mirror fallback failed on recency bypass; returning the live failure', {
          error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
        });
        throw err;
      });
      // A mirror that matches nothing says nothing about the newest papers the
      // bypass went live for: the live failure stands rather than reading as
      // a query with no matches. See issue #68.
      if (!mirrored || mirrored.total_results === 0) throw err;
      ctx.log.warning('Live API failed on recency bypass; answered from mirror', {
        error: err instanceof Error ? err.message : String(err),
      });
      return mirrored;
    }
  }

  /**
   * Reject a submitted-date window the caller could not have meant: a bound that
   * is not a real UTC calendar date, or a range that starts after it ends. Both
   * would otherwise reach arXiv as a syntactically valid clause that silently
   * matches nothing.
   */
  private assertValidDateWindow(options: SearchOptions): void {
    const bounds = [
      ['submitted_from', options.submittedFrom],
      ['submitted_to', options.submittedTo],
    ] as const;
    for (const [field, value] of bounds) {
      if (value !== undefined && !isCalendarDate(value)) {
        throw validationError(
          `${field} '${value}' is not a real UTC calendar date. Use YYYY-MM-DD (e.g. '2024-01-31').`,
          {
            [field]: value,
            reason: 'invalid_date_range',
          },
        );
      }
    }
    if (
      options.submittedFrom !== undefined &&
      options.submittedTo !== undefined &&
      options.submittedFrom > options.submittedTo
    ) {
      throw validationError(
        `submitted_from '${options.submittedFrom}' is after submitted_to '${options.submittedTo}'. Both bounds are inclusive, so the window must start on or before it ends.`,
        {
          submitted_from: options.submittedFrom,
          submitted_to: options.submittedTo,
          reason: 'invalid_date_range',
        },
      );
    }
  }

  /**
   * Search the local OAI-PMH mirror via FTS5 with the query's translation, and
   * merge any tool-level `options.category` / submitted-date window into the
   * structured filter set.
   *
   * The query's own category groups and `options.category` stay separate
   * groups rather than one merged set: the live path AND-s the two
   * (`(… cat:X …) AND cat:Y`), so folding them into a single OR-ed set would
   * make the same pair of inputs widen the result set here while narrowing it
   * there.
   *
   * `effectiveQuery` is the string {@link buildSearchQuery} produced for this
   * call — echoed back unchanged so the mirror reports the same applied filters
   * the live path would. The mirror's own translator understands every operand
   * that string can contain (`cat:` subtree wildcards, `submittedDate:[…]`), so
   * replaying the echo through `query` selects the same rows.
   *
   * Returns `undefined`, without searching, when the query's free-text term
   * matches at least {@link MIRROR_SEARCH_MATCH_CAP} papers — the caller answers
   * it from the live API instead, whose total is arXiv's own exact count. Only a
   * free-text term is probed; a category- or date-only search keeps its
   * index-backed mirror path (#19, #49). `undefined` too when the reader
   * worker's own open finds the file not ready or throws, each reported as the
   * request thread's open reports it, and when SQLite raises during the probe
   * or the search, logged as a warning (#76).
   *
   * The probe and the search run through the service's `MirrorSearcher`: in the
   * reader worker unless the service was built with another (issue #58).
   */
  private async searchMirror(
    mirror: ReadyMirror,
    translated: MirrorQuery,
    query: string,
    effectiveQuery: string,
    options: SearchOptions,
    ctx: Context,
  ): Promise<SearchResult | undefined> {
    const categoryGroups = [
      ...translated.categoryGroups,
      options.category ? categorySubtree(options.category) : [],
    ].filter((group) => group.length > 0);
    const published = intersectBounds(
      translated.published,
      submittedDateBounds(options.submittedFrom, options.submittedTo),
    );
    const limit = options.maxResults ?? 10;
    const offset = options.start ?? 0;
    const sortBy = options.sortBy ?? 'relevance';
    const ftsSortBy: 'relevance' | 'published' | 'updated' =
      sortBy === 'submitted' ? 'published' : sortBy === 'updated' ? 'updated' : 'relevance';

    let outcome: MirrorSearchOutcome;
    try {
      outcome = await this.mirrorSearcher(
        mirror,
        {
          ...(translated.matchExpr !== undefined && { matchExpr: translated.matchExpr }),
          categoryGroups,
          ...(published.from !== undefined && { publishedFrom: published.from }),
          ...(published.to !== undefined && { publishedTo: published.to }),
          limit,
          offset,
          sortBy: ftsSortBy,
          sortOrder: options.sortOrder ?? 'descending',
        },
        ctx.signal,
      );
    } catch (err) {
      // Defense in depth: the translator should produce parseable FTS5 for every
      // input the lexer accepts, but a regression there would surface here as a
      // raw `SQLiteError: fts5: …`. Convert to validationError so callers get
      // an actionable hint instead of a SQLite engine string. See issue #13.
      if (err instanceof Error && /^fts5:/.test(err.message)) {
        throw validationError(
          `Mirror search could not parse the translated FTS5 expression: ${err.message}`,
          {
            query,
            matchExpr: translated.matchExpr,
            reason: 'unsupported_query_syntax',
          },
        );
      }
      // Any other error SQLite raised mid-read (a corrupt page, an I/O error) is
      // handled as a failed open: logged, and the call goes live, so the engine's
      // text never reaches the caller. A cancellation, a reader that stopped
      // (`ServiceUnavailable`), and this code's own errors still throw. See #76.
      if (isDriverError(err)) {
        ctx.log.warning('Mirror search failed; using live API', { error: err.message });
        return;
      }
      throw err;
    }
    if (outcome.status === 'over_cap') {
      ctx.log.info('Mirror search term reaches the match cap; using live API', {
        query,
        matchExpr: translated.matchExpr,
        cap: MIRROR_SEARCH_MATCH_CAP,
      });
      return;
    }
    if (outcome.status === 'not_ready') {
      reportMirrorNotReady(ctx, outcome.reader, this.options.onMirrorSchemaOutdated);
      return;
    }
    if (outcome.status === 'open_failed') {
      reportMirrorOpenFailed(ctx, outcome.error);
      return;
    }
    const { papers, total } = outcome;
    ctx.log.info('Mirror search', {
      query,
      total,
      returned: papers.length,
      matchExpr: translated.matchExpr,
      categoryGroups,
      publishedFrom: published.from,
      publishedTo: published.to,
    });
    return {
      total_results: total,
      start: offset,
      papers: papers.map(rowToMetadata),
      effective_query: effectiveQuery,
    };
  }

  /** Get full metadata for one or more papers by arXiv ID. */
  async getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult> {
    const ready = await tryReadyMirror(ctx, this.options.onMirrorSchemaOutdated);
    if (!ready) return this.fetchLivePapers(ids, ctx);

    const config = getServerConfig();
    // The mirror is keyed by base ID and stores the latest version only, so the
    // lookup is by base ID but the match is version-aware: a row satisfies a
    // slot only when it carries the version that slot asked for. An explicit
    // older version is a miss, patched from the live API below. See issue #25.
    let rows: PaperRow[];
    try {
      rows = ready.store.getPapersByIds(ids.map(stripVersion));
    } catch (err) {
      // SQLite raising mid-read is a failed open (#76): the whole lookup goes
      // live, whatever `mirrorFallbackLive` says — it gates misses, not a
      // mirror that cannot answer.
      if (!isDriverError(err)) throw err;
      ctx.log.warning('Mirror lookup failed; using live API', { error: err.message });
      return this.fetchLivePapers(ids, ctx);
    }
    const slots = resolveRequestedIds(ids, rows.map(rowToMetadata), (p) => p.id);

    const missingIndices = slots.flatMap((p, i) => (p === undefined ? [i] : []));
    // A live miss keeps the reason the live lookup gave it: the mirror's view
    // of an ID it could not serve says nothing about why arXiv did not.
    let liveMisses = new Map<string, PaperLookupMiss>();
    if (missingIndices.length > 0 && config.mirrorFallbackLive) {
      const missing = missingIndices.map((i) => ids[i] ?? '');
      ctx.log.info('Mirror miss; falling back to live', { missing });
      let live: PaperLookupResult;
      try {
        live = await this.fetchLivePapers(missing, ctx);
      } catch (err) {
        // An outage on the live patch-up leaves the mirror's answers standing
        // and names the IDs it left unanswered. A cancelled call, a lookup arXiv
        // rejected, and a call the mirror answered none of still fail. See #67.
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (!isLiveOutage(err) || missing.length === ids.length) throw err;
        ctx.log.warning('Live fallback failed; returning the papers the mirror served', {
          missing,
          error: err.message,
        });
        live = {
          papers: [],
          not_found: missing.map((id) => describeLiveLookupFailure(id, rows, err)),
        };
      }
      const resolved = resolveRequestedIds(missing, live.papers, (p) => p.id);
      for (const [k, slotIndex] of missingIndices.entries()) {
        slots[slotIndex] = resolved[k];
      }
      liveMisses = new Map(live.not_found?.map((miss) => [miss.id, miss] as const));
    }

    const papers = slots.filter((p): p is PaperMetadata => p !== undefined);
    const notFound = ids.flatMap((id, i) =>
      slots[i] === undefined ? [liveMisses.get(id) ?? describeLookupMiss(id, rows)] : [],
    );
    return {
      papers,
      ...(notFound.length > 0 ? { not_found: notFound } : {}),
    };
  }

  /**
   * Live-API path for `getPapers`. Extracted so the mirror fallback can reuse it.
   *
   * arXiv's API answers HTTP 500, every time, for an `id_list` holding some
   * superseded versions of old-style IDs (`hep-th/9901001v1`), while others
   * answer normally (`astro-ph/0703001v1`) and nothing public tells the two
   * apart. So when the first request of a lookup holding an old-style pin
   * answers 500, one request with those IDs unversioned takes the place of the
   * identical retry, and each pin resolves against the latest version it
   * returns. Every other failure keeps the one identical retry, so a lookup
   * sends at most two requests. See issue #53.
   *
   * A read passes its `deadline`, which the requests and the wait between them
   * draw on.
   */
  private async fetchLivePapers(
    ids: string[],
    ctx: Context,
    deadline?: ReadDeadline,
  ): Promise<PaperLookupResult> {
    const holdsOldStylePin = ids.some(isPinnedOldStyleId);
    let attempts = 0;
    const replacesRetry = (err: unknown) => holdsOldStylePin && attempts === 1 && isHttp500(err);

    let entries: PaperMetadata[];
    let unversioned = false;
    try {
      entries = await withRetry(
        () => {
          attempts += 1;
          return this.requestIdList(ids, ctx, deadline);
        },
        {
          operation: 'arxivGetPapers',
          context: ctx as unknown as RequestContext,
          signal: callSignal(ctx, deadline),
          isTransient: (err) => !replacesRetry(err) && isArxivTransient(err),
          maxRetries: 1,
        },
      );
    } catch (err) {
      if (!replacesRetry(err)) throw err;
      // A cancelled call is over: the request would only wait out the queue
      // for its turn to be refused.
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const latestIds = [
        ...new Set(ids.map((id) => (isPinnedOldStyleId(id) ? stripVersion(id) : id))),
      ];
      ctx.log.info('arXiv answered HTTP 500 for a lookup holding old-style pinned versions', {
        ids,
        unversioned: latestIds,
      });
      entries = await this.requestIdList(latestIds, ctx, deadline);
      unversioned = true;
    }

    // Re-index by input order — arXiv returns entries in its own internal order
    // (typically submission-date desc), so a caller stitching results back to an
    // ordered reference list would otherwise silently misalign. See issue #5.
    // The match is version-aware: arXiv honors a `vN` suffix in `id_list` and
    // returns one entry per requested version, so a batch asking for two
    // versions of one paper must keep them in their own slots. See issue #28.
    const resolved = resolveRequestedIds(ids, entries, (p) => p.id);
    const ordered = resolved.filter((p): p is PaperMetadata => p !== undefined);

    // After the unversioned request, an old-style pin it did not match is past
    // the latest version (absent from arXiv) or below it (not served).
    const latestVersion = new Map<string, number>();
    if (unversioned) {
      for (const p of entries) latestVersion.set(stripVersion(p.id), parseVersion(p.id) ?? 0);
    }
    const supersededBy = (id: string): number | undefined => {
      const latest = latestVersion.get(stripVersion(id));
      return isPinnedOldStyleId(id) && latest !== undefined && (parseVersion(id) ?? 0) < latest
        ? latest
        : undefined;
    };
    const unserved = new Set(
      ids.filter((id, i) => resolved[i] === undefined && supersededBy(id) !== undefined),
    );
    const notFound = ids.flatMap<PaperLookupMiss>((id, i) => {
      if (resolved[i] !== undefined) return [];
      const latest = supersededBy(id);
      return [
        latest === undefined
          ? { id, reason: 'not_in_arxiv' }
          : describeUnservedVersion(id, latest, unserved.size > 1),
      ];
    });

    return {
      papers: ordered,
      ...(notFound.length > 0 ? { not_found: notFound } : {}),
    };
  }

  /** One `id_list` request: the entries arXiv returned, in its own order. */
  private async requestIdList(
    ids: readonly string[],
    ctx: Context,
    deadline?: ReadDeadline,
  ): Promise<PaperMetadata[]> {
    const url = buildApiUrl(getServerConfig().apiBaseUrl, {
      id_list: ids.join(','),
      max_results: String(ids.length),
    });
    return this.parseAtomFeed(await this.fetchApi(url, ctx, deadline)).entries;
  }

  /**
   * Fetch paper metadata plus the full paper body. Tries native arXiv HTML,
   * then ar5iv, then text extracted from the PDF. The whole read runs on one
   * deadline (`ReadDeadline`).
   */
  async readContent(
    paperId: string,
    options: ReadContentOptions,
    ctx: Context,
  ): Promise<PaperContent> {
    const deadline = startReadDeadline(paperId, getServerConfig().readTimeoutMs);
    const { paper, fromMirror } = await this.readMetadata(paperId, ctx, deadline);

    // Body fetch with its own retry (2s base delay for heavier pages).
    // Same fail-fast-on-rate-limit policy as API calls — see isArxivTransient.
    // The replay and the backoff before it draw on the deadline's time left; a
    // backoff the deadline cuts short ends with the deadline's own reason.
    const { content, source, url } = await withRetry(() => this.fetchBody(paper, ctx, deadline), {
      operation: 'arxivFetchBody',
      context: ctx as unknown as RequestContext,
      signal: callSignal(ctx, deadline),
      isTransient: isArxivTransient,
      maxRetries: 1,
      baseDelayMs: 2000,
    }).catch((err: unknown) => {
      throw err === deadline.signal.reason
        ? deadline.exceeded('it was waiting to retry its content requests')
        : err;
    });

    // HTML sources: cut to the article (dropping <head>, site chrome, and the
    // site footer), strip LaTeXML class/id noise so max_characters buys real
    // body content, not `ltx_text` wrappers, then make relative links absolute.
    // PDF-extracted text carries none of these, so it passes through untouched
    // and total_characters equals body_characters.
    const isHtmlSource = source !== 'pdf_text';
    const bodyContent = isHtmlSource ? stripHtmlHead(content) : content;
    const totalCharacters = bodyContent.length;
    const cleaned = isHtmlSource
      ? resolveRelativeUrls(stripLatexmlNoise(bodyContent), url)
      : bodyContent;
    const bodyCharacters = cleaned.length;

    const start = options.start ?? 0;
    const sliceEnd = options.maxCharacters != null ? start + options.maxCharacters : bodyCharacters;
    const sliced = cleaned.slice(start, sliceEnd);
    // `truncated` means "more body content exists past this slice." If start
    // is past bodyCharacters, sliced is empty and truncated is false — the
    // caller paged off the end.
    const truncated = start + sliced.length < bodyCharacters;
    // The outline rides the first page only: a caller jumping to a known start
    // already holds it. PDF text carries no reliable headings, so it gets none.
    const outline =
      start !== 0
        ? undefined
        : isHtmlSource
          ? buildOutline(cleaned)
          : { entries: [], omittedLevels: [] };
    // ar5iv keeps one render per paper and serves it for any version, and its
    // page names no revision. Its body is the requested revision for certain
    // only when the paper has one: an unversioned read whose live lookup found
    // v1 the latest. A mirror row's v1 can trail a revision published since its
    // last refresh. See issues #63, #79.
    const revisionUnconfirmed =
      source === 'ar5iv' &&
      !(!fromMirror && parseVersion(paperId) === undefined && parseVersion(paper.id) === 1);

    return {
      paper_id: paper.id,
      title: paper.title,
      content: sliced,
      source,
      truncated,
      start,
      total_characters: totalCharacters,
      body_characters: bodyCharacters,
      pdf_url: paper.pdf_url,
      abstract_url: paper.abstract_url,
      ...(outline ? { outline: outline.entries } : {}),
      ...(outline && outline.omittedLevels.length > 0
        ? { outline_omitted_levels: outline.omittedLevels }
        : {}),
      ...(outline?.continuesAt !== undefined ? { outline_continues_at: outline.continuesAt } : {}),
      ...(revisionUnconfirmed ? { revision_unconfirmed: true } : {}),
    };
  }

  /**
   * The metadata a read fetches its body for, and whether the mirror supplied
   * it. The live API answers first, for per-version fidelity: the mirror stores
   * the latest version only, as of its last refresh.
   *
   * An unversioned read with the mirror enabled waits on that lookup for at most
   * `ARXIV_API_TIMEOUT_MS` from the read's start, its wait for the API queue
   * included: the bound a lookup at the head of the queue already has. A lookup
   * still pending then, for a paper the mirror holds, is withdrawn (dropped from
   * the queue, or its open request aborted) and the stored row answers, so reads
   * queued behind a hung arXiv do not spend their deadline in the queue. A mirror
   * that lacks the paper leaves the read waiting. See issue #79.
   *
   * A lookup that fails is answered from a mirror holding the paper: an
   * unversioned read takes the stored version, and a pin the stored version does
   * not match fails `version_unavailable` (#33). A paper the mirror lacks keeps
   * the live error (#68). A cancelled read fails as cancelled and never reads the
   * mirror.
   */
  private async readMetadata(
    paperId: string,
    ctx: Context,
    deadline: ReadDeadline,
  ): Promise<{ fromMirror: boolean; paper: PaperMetadata }> {
    const config = getServerConfig();
    const withdraw = new AbortController();
    const lookup = this.fetchLivePapers([paperId], ctx, {
      exceeded: deadline.exceeded,
      signal: AbortSignal.any([deadline.signal, withdraw.signal]),
    });
    // The cap and the failure fallback share one mirror read.
    let stored: Promise<PaperRow | undefined> | undefined;
    const readStored = () => {
      stored ??= this.readMirrorRow(paperId, ctx);
      return stored;
    };

    if (parseVersion(paperId) === undefined && config.mirrorEnabled) {
      let cap: ReturnType<typeof setTimeout> | undefined;
      const capReached = await Promise.race([
        lookup.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          cap = setTimeout(() => resolve(true), config.apiTimeoutMs);
        }),
      ]);
      clearTimeout(cap);
      if (capReached && !ctx.signal.aborted && !deadline.signal.aborted) {
        const row = await readStored();
        if (row) {
          withdraw.abort();
          ctx.log.info(
            'Live API lookup still pending; answering readContent metadata from mirror',
            {
              paperId,
              apiTimeoutMs: config.apiTimeoutMs,
            },
          );
          return { paper: rowToMetadata(row), fromMirror: true };
        }
      }
    }

    let result: PaperLookupResult;
    try {
      result = await lookup;
    } catch (err) {
      // A cancelled call is over: answering it from the mirror, or naming the
      // version the mirror holds, would report something nobody is waiting for.
      if (ctx.signal.aborted) throw ctx.signal.reason;
      // Out of time: whatever the mirror holds, none is left to fetch its body.
      // A wait for the API queue or a retry ends with the deadline's own reason.
      if (deadline.signal.aborted) {
        throw err === deadline.signal.reason
          ? deadline.exceeded('its arXiv API lookup had not finished')
          : err;
      }
      const row = await readStored();
      // A paper the mirror does not hold says nothing about arXiv: the live
      // failure stands, as it does with no mirror, rather than reading as an
      // ID that does not exist. So does a mirror read that failed. See #68, #76.
      if (!row) throw err;
      ctx.log.warning('Live API failed for readContent metadata; falling back to mirror', {
        paperId,
        error: err instanceof Error ? err.message : String(err),
      });
      const [match] = resolveRequestedIds([paperId], [rowToMetadata(row)], (p) => p.id);
      // A version-pinned read must not degrade to whichever version the mirror
      // happens to hold — the substituted ID would flow into the HTML fetch
      // and return a different revision's body. Unversioned reads keep
      // degrading to the latest stored version. See issue #33.
      if (!match) {
        throw serviceUnavailable(
          `arXiv is unavailable and version ${parseVersion(paperId)} of '${row.id}' cannot be served locally — the mirror holds version ${row.version} only.`,
          {
            paperId,
            mirrorVersion: row.version,
            reason: 'version_unavailable',
            retryable: true,
          },
          { cause: err },
        );
      }
      return { paper: match, fromMirror: true };
    }

    const [paper] = result.papers;
    if (paper) return { paper, fromMirror: false };
    // The version exists upstream, so `no_match` would have the caller doubt
    // a valid ID. Name the version that can be read instead. See issue #53.
    const liveMiss = result.not_found?.[0];
    if (liveMiss?.reason === 'version_not_served') {
      throw notFound(
        [`Paper '${paperId}' could not be served.`, liveMiss.detail].filter(Boolean).join(' '),
        { paperId, pdfUrl: `https://arxiv.org/pdf/${paperId}`, reason: 'version_not_served' },
      );
    }
    throw notFound(
      `Paper '${paperId}' not found. Verify the ID format (e.g., '2401.12345' or '2401.12345v2').`,
      { paperId, reason: 'no_match' },
    );
  }

  /**
   * The ready mirror's row for `paperId`, or `undefined` when there is none. A
   * read the SQLite driver fails (a corrupt page, an I/O error) is logged and
   * counts as a miss, so the read keeps its live lookup's outcome and the store's
   * error never reaches the caller. See issue #76.
   */
  private async readMirrorRow(paperId: string, ctx: Context): Promise<PaperRow | undefined> {
    const ready = await tryReadyMirror(ctx, this.options.onMirrorSchemaOutdated);
    if (!ready) return;
    try {
      return ready.store.getPapersByIds([stripVersion(paperId)])[0];
    } catch (err) {
      if (!isDriverError(err)) throw err;
      ctx.log.warning('Mirror read failed for readContent metadata; using the live lookup', {
        paperId,
        error: err.message,
      });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Private — API fetching with rate limiting
  // -------------------------------------------------------------------------

  private fetchApi(url: string, ctx: Context, deadline?: ReadDeadline): Promise<string> {
    return this.enqueueApiCall(callSignal(ctx, deadline), async () => {
      const config = getServerConfig();
      const site = { label: 'arXiv API', timeoutMs: config.apiTimeoutMs, data: { url } };

      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          signal: requestSignal(ctx, config.apiTimeoutMs, deadline),
          headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml, application/xml' },
        });
        // The request's timeout covers the body, which can stall after the headers.
        text = await response.text();
      } catch (err) {
        throw requestFailure(err, ctx, site, deadline);
      }
      const contentType = response.headers.get('content-type') ?? '';

      // Status classification runs first so a non-XML error page — a proxy's
      // 502 HTML, an edge 429 served as plain text — is classified by what the
      // status says it is instead of falling into the content-type branch below
      // and being surfaced as a non-retryable serialization failure. See #30.
      if (!response.ok) {
        // 5xx: arXiv treats 500/501 like service degradation, so we map all 5xx
        // to ServiceUnavailable for retry consistency (httpStatusToErrorCode
        // splits 500/501 → InternalError vs 502+ → ServiceUnavailable).
        // 429: RateLimited.
        // Other 4xx: InvalidRequest — permanent client error, no retry.
        if (response.status >= 500 && response.status < 600) {
          throw serviceUnavailable(`arXiv API returned HTTP ${response.status}`, {
            url,
            status: response.status,
            body: text.slice(0, 500),
          });
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const parsedMs = retryAfter !== null ? parseRetryAfter(retryAfter) : null;
          const cooldownAppliedMs = this.recordRateLimit(parsedMs ?? undefined);
          throw rateLimited(this.rateLimitMessage(cooldownAppliedMs), {
            url,
            status: response.status,
            body: text.slice(0, 500),
            ...(retryAfter !== null && { retryAfter }),
            cooldownAppliedMs,
            consecutiveRateLimits: this.consecutiveRateLimits,
            reason: 'rate_limited',
            retryable: true,
          });
        }
        throw invalidRequest(`arXiv API returned HTTP ${response.status}`, {
          url,
          status: response.status,
          body: text.slice(0, 500),
          reason: 'invalid_request',
        });
      }

      // An empty body is a transport-level symptom — dropped connection, edge
      // throttle, truncated read — not a payload we failed to deserialize.
      // Classify as transient so withRetry gets one more attempt, and name the
      // condition instead of reporting a content-type that isn't there. Checked
      // ahead of the content-type branch because an empty XML-typed body is the
      // same failure. See issue #30.
      if (text.trim() === '') {
        throw serviceUnavailable('arXiv API returned an empty response', {
          url,
          status: response.status,
          contentType,
        });
      }

      // arXiv quirk: 200 OK with plain text "Rate exceeded." instead of XML.
      if (
        !contentType.includes('application/xml') &&
        !contentType.includes('text/xml') &&
        !contentType.includes('application/atom+xml')
      ) {
        if (text.includes('Rate exceeded')) {
          const cooldownAppliedMs = this.recordRateLimit();
          throw rateLimited(this.rateLimitMessage(cooldownAppliedMs), {
            url,
            status: response.status,
            body: text.slice(0, 500),
            cooldownAppliedMs,
            consecutiveRateLimits: this.consecutiveRateLimits,
            reason: 'rate_limited',
            retryable: true,
          });
        }
        // A non-empty body under an unexpected content-type indicates an
        // upstream behavior change or proxy interference — non-transient, so
        // withRetry doesn't waste cycles on a body that won't change.
        throw serializationError(`arXiv API returned unexpected content-type: ${contentType}`, {
          url,
          contentType,
          body: text.slice(0, 500),
        });
      }

      // Successful response — clear any active backoff so the next rate-limit
      // event (if it ever recurs) starts from the 5s base again.
      this.consecutiveRateLimits = 0;
      return text;
    });
  }

  /**
   * Record a rate-limit event and compute the cooldown to apply. Grows the
   * cooldown geometrically with `consecutiveRateLimits` (5s, 10s, 20s, 30s
   * capped) so a persistently-throttled session backs off increasingly. When
   * arXiv sent a `Retry-After` header, the larger of (adaptive, header) wins
   * so we never wait less than upstream asked for.
   */
  private recordRateLimit(retryAfterMs?: number): number {
    this.consecutiveRateLimits += 1;
    const adaptive = Math.min(
      DEFAULT_RATE_LIMIT_COOLDOWN_MS * 2 ** (this.consecutiveRateLimits - 1),
      MAX_COOLDOWN_MS,
    );
    const cooldownMs = Math.min(Math.max(adaptive, retryAfterMs ?? 0), MAX_COOLDOWN_MS);
    this.applyCooldown(cooldownMs);
    return cooldownMs;
  }

  private rateLimitMessage(cooldownAppliedMs: number): string {
    return `arXiv rate limit exceeded — server applied ${cooldownAppliedMs}ms cooldown; consider reducing concurrency before next call`;
  }

  /**
   * Serializes API requests with a delay between each to respect arXiv's
   * 3-second crawl policy. A queued request whose `signal` aborts — cancelled,
   * or its read out of time — fails at once rather than at its turn, and its
   * turn is skipped: a cancelled request shouldn't consume a 3s slot. Honors any
   * server-side cooldown set by `applyCooldown` so a `Retry-After` from arXiv
   * propagates to every subsequent queued caller, not just the one that hit
   * the rate-limit.
   */
  private enqueueApiCall<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const config = getServerConfig();
    return new Promise<T>((resolve, reject) => {
      const abandon = () => reject(signal.reason);
      if (signal.aborted) abandon();
      else signal.addEventListener('abort', abandon, { once: true });
      this.apiQueue = this.apiQueue.then(async () => {
        signal.removeEventListener('abort', abandon);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const remainingCooldown = this.cooldownUntilMs - Date.now();
        if (remainingCooldown > 0) {
          try {
            await abortableSleep(remainingCooldown, signal);
          } catch (err) {
            reject(err);
            return;
          }
        }
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
        // Etiquette obligation: 3s gap after every dispatched request, even
        // on failure. Skipped only on the early-return paths above (cancelled
        // before fetch — nothing to back off from).
        await sleep(config.requestDelayMs);
      });
    });
  }

  /** Set or extend the server-side cooldown, capped at MAX_COOLDOWN_MS. */
  private applyCooldown(ms: number): void {
    const target = Date.now() + Math.min(Math.max(0, ms), MAX_COOLDOWN_MS);
    if (target > this.cooldownUntilMs) this.cooldownUntilMs = target;
  }

  // -------------------------------------------------------------------------
  // Private — body content fetching
  // -------------------------------------------------------------------------

  /**
   * Resolve a paper's body from the first upstream artifact that serves it:
   * native arXiv HTML, then ar5iv, then text extracted from the PDF.
   *
   * The two HTML rungs are not independent — both arxiv.org/html and ar5iv run
   * LaTeXML, so a submission whose LaTeX breaks one usually breaks the other and
   * they fail together. The PDF is the one artifact arXiv publishes for every
   * paper, which makes it the fallback that actually widens coverage. See #23.
   *
   * `url` is the URL that served the body — `response.url`, which follows any
   * redirect — and is the base relative links in an HTML body resolve against.
   *
   * Each rung's request timeout covers its body as well as its headers, and
   * every request carries the read's `deadline`. A rung fails the same way
   * whether its host hangs before the headers or stalls after them. See #70.
   */
  private async fetchBody(
    paper: PaperMetadata,
    ctx: Context,
    deadline: ReadDeadline,
  ): Promise<{ content: string; source: PaperContentSource; url: string }> {
    const config = getServerConfig();
    const paperId = paper.id;
    const timeoutMs = config.contentTimeoutMs;
    // The versioned ID reaches both HTML rungs as given. arxiv.org/html honors
    // the suffix (`/html/2401.12345v1` serves v1), so stripping it would serve
    // another revision (#10). ar5iv keeps one render per paper and serves it
    // whatever the suffix, so its body can be another revision than `paperId`;
    // `readContent` flags it `revision_unconfirmed` (#63).

    /**
     * Native arXiv HTML first. A 200 that holds none of the paper (no structural
     * heading, and an `\includepdf` placeholder or no text: `isPlaceholderRender`)
     * is no render, so the chain moves on as it does for a 404. See #57.
     */
    {
      const site = { label: 'arxiv.org HTML', timeoutMs, data: { paperId } };
      const signal = requestSignal(ctx, timeoutMs, deadline);
      const url = `https://arxiv.org/html/${paperId}`;
      let response: Response;
      let content: string | undefined;
      try {
        response = await fetch(url, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
        if (response.ok) content = await response.text();
      } catch (err) {
        throw requestFailure(err, ctx, site, deadline);
      }
      if (content !== undefined) {
        if (!isPlaceholderRender(content)) {
          return { content, source: 'arxiv_html', url: response.url || url };
        }
        ctx.log.debug('arxiv.org/html served a page with none of the paper; trying ar5iv', {
          paperId,
        });
      } else if (response.status >= 500) {
        throw await serverErrorFailure(response, 'arxiv.org/html', signal, ctx, site, deadline);
      }
      // A placeholder page, a 404, or another 4xx → fall through to ar5iv
    }

    /**
     * Fallback to ar5iv — don't follow redirects (307 = paper not converted).
     * A 200 is no render either when it holds none of the paper: only the
     * converter's fatal-error notice (`isConversionFailurePage`, #54; arxiv.org/html
     * answers that failure with a 404), or the placeholders and empty articles
     * `isPlaceholderRender` catches on the first rung (#57).
     *
     * A failure of this rung never ends the chain. ar5iv is a third-party
     * LaTeXML conversion service; whether it is up says nothing about whether
     * arXiv can serve the PDF, which is the artifact every paper has. The error
     * is held and re-raised only when the PDF rung also comes up empty — so a
     * caller the PDF can serve is served, and one it can't still gets ar5iv's
     * retryable error and the whole-chain replay `withRetry` gives it. See #38.
     * A body that stalls or drops is a failure of this rung like any other, and
     * is held the same way; a cancellation or the read's deadline still ends it.
     */
    let ar5ivFailure: McpError | undefined;
    {
      const site = { label: 'ar5iv', timeoutMs, data: { paperId } };
      const signal = requestSignal(ctx, timeoutMs, deadline);
      const url = `https://ar5iv.labs.arxiv.org/html/${paperId}`;
      let response: Response | undefined;
      let content: string | undefined;
      try {
        response = await fetch(url, {
          signal,
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
        if (response.ok) content = await response.text();
      } catch (err) {
        ar5ivFailure = requestFailure(err, ctx, site, deadline);
      }
      if (content !== undefined) {
        if (!isConversionFailurePage(content) && !isPlaceholderRender(content)) {
          return { content, source: 'ar5iv', url: response?.url || url };
        }
        ctx.log.debug('ar5iv served a page with none of the paper; trying the PDF', { paperId });
      } else if (response !== undefined && response.status >= 500) {
        ar5ivFailure = await serverErrorFailure(response, 'ar5iv', signal, ctx, site, deadline);
      }
      // 3xx, 4xx, or a 200 holding none of the paper → no render. On to the PDF.
    }

    // Last rung: the PDF, extracted to plain text.
    const pdfText = await this.fetchPdfText(paper, ctx, deadline);
    if (pdfText !== undefined && pdfText.trim() !== '') {
      return { content: pdfText, source: 'pdf_text', url: paper.pdf_url };
    }
    // The PDF did not cover for ar5iv, so report what ar5iv did rather than a
    // verdict about the paper's artifacts that ar5iv never answered.
    if (ar5ivFailure) throw ar5ivFailure;
    if (pdfText === undefined) {
      throw notFound(
        `No readable content for paper '${paperId}': neither arxiv.org/html nor ar5iv has an HTML render, and arXiv served no PDF at ${paper.pdf_url}.`,
        {
          paperId,
          pdfUrl: paper.pdf_url,
          reason: 'content_unavailable',
        },
      );
    }
    throw notFound(
      `Paper '${paperId}' has no HTML render, and its PDF yielded no extractable text — the file is image-only (scanned) or carries no text layer. Download it at ${paper.pdf_url}.`,
      {
        paperId,
        pdfUrl: paper.pdf_url,
        reason: 'pdf_extraction_failed',
      },
    );
  }

  /**
   * Download the paper's PDF and extract its text with the service's
   * `PdfTextExtractor` (the framework's `pdfParser`, lazy-loaded `unpdf`, in a
   * worker thread by default). Returns `undefined` when arXiv answers
   * that it has no PDF (4xx other than 429), so the caller can distinguish "no
   * artifact at all" from "PDF held no extractable text" and report the one
   * that happened. A 429 is not an absent artifact — it is the same throttle
   * `fetchApi` classifies, so it is raised as `rate_limited` rather than
   * collapsing into a `content_unavailable` that would tell the caller the
   * paper has no full text.
   *
   * The extraction holds no other request and draws on the read's deadline like
   * every request: past it, the worker is terminated and the read fails with
   * `Timeout`; a cancelled read ends it the same way. See #73.
   *
   * The extracted string is plain text: prose survives intact, while math,
   * tables, and heading structure flatten into the reading order the PDF
   * encodes.
   */
  private async fetchPdfText(
    paper: PaperMetadata,
    ctx: Context,
    deadline: ReadDeadline,
  ): Promise<string | undefined> {
    const config = getServerConfig();
    const site = {
      label: 'arXiv PDF',
      timeoutMs: config.contentTimeoutMs,
      data: { paperId: paper.id },
    };
    const signal = requestSignal(ctx, config.contentTimeoutMs, deadline);

    let response: Response;
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      response = await fetch(paper.pdf_url, {
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/pdf' },
      });
      if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw requestFailure(err, ctx, site, deadline);
    }

    if (bytes === undefined) {
      if (response.status >= 500) {
        throw await serverErrorFailure(response, 'arxiv.org/pdf', signal, ctx, site, deadline);
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const parsedMs = retryAfter !== null ? parseRetryAfter(retryAfter) : null;
        const cooldownAppliedMs = this.recordRateLimit(parsedMs ?? undefined);
        throw rateLimited(this.rateLimitMessage(cooldownAppliedMs), {
          paperId: paper.id,
          url: paper.pdf_url,
          status: response.status,
          ...(retryAfter !== null && { retryAfter }),
          cooldownAppliedMs,
          consecutiveRateLimits: this.consecutiveRateLimits,
          reason: 'rate_limited',
          retryable: true,
        });
      }
      return;
    }

    try {
      return await this.pdfTextExtractor(bytes, callSignal(ctx, deadline));
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (deadline.signal.aborted) {
        throw deadline.exceeded('its PDF text extraction had not finished');
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private — Atom XML parsing
  // -------------------------------------------------------------------------

  private parseAtomFeed(xml: string): {
    totalResults: number;
    startIndex: number;
    entries: PaperMetadata[];
  } {
    const parsed = this.parser.parse(xml);
    const feed = parsed.feed;
    if (!feed) throw serializationError('Invalid arXiv API response: missing feed element');

    return {
      totalResults: Number(feed['opensearch:totalResults'] ?? 0),
      startIndex: Number(feed['opensearch:startIndex'] ?? 0),
      entries: (feed.entry ?? []).map((entry: RawAtomEntry) => this.parseEntry(entry)),
    };
  }

  private parseEntry(entry: RawAtomEntry): PaperMetadata {
    const id = extractPaperId(String(entry.id));
    const title = String(entry.title ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const abstract = String(entry.summary ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    const authors: string[] = (entry.author ?? []).map((a) => String(a.name));
    const categories: string[] = (entry.category ?? []).map((c) => String(c['@_term']));
    const primaryCategory = String(
      entry['arxiv:primary_category']?.['@_term'] ?? categories[0] ?? '',
    );

    const links = entry.link ?? [];
    const abstractUrl =
      links.find((l) => l['@_rel'] === 'alternate')?.['@_href'] ?? `https://arxiv.org/abs/${id}`;
    const pdfUrl =
      links.find((l) => l['@_title'] === 'pdf')?.['@_href'] ?? `https://arxiv.org/pdf/${id}`;

    return {
      id,
      title,
      authors,
      abstract,
      primary_category: primaryCategory,
      categories,
      published: String(entry.published ?? ''),
      updated: String(entry.updated ?? ''),
      comment: entry['arxiv:comment'] ? String(entry['arxiv:comment']) : undefined,
      journal_ref: entry['arxiv:journal_ref'] ? String(entry['arxiv:journal_ref']) : undefined,
      doi: entry['arxiv:doi'] ? String(entry['arxiv:doi']) : undefined,
      pdf_url: pdfUrl,
      abstract_url: abstractUrl,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _service: ArxivService | undefined;

export function initArxivService(options?: ArxivServiceOptions): void {
  _service = new ArxivService(options);
}

export function getArxivService(): ArxivService {
  if (!_service)
    throw new Error('ArxivService not initialized — call initArxivService() in setup()');
  return _service;
}
