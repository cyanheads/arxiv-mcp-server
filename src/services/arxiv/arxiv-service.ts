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
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import { getServerConfig } from '@/config/server-config.js';
import { suggestCategories, VALID_CATEGORY_CODES } from './categories.js';
import {
  expandCategory,
  getStore,
  type MirrorStore,
  openStore,
  type PaperRow,
  translateQuery,
} from './mirror/index.js';
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
 * throws stay retryable.
 */
function isArxivTransient(err: unknown): boolean {
  if (err instanceof McpError) {
    return err.code === JsonRpcErrorCode.ServiceUnavailable;
  }
  // Non-McpError (raw network errors, unexpected throws): treat as transient.
  return true;
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
 */
function collapseMathML(html: string): string {
  return html.replace(/<math\b([^>]*)>([\s\S]*?)<\/math>/g, (_, attrs: string, inner: string) => {
    const block = /\bdisplay=["']block["']/i.test(attrs);
    const annot = inner.match(
      /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/,
    )?.[1];
    const alt = attrs.match(/\balttext=["']([^"']*)["']/)?.[1];
    const tex = annot ?? alt;
    if (!tex) return '';
    const decoded = tex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return block ? `$$${decoded}$$` : `$${decoded}$`;
  });
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
 */
function stripLatexmlNoise(html: string): string {
  return (
    collapseMathML(html)
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
    abstract_url: `https://arxiv.org/abs/${row.id}`,
  };
}

/**
 * Open the mirror store lazily and verify completion. Returns the store when
 * the mirror is enabled and the cold harvest is complete; otherwise returns
 * undefined so the caller falls through to the live API.
 *
 * Failures opening the SQLite file (e.g. corrupt, permissions) are caught and
 * surfaced as `undefined` — the caller transparently falls back to live. The
 * upstream operator sees the failure via the next `mirror:verify` run.
 */
async function tryReadyMirror(
  ctx: Context,
): Promise<{ store: MirrorStore; status: 'complete' } | undefined> {
  const config = getServerConfig();
  if (!config.mirrorEnabled) return;
  try {
    const store = getStore() ?? (await openStore(config.mirrorPath));
    const state = store.readHarvestState();
    if (state.status !== 'complete') {
      ctx.log.debug('Mirror not ready; using live API', { status: state.status });
      return;
    }
    return { store, status: 'complete' };
  } catch (err) {
    ctx.log.warning('Mirror open failed; using live API', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
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

    // Mirror path: enabled, harvest complete, and the query isn't sort-by-recent
    // (which needs the up-to-the-minute live API to cover the nightly gap).
    const bypassForRecency = shouldBypassForRecency(options, config.mirrorRecentDaysLive);
    if (!bypassForRecency) {
      const ready = await tryReadyMirror(ctx);
      if (ready) {
        return this.searchMirror(ready.store, query, options, ctx);
      }
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

    try {
      return await withRetry(
        async () => {
          const xml = await this.fetchApi(url, ctx);
          const feed = this.parseAtomFeed(xml);
          return { total_results: feed.totalResults, start: feed.startIndex, papers: feed.entries };
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
      if (!bypassForRecency) throw err;
      const ready = await tryReadyMirror(ctx);
      if (!ready) throw err;
      ctx.log.warning('Live API failed on recency bypass; falling back to mirror', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.searchMirror(ready.store, query, options, ctx);
    }
  }

  /**
   * Search the local OAI-PMH mirror via FTS5. Translates the arXiv query
   * syntax, applies category-hierarchy expansion, and merges any tool-level
   * `options.category` into the structured filter set.
   */
  private searchMirror(
    store: MirrorStore,
    query: string,
    options: SearchOptions,
    ctx: Context,
  ): SearchResult {
    const translated = translateQuery(query);
    const categoryFilters = new Set(translated.categoryFilters);
    if (options.category) {
      for (const c of expandCategory(options.category)) categoryFilters.add(c);
    }
    const limit = options.maxResults ?? 10;
    const offset = options.start ?? 0;
    const sortBy = options.sortBy ?? 'relevance';
    const ftsSortBy: 'relevance' | 'published' | 'updated' =
      sortBy === 'submitted' ? 'published' : sortBy === 'updated' ? 'updated' : 'relevance';

    let papers: PaperRow[];
    let total: number;
    try {
      ({ papers, total } = store.search({
        ...(translated.matchExpr !== undefined && { matchExpr: translated.matchExpr }),
        categoryFilters: [...categoryFilters],
        limit,
        offset,
        sortBy: ftsSortBy,
        sortOrder: options.sortOrder ?? 'descending',
      }));
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
            ...ctx.recoveryFor('unsupported_query_syntax'),
          },
        );
      }
      throw err;
    }
    ctx.log.info('Mirror search', {
      query,
      total,
      returned: papers.length,
      matchExpr: translated.matchExpr,
      categoryFilters: [...categoryFilters],
    });
    return {
      total_results: total,
      start: offset,
      papers: papers.map(rowToMetadata),
    };
  }

  /** Get full metadata for one or more papers by arXiv ID. */
  async getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult> {
    const ready = await tryReadyMirror(ctx);
    if (!ready) return this.fetchLivePapers(ids, ctx);

    const config = getServerConfig();
    const baseIds = ids.map(stripVersion);
    const rows = ready.store.getPapersByIds(baseIds);
    const byBaseId = new Map(rows.map((r) => [r.id, r]));

    // Slots align with input order; mirror hits fill in here, gaps may be
    // patched from the live API below.
    const slots: (PaperMetadata | null)[] = baseIds.map((b) => {
      const row = byBaseId.get(b);
      return row ? rowToMetadata(row) : null;
    });

    const missingIndices = slots.flatMap((p, i) => (p === null ? [i] : []));
    if (missingIndices.length > 0 && config.mirrorFallbackLive) {
      const missing = missingIndices.map((i) => ids[i] ?? '');
      ctx.log.info('Mirror miss; falling back to live', { missing });
      const live = await this.fetchLivePapers(missing, ctx);
      const liveByBaseId = new Map(live.papers.map((p) => [stripVersion(p.id), p]));
      for (const i of missingIndices) {
        slots[i] = liveByBaseId.get(baseIds[i] ?? '') ?? null;
      }
    }

    const papers = slots.filter((p): p is PaperMetadata => p !== null);
    const notFoundIds = ids.filter((_, i) => slots[i] === null);
    return {
      papers,
      ...(notFoundIds.length > 0 ? { not_found_ids: notFoundIds } : {}),
    };
  }

  /** Live-API path for `getPapers`. Extracted so the mirror fallback can reuse it. */
  private async fetchLivePapers(ids: string[], ctx: Context): Promise<PaperLookupResult> {
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
        context: ctx as unknown as RequestContext,
        signal: ctx.signal,
        isTransient: isArxivTransient,
        maxRetries: 1,
      },
    );

    // Re-index by input order — arXiv returns entries in its own internal order
    // (typically submission-date desc), so a caller stitching results back to an
    // ordered reference list would otherwise silently misalign. See issue #5.
    // Both input and response sides are normalized via stripVersion since input
    // may be versioned or not and arXiv always returns versioned IDs.
    const byBaseId = new Map(result.entries.map((p) => [stripVersion(p.id), p]));
    const ordered = ids
      .map((id) => byBaseId.get(stripVersion(id)))
      .filter((p): p is PaperMetadata => p !== undefined);
    const notFoundIds = ids.filter((id) => !byBaseId.has(stripVersion(id)));

    return {
      papers: ordered,
      ...(notFoundIds.length > 0 ? { not_found_ids: notFoundIds } : {}),
    };
  }

  /** Fetch paper metadata + full HTML content. Tries native arXiv HTML, falls back to ar5iv. */
  async readContent(
    paperId: string,
    options: ReadContentOptions,
    ctx: Context,
  ): Promise<PaperContent> {
    // Metadata: prefer live API for per-version fidelity (the mirror only
    // stores the latest version). Fall back to mirror on transient failure —
    // latest-version metadata is better than an error.
    let paper: PaperMetadata | undefined;
    try {
      const lookup = await this.fetchLivePapers([paperId], ctx);
      paper = lookup.papers[0];
    } catch (err) {
      const ready = await tryReadyMirror(ctx);
      if (!ready) throw err;
      ctx.log.warning('Live API failed for readContent metadata; falling back to mirror', {
        paperId,
        error: err instanceof Error ? err.message : String(err),
      });
      const rows = ready.store.getPapersByIds([stripVersion(paperId)]);
      paper = rows[0] ? rowToMetadata(rows[0]) : undefined;
    }
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
      context: ctx as unknown as RequestContext,
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
        // AbortSignal.timeout fires with a DOMException named TimeoutError.
        // Classify as Timeout (non-retryable per isArxivTransient) — a 15s hang
        // is overwhelmingly throttling at the connection layer, not a blip.
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw timeout(
            `arXiv API timed out after ${config.apiTimeoutMs}ms`,
            { url, timeoutMs: config.apiTimeoutMs },
            { cause: err },
          );
        }
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
          const cooldownAppliedMs = this.recordRateLimit();
          throw rateLimited(this.rateLimitMessage(cooldownAppliedMs), {
            url,
            status: response.status,
            body: text.slice(0, 500),
            cooldownAppliedMs,
            consecutiveRateLimits: this.consecutiveRateLimits,
            reason: 'rate_limited',
            ...ctx.recoveryFor('rate_limited'),
          });
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
          const cooldownAppliedMs = this.recordRateLimit(parsedMs ?? undefined);
          throw rateLimited(this.rateLimitMessage(cooldownAppliedMs), {
            url,
            status: response.status,
            body: text.slice(0, 500),
            ...(retryAfter !== null && { retryAfter }),
            cooldownAppliedMs,
            consecutiveRateLimits: this.consecutiveRateLimits,
            reason: 'rate_limited',
            ...ctx.recoveryFor('rate_limited'),
          });
        }
        throw invalidRequest(`arXiv API returned HTTP ${response.status}`, {
          url,
          status: response.status,
          body: text.slice(0, 500),
          reason: 'invalid_request',
          ...ctx.recoveryFor('invalid_request'),
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
    // Pass the paperId through verbatim — both arxiv.org/html and ar5iv honor a
    // version suffix when present (`/html/2401.12345v1` serves v1; bare ID serves
    // latest). Stripping unconditionally discarded the caller's intent when they
    // asked for a specific version. See issue #10.

    // Try native arXiv HTML first
    {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.contentTimeoutMs)]);
      let response: Response;
      try {
        response = await fetch(`https://arxiv.org/html/${paperId}`, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw timeout(
            `arxiv.org HTML timed out after ${config.contentTimeoutMs}ms`,
            { paperId, timeoutMs: config.contentTimeoutMs },
            { cause: err },
          );
        }
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
        response = await fetch(`https://ar5iv.labs.arxiv.org/html/${paperId}`, {
          signal,
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw timeout(
            `ar5iv timed out after ${config.contentTimeoutMs}ms`,
            { paperId, timeoutMs: config.contentTimeoutMs },
            { cause: err },
          );
        }
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
      `HTML content not available for paper '${paperId}'. The PDF is available at https://arxiv.org/pdf/${paperId}`,
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
