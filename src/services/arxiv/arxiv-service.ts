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
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import { getServerConfig } from '@/config/server-config.js';
import { suggestCategories, VALID_CATEGORY_CODES } from './categories.js';
import type {
  PaperContent,
  PaperLookupResult,
  PaperMetadata,
  ReadContentOptions,
  SearchOptions,
  SearchResult,
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
 * Retry predicate for arXiv calls. Excludes `RateLimited` from the framework's
 * default transient set: when arXiv signals rate-limit (HTTP 429 or a 200 OK
 * with `Rate exceeded.` body), retrying violates arXiv's documented 3-second
 * crawl etiquette and amplifies the throttle. Surface the error to the caller
 * immediately and let them honor the `Retry-After` carried on `error.data`.
 *
 * Issue: https://github.com/cyanheads/arxiv-mcp-server/issues/8
 */
function isArxivTransient(err: unknown): boolean {
  if (err instanceof McpError) {
    return (
      err.code === JsonRpcErrorCode.ServiceUnavailable || err.code === JsonRpcErrorCode.Timeout
    );
  }
  // Non-McpError (raw network errors, unexpected throws): treat as transient.
  return true;
}

/**
 * Extract a `RequestContext`-shaped object from `Context` for `withRetry`'s
 * logging correlation. Direct assignment fails under
 * `exactOptionalPropertyTypes: true` because `Context.auth` is `AuthContext |
 * undefined` (explicit) while `RequestContext.auth?` is just `AuthContext`.
 * The framework docstring confirms passing handler `Context` is safe at
 * runtime; this shim makes it satisfy TypeScript too.
 */
function ctxAsRequestContext(ctx: Context): {
  requestId: string;
  timestamp: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
} {
  return {
    requestId: ctx.requestId,
    timestamp: ctx.timestamp,
    ...(ctx.traceId !== undefined && { traceId: ctx.traceId }),
    ...(ctx.spanId !== undefined && { spanId: ctx.spanId }),
    ...(ctx.tenantId !== undefined && { tenantId: ctx.tenantId }),
  };
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
 * Strip HTML boilerplate (head, site shell, nav chrome) so truncation targets paper content.
 * Tries to find the LaTeXML article element; falls back to stripping just <head>.
 */
function stripHtmlHead(html: string): string {
  // Best: find <article> which wraps the actual paper in arXiv/ar5iv HTML
  const articleMatch = html.match(/<article\b[^>]*>/i);
  if (articleMatch) return html.slice(html.indexOf(articleMatch[0]));

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

/**
 * Class tokens that mark document structure (sections, headings, bibliography,
 * abstract, etc.). The `ltx_*` classes generally carry no information a reader
 * benefits from, but these specific tokens identify section boundaries and are
 * worth preserving so future tooling (e.g. section-scoped reads) can navigate
 * the paper without re-fetching from upstream.
 */
const LATEXML_STRUCTURAL_CLASS =
  /\bltx_(?:section|subsection|subsubsection|paragraph|subparagraph|appendix|bibliography|abstract|acknowledgements?|title|part|chapter)\b/;

/**
 * Strip LaTeXML-generated class/id noise and collapse redundant break runs.
 * LaTeXML emits `class="ltx_..."` and generated `id="..."` on nearly every element;
 * neither carries information a reader (human or LLM) benefits from. Stripping
 * them typically shrinks a math-heavy paper's HTML by 3-4x with zero content loss.
 *
 * Exception: class attributes containing a structural marker (see
 * LATEXML_STRUCTURAL_CLASS) are preserved verbatim so section boundaries remain
 * identifiable for downstream tooling.
 */
function stripLatexmlNoise(html: string): string {
  return (
    html
      .replace(/\s+class="(ltx_[^"]*)"/gi, (match, value) =>
        LATEXML_STRUCTURAL_CLASS.test(value) ? match : '',
      )
      .replace(/\s+id="[^"]*"/gi, '')
      // Collapse runs of 2+ <br> tags (LaTeXML emits these around display math)
      .replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br>\n')
  );
}

function stripVersion(id: string): string {
  return id.replace(/v\d+$/, '');
}

function extractPaperId(idUrl: string): string {
  return idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
}

// ---------------------------------------------------------------------------
// ArxivService
// ---------------------------------------------------------------------------

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

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
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

    if (options.category && !VALID_CATEGORY_CODES.has(options.category)) {
      const suggestions = suggestCategories(options.category);
      const hint =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(', ')}?`
          : ' Use arxiv_list_categories to list valid codes.';
      throw validationError(`Unknown arXiv category '${options.category}'.${hint}`, {
        category: options.category,
        suggestions,
        reason: 'unknown_category',
        ...ctx.recoveryFor('unknown_category'),
      });
    }

    // Wrap the user query in parens so `AND cat:` scopes the category to the
    // full expression. Without the parens, arXiv's parser binds `AND` tighter
    // than the implicit conjunction between bare terms — "mixture of experts
    // AND cat:cs.CL" parses as "mixture ∧ of ∧ (experts AND cat:cs.CL)",
    // leaking earlier terms across all categories.
    const searchQuery = options.category ? `(${query}) AND cat:${options.category}` : query;

    const url = buildApiUrl(config.apiBaseUrl, {
      search_query: searchQuery,
      start: String(options.start ?? 0),
      max_results: String(options.maxResults ?? 10),
      sortBy: SORT_BY_MAP[options.sortBy ?? 'relevance'] ?? 'relevance',
      sortOrder: options.sortOrder ?? 'descending',
    });

    return await withRetry(
      async () => {
        const xml = await this.fetchApi(url, ctx);
        const feed = this.parseAtomFeed(xml);
        return { total_results: feed.totalResults, start: feed.startIndex, papers: feed.entries };
      },
      {
        operation: 'arxivSearch',
        context: ctxAsRequestContext(ctx),
        signal: ctx.signal,
        isTransient: isArxivTransient,
        maxRetries: 1,
      },
    );
  }

  /** Get full metadata for one or more papers by arXiv ID. */
  async getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult> {
    const config = getServerConfig();
    const url = buildApiUrl(config.apiBaseUrl, {
      id_list: ids.join(','),
      max_results: String(ids.length),
    });

    const result = await withRetry(
      async () => {
        const xml = await this.fetchApi(url, ctx);
        return this.parseAtomFeed(xml);
      },
      {
        operation: 'arxivGetPapers',
        context: ctxAsRequestContext(ctx),
        signal: ctx.signal,
        isTransient: isArxivTransient,
        maxRetries: 1,
      },
    );

    // Cross-reference to detect not-found IDs
    const foundBaseIds = new Set(result.entries.map((p) => stripVersion(p.id)));
    const notFoundIds = ids.filter((id) => !foundBaseIds.has(stripVersion(id)));

    return {
      papers: result.entries,
      ...(notFoundIds.length > 0 ? { not_found_ids: notFoundIds } : {}),
    };
  }

  /** Fetch paper metadata + full HTML content. Tries native arXiv HTML, falls back to ar5iv. */
  async readContent(
    paperId: string,
    options: ReadContentOptions,
    ctx: Context,
  ): Promise<PaperContent> {
    // Metadata fetch has its own retry via getPapers → fetchApi
    const lookup = await this.getPapers([paperId], ctx);
    const [paper] = lookup.papers;
    if (!paper) {
      throw notFound(
        `Paper '${paperId}' not found. Verify the ID format (e.g., '2401.12345' or '2401.12345v2').`,
        { paperId, reason: 'no_match', ...ctx.recoveryFor('no_match') },
      );
    }

    // HTML fetch with its own retry (2s base delay for heavier pages).
    // Same fail-fast-on-rate-limit policy as API calls — see isArxivTransient.
    const { content, source } = await withRetry(() => this.fetchHtml(paper.id, ctx), {
      operation: 'arxivFetchHtml',
      context: ctxAsRequestContext(ctx),
      signal: ctx.signal,
      isTransient: isArxivTransient,
      maxRetries: 1,
      baseDelayMs: 2000,
    });

    // Strip <head> / site chrome, then strip LaTeXML class/id noise so
    // max_characters buys real body content, not `ltx_text` wrappers.
    const bodyContent = stripHtmlHead(content);
    const totalCharacters = bodyContent.length;
    const cleaned = stripLatexmlNoise(bodyContent);
    const bodyCharacters = cleaned.length;

    const start = options.start ?? 0;
    const sliceEnd = options.maxCharacters != null ? start + options.maxCharacters : bodyCharacters;
    const sliced = cleaned.slice(start, sliceEnd);
    // `truncated` means "more body content exists past this slice." If start
    // is past bodyCharacters, sliced is empty and truncated is false — the
    // caller paged off the end.
    const truncated = start + sliced.length < bodyCharacters;

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
    };
  }

  // -------------------------------------------------------------------------
  // Private — API fetching with rate limiting
  // -------------------------------------------------------------------------

  private fetchApi(url: string, ctx: Context): Promise<string> {
    return this.enqueueApiCall(ctx.signal, async () => {
      const config = getServerConfig();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.apiTimeoutMs)]);

      let response: Response;
      try {
        response = await fetch(url, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml, application/xml' },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw serviceUnavailable('arXiv API network error', { url }, { cause: err });
      }

      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';

      // arXiv quirk: 200 OK with plain text "Rate exceeded." instead of XML.
      if (
        !contentType.includes('application/xml') &&
        !contentType.includes('text/xml') &&
        !contentType.includes('application/atom+xml')
      ) {
        if (text.includes('Rate exceeded')) {
          this.applyCooldown(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
          throw rateLimited('arXiv rate limit exceeded', { url });
        }
        // Unexpected content-type indicates upstream behavior change or proxy
        // interference — treat as non-transient so withRetry doesn't waste cycles.
        throw serializationError(`arXiv API returned unexpected content-type: ${contentType}`, {
          url,
          contentType,
          body: text.slice(0, 500),
        });
      }

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
          this.applyCooldown(parsedMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
          throw rateLimited(`arXiv API returned HTTP 429`, {
            url,
            status: response.status,
            body: text.slice(0, 500),
            ...(retryAfter !== null && { retryAfter }),
          });
        }
        throw invalidRequest(`arXiv API returned HTTP ${response.status}`, {
          url,
          status: response.status,
          body: text.slice(0, 500),
        });
      }

      return text;
    });
  }

  /**
   * Serializes API requests with a delay between each to respect arXiv's
   * 3-second crawl policy. Skips queued requests whose `signal` aborted before
   * their turn — a cancelled request shouldn't consume a 3s slot. Honors any
   * server-side cooldown set by `applyCooldown` so a `Retry-After` from arXiv
   * propagates to every subsequent queued caller, not just the one that hit
   * the rate-limit.
   */
  private enqueueApiCall<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const config = getServerConfig();
    return new Promise<T>((resolve, reject) => {
      this.apiQueue = this.apiQueue.then(async () => {
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
  // Private — HTML content fetching
  // -------------------------------------------------------------------------

  private async fetchHtml(
    paperId: string,
    ctx: Context,
  ): Promise<{ content: string; source: 'arxiv_html' | 'ar5iv' }> {
    const config = getServerConfig();
    const baseId = stripVersion(paperId);

    // Try native arXiv HTML first
    {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.contentTimeoutMs)]);
      let response: Response;
      try {
        response = await fetch(`https://arxiv.org/html/${baseId}`, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw serviceUnavailable('arxiv.org HTML network error', { paperId }, { cause: err });
      }
      if (response.ok) return { content: await response.text(), source: 'arxiv_html' };
      if (response.status >= 500) {
        // Override 500/501 to ServiceUnavailable so withRetry retries them.
        throw await httpErrorFromResponse(response, {
          service: 'arxiv.org/html',
          codeOverride: (s) =>
            s >= 500 && s < 600 ? JsonRpcErrorCode.ServiceUnavailable : undefined,
        });
      }
      // 404 or other 4xx → fall through to ar5iv
    }

    // Fallback to ar5iv — don't follow redirects (307 = paper not converted)
    {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.contentTimeoutMs)]);
      let response: Response;
      try {
        response = await fetch(`https://ar5iv.labs.arxiv.org/html/${baseId}`, {
          signal,
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw serviceUnavailable('ar5iv network error', { paperId }, { cause: err });
      }
      if (response.ok) return { content: await response.text(), source: 'ar5iv' };
      if (response.status >= 500) {
        throw await httpErrorFromResponse(response, {
          service: 'ar5iv',
          codeOverride: (s) =>
            s >= 500 && s < 600 ? JsonRpcErrorCode.ServiceUnavailable : undefined,
        });
      }
      // 3xx or 4xx → not available
    }

    throw notFound(
      `HTML content not available for paper '${paperId}'. The PDF is available at https://arxiv.org/pdf/${baseId}`,
      {
        paperId,
        reason: 'html_unavailable',
        ...ctx.recoveryFor('html_unavailable'),
      },
    );
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

export function initArxivService(): void {
  _service = new ArxivService();
}

export function getArxivService(): ArxivService {
  if (!_service)
    throw new Error('ArxivService not initialized — call initArxivService() in setup()');
  return _service;
}
