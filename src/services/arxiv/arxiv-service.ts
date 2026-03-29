/**
 * @fileoverview ArxivService — search, metadata lookup, and HTML content fetching
 * for the arXiv academic paper repository. Handles rate limiting, retry with
 * exponential backoff, and Atom XML parsing.
 * @module services/arxiv/arxiv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { XMLParser } from 'fast-xml-parser';
import { getServerConfig } from '@/config/server-config.js';
import type {
  PaperContent,
  PaperLookupResult,
  PaperMetadata,
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

// ---------------------------------------------------------------------------
// Retry infrastructure
// ---------------------------------------------------------------------------

class TransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000 } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !(err instanceof TransientError)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
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
  search(query: string, options: SearchOptions, ctx: Context): Promise<SearchResult> {
    const config = getServerConfig();
    const searchQuery = options.category ? `${query} AND cat:${options.category}` : query;

    const url = new URL(`${config.apiBaseUrl}/query`);
    url.searchParams.set('search_query', searchQuery);
    url.searchParams.set('start', String(options.start ?? 0));
    url.searchParams.set('max_results', String(options.maxResults ?? 10));
    url.searchParams.set('sortBy', SORT_BY_MAP[options.sortBy ?? 'relevance'] ?? 'relevance');
    url.searchParams.set('sortOrder', options.sortOrder ?? 'descending');

    return withRetry(async () => {
      const xml = await this.fetchApi(url.toString(), ctx);
      const feed = this.parseAtomFeed(xml);
      return { total_results: feed.totalResults, start: feed.startIndex, papers: feed.entries };
    });
  }

  /** Get full metadata for one or more papers by arXiv ID. */
  async getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult> {
    const config = getServerConfig();
    const url = new URL(`${config.apiBaseUrl}/query`);
    url.searchParams.set('id_list', ids.join(','));
    url.searchParams.set('max_results', String(ids.length));

    const result = await withRetry(async () => {
      const xml = await this.fetchApi(url.toString(), ctx);
      return this.parseAtomFeed(xml);
    });

    // Cross-reference to detect not-found IDs
    const foundBaseIds = new Set(result.entries.map((p) => stripVersion(p.id)));
    const notFoundIds = ids.filter((id) => !foundBaseIds.has(stripVersion(id)));

    return {
      papers: result.entries,
      ...(notFoundIds.length > 0 ? { not_found: notFoundIds } : {}),
    };
  }

  /** Fetch paper metadata + full HTML content. Tries native arXiv HTML, falls back to ar5iv. */
  async readContent(
    paperId: string,
    maxCharacters: number | undefined,
    ctx: Context,
  ): Promise<PaperContent> {
    // Metadata fetch has its own retry via getPapers → fetchApi
    const lookup = await this.getPapers([paperId], ctx);
    const [paper] = lookup.papers;
    if (!paper) {
      throw notFound(
        `Paper '${paperId}' not found. Verify the ID format (e.g., '2401.12345' or '2401.12345v2').`,
      );
    }

    // HTML fetch with its own retry (2s base delay for heavier pages)
    const { content, source } = await withRetry(() => this.fetchHtml(paper.id, ctx), {
      maxRetries: 2,
      baseDelayMs: 2000,
    });

    const totalCharacters = content.length;
    const truncated = maxCharacters != null && totalCharacters > maxCharacters;

    return {
      paper_id: paper.id,
      title: paper.title,
      content: truncated ? content.slice(0, maxCharacters) : content,
      source,
      truncated,
      total_characters: totalCharacters,
      pdf_url: paper.pdf_url,
      abstract_url: paper.abstract_url,
    };
  }

  // -------------------------------------------------------------------------
  // Private — API fetching with rate limiting
  // -------------------------------------------------------------------------

  private fetchApi(url: string, ctx: Context): Promise<string> {
    return this.enqueueApiCall(async () => {
      const config = getServerConfig();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.apiTimeoutMs)]);

      let response: Response;
      try {
        response = await fetch(url, { signal });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new TransientError('arXiv API network error', { cause: err });
      }

      const text = await response.text();

      // arXiv returns 200 for rate limiting with plain text body
      const contentType = response.headers.get('content-type') ?? '';
      if (
        !contentType.includes('application/xml') &&
        !contentType.includes('text/xml') &&
        !contentType.includes('application/atom+xml')
      ) {
        if (text.includes('Rate exceeded')) {
          throw new TransientError('arXiv rate limit exceeded');
        }
        throw serviceUnavailable(`arXiv API returned unexpected content-type: ${contentType}`);
      }

      if (!response.ok) {
        throw new TransientError(`arXiv API returned HTTP ${response.status}`);
      }

      return text;
    });
  }

  /** Serializes API requests with a delay between each to respect arXiv's crawl policy. */
  private enqueueApiCall<T>(fn: () => Promise<T>): Promise<T> {
    const config = getServerConfig();
    return new Promise<T>((resolve, reject) => {
      this.apiQueue = this.apiQueue.then(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err as Error);
        }
        // Always delay before the next queued request, even on failure
        await sleep(config.requestDelayMs);
      });
    });
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
        response = await fetch(`https://arxiv.org/html/${baseId}`, { signal });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new TransientError('arxiv.org HTML network error', { cause: err });
      }
      if (response.ok) return { content: await response.text(), source: 'arxiv_html' };
      if (response.status >= 500) {
        throw new TransientError(`arxiv.org/html returned HTTP ${response.status}`);
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
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new TransientError('ar5iv network error', { cause: err });
      }
      if (response.ok) return { content: await response.text(), source: 'ar5iv' };
      if (response.status >= 500) {
        throw new TransientError(`ar5iv returned HTTP ${response.status}`);
      }
      // 3xx or 4xx → not available
    }

    throw notFound(
      `HTML content not available for paper '${paperId}'. The PDF is available at https://arxiv.org/pdf/${baseId}`,
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
    if (!feed) throw new Error('Invalid arXiv API response: missing feed element');

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
