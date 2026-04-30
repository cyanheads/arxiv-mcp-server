/**
 * @fileoverview Tests for ArxivService — search, metadata lookup, and HTML content fetching.
 * Mocks fetch globally and uses zero request delay for fast tests.
 * @module services/arxiv/arxiv-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';
import { PaperMetadataSchema } from '@/services/arxiv/types.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
  }),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATOM_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper Title</title>
    <summary>Test abstract.</summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <arxiv:primary_category term="cs.AI" />
    <category term="cs.AI" />
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html" />
    <link href="http://arxiv.org/pdf/2401.12345v1" title="pdf" type="application/pdf" />
    <arxiv:comment>10 pages</arxiv:comment>
  </entry>
</feed>`;

const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

// Sparse entry: omits arxiv:comment, arxiv:journal_ref, arxiv:doi,
// arxiv:primary_category, and link elements entirely.
const ATOM_SPARSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.99999v1</id>
    <title>Sparse Paper</title>
    <summary>Minimal abstract.</summary>
    <author><name>Single Author</name></author>
    <category term="cs.AI" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;

function atomResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  initArxivService();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('ArxivService.search', () => {
  it('parses search results from Atom feed', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:testing', {}, ctx);

    expect(result.total_results).toBe(1);
    expect(result.start).toBe(0);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      id: '2401.12345v1',
      title: 'Test Paper Title',
      abstract: 'Test abstract.',
      authors: ['Alice', 'Bob'],
      primary_category: 'cs.AI',
      categories: ['cs.AI', 'cs.LG'],
      comment: '10 pages',
    });
  });

  it('sends a descriptive User-Agent identifying this client to arXiv', async () => {
    // arXiv community convention (cf. arxiv.py): include a UA so operators can
    // identify and contact maintainers if a client misbehaves.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:test', {}, ctx);

    const init = mockFetch.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['user-agent']).toMatch(/arxiv-mcp-server/);
    expect(headers['user-agent']).toMatch(/github\.com\/cyanheads\/arxiv-mcp-server/);
  });

  it('builds URL with correct query params', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('ti:attention', { maxResults: 5, sortBy: 'submitted', start: 10 }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/query');
    expect(url.searchParams.get('search_query')).toBe('ti:attention');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(url.searchParams.get('start')).toBe('10');
  });

  it('appends category filter to query with user query wrapped in parens', async () => {
    // Parens scope AND to the whole expression, not just the last bare token —
    // prevents "mixture of experts AND cat:cs.CL" from leaking across categories.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:testing', { category: 'cs.AI' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(all:testing) AND cat:cs.AI');
  });

  it('wraps multi-word unprefixed queries so category scopes the whole expression', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('mixture of experts', { category: 'cs.CL' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(mixture of experts) AND cat:cs.CL');
  });

  it('rejects unknown categories with a near-match suggestion', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('llm', { category: 'cs.INVALID' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'cs\.INVALID'\. Did you mean: cs\./,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown categories outside the taxonomy with edit-distance fallback', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('anything', { category: 'foo.BAR' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'foo\.BAR'/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails fast on "Rate exceeded" plain-text response without retrying', async () => {
    // arXiv returns 200 OK with `Rate exceeded.` body when throttling. Retrying
    // violates arXiv's 3s crawl etiquette and amplifies the throttle — surface
    // the rate-limit immediately. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 4xx without retrying', async () => {
    // arXiv returns HTTP 400 for bad input (e.g., non-integer max_results) with
    // an atom+xml content-type. These are permanent client errors and must not
    // be retried — see https://github.com/cyanheads/arxiv-mcp-server/issues/1.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 400,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('bad query', {}, ctx)).rejects.toThrow(/HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx transient server error', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 503,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:test', {}, ctx);

    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('fails fast on HTTP 429 and surfaces Retry-After header', async () => {
    // 429 means arXiv is throttling — retrying makes it worse. Surface the
    // Retry-After header so clients can honor the cooldown. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 429,
        headers: {
          'content-type': 'application/atom+xml; charset=UTF-8',
          'retry-after': '60',
        },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { status: 429, retryAfter: '60' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After at the queue level — subsequent calls wait the cooldown', async () => {
    // When arXiv signals throttle, the cooldown applies to ALL queued calls,
    // not just the one that hit the rate-limit. Otherwise N concurrent callers
    // each hit the same rate-limit window in parallel.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Call 1: 429 with Retry-After: 2 (seconds)
      mockFetch.mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 429,
          headers: {
            'content-type': 'application/atom+xml; charset=UTF-8',
            'retry-after': '2',
          },
        }),
      );
      // Call 2: success (should fire only after the 2s cooldown)
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

      const service = getArxivService();
      const p1 = service.search('first', {}, createMockContext());
      const p2 = service.search('second', {}, createMockContext());

      await expect(p1).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      // After p1 settled, only one fetch has happened.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance just shy of the cooldown — second call still waiting.
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past the cooldown — second call dispatches and resolves.
      await vi.advanceTimersByTimeAsync(700);
      const result = await p2;
      expect(result.papers).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips queued requests whose ctx.signal aborted before their turn', async () => {
    // A cancelled request shouldn't consume a 3s queue slot — drop it at the
    // queue head so the next live caller dispatches immediately.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const liveCtx = createMockContext();
    const cancelledCtrl = new AbortController();
    const cancelledCtx = createMockContext({ signal: cancelledCtrl.signal });
    cancelledCtrl.abort(new Error('user cancelled'));

    const service = getArxivService();

    await expect(service.search('cancelled', {}, cancelledCtx)).rejects.toThrow(/cancelled/);
    expect(mockFetch).not.toHaveBeenCalled();

    // Live request after the cancelled one still works.
    const result = await service.search('live', {}, liveCtx);
    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPapers()
// ---------------------------------------------------------------------------

describe('ArxivService.getPapers', () => {
  it('returns papers and builds id_list URL param', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.id).toBe('2401.12345v1');
    expect(result.not_found_ids).toBeUndefined();

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('id_list')).toBe('2401.12345');
  });

  it('detects not-found paper IDs', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345', '9999.99999'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.not_found_ids).toEqual(['9999.99999']);
  });

  it('handles sparse upstream entries without fabricating optional fields', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SPARSE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.99999'], ctx);
    const [paper] = result.papers;

    expect(paper).toBeDefined();
    // Output validates against the published schema even with omitted upstream fields
    expect(() => PaperMetadataSchema.parse(paper)).not.toThrow();
    // Genuinely-optional fields stay unset, not coerced into empty strings
    expect(paper?.comment).toBeUndefined();
    expect(paper?.journal_ref).toBeUndefined();
    expect(paper?.doi).toBeUndefined();
    // Primary category falls back to first <category> element when arxiv:primary_category is omitted
    expect(paper?.primary_category).toBe('cs.AI');
    // URLs derive deterministically from the paper ID when <link> elements are omitted
    expect(paper?.pdf_url).toBe('https://arxiv.org/pdf/2401.99999v1');
    expect(paper?.abstract_url).toBe('https://arxiv.org/abs/2401.99999v1');
  });
});

// ---------------------------------------------------------------------------
// readContent()
// ---------------------------------------------------------------------------

describe('ArxivService.readContent', () => {
  it('fetches metadata then HTML from arxiv.org', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<html><body>Paper content</body></html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.paper_id).toBe('2401.12345v1');
    expect(result.title).toBe('Test Paper Title');
    expect(result.source).toBe('arxiv_html');
    expect(result.content).toBe('<html><body>Paper content</body></html>');
    expect(result.truncated).toBe(false);
    expect(result.total_characters).toBe(39);
    expect(result.body_characters).toBe(39);
  });

  it('truncates content when max_characters is set', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('x'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 10 }, ctx);

    expect(result.truncated).toBe(true);
    expect(result.start).toBe(0);
    expect(result.content).toBe('x'.repeat(10));
    expect(result.total_characters).toBe(100);
  });

  it('slices from start offset when paginating', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('abcdefghij'.repeat(10)));

    const ctx = createMockContext();
    const service = getArxivService();
    // body_characters = 100; ask for chars 30..49
    const result = await service.readContent('2401.12345', { maxCharacters: 20, start: 30 }, ctx);

    expect(result.start).toBe(30);
    expect(result.body_characters).toBe(100);
    expect(result.content).toHaveLength(20);
    expect(result.content).toBe('abcdefghij'.repeat(10).slice(30, 50));
    expect(result.truncated).toBe(true);
  });

  it('returns empty content with truncated=false when start is past body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('a'.repeat(50)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent(
      '2401.12345',
      { maxCharacters: 100, start: 9999 },
      ctx,
    );

    expect(result.start).toBe(9999);
    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.body_characters).toBe(50);
  });

  it('reports truncated=false when the slice ends exactly at body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('z'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50, start: 50 }, ctx);

    expect(result.start).toBe(50);
    expect(result.content).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it('falls back to ar5iv when arxiv.org returns 404', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<html>ar5iv content</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('ar5iv');
    expect(result.content).toBe('<html>ar5iv content</html>');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws notFound when paper does not exist', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('9999.99999', {}, ctx)).rejects.toThrow(/not found/i);
  });

  it('throws notFound when no HTML source is available', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      // arxiv.org/html returns 404
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // ar5iv returns 307 redirect (paper not converted)
      .mockResolvedValueOnce(new Response('', { status: 307 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toThrow(/not available/i);
  });

  it('strips LaTeXML class/id noise and reports body_characters distinct from total', async () => {
    const raw =
      '<article><span class="ltx_text" id="S1.p1">Hello</span>' +
      '<br class="ltx_break"/><br class="ltx_break"/>' +
      '<p class="ltx_para" id="p2">World</p></article>';
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Content should no longer contain ltx_* class or id attributes
    expect(result.content).not.toMatch(/class="ltx_/);
    expect(result.content).not.toMatch(/\sid="/);
    // Runs of <br> should collapse to a single <br>
    expect(result.content).not.toMatch(/<br[^>]*>\s*<br/i);
    // Content should still contain the actual text and tag skeleton
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
    expect(result.content).toContain('<span>');
    expect(result.content).toContain('<p>');
    // Both char counts are reported; body is strictly smaller after stripping
    expect(result.total_characters).toBe(raw.length);
    expect(result.body_characters).toBe(result.content.length);
    expect(result.body_characters).toBeLessThan(result.total_characters);
  });

  it('preserves structural ltx_* class attributes (section, title, bibliography) while stripping noise', async () => {
    // Section boundaries must survive cleaning so downstream tooling (or a
    // future section-scoped read parameter) can identify them. Decorative
    // classes like ltx_text and ltx_font_bold should still be stripped.
    const raw = [
      '<article>',
      '<section class="ltx_section">',
      '<h2 class="ltx_title ltx_title_section">1 Introduction</h2>',
      '<p class="ltx_para"><span class="ltx_text ltx_font_bold">Body</span></p>',
      '<section class="ltx_subsection"><h3 class="ltx_title ltx_title_subsection">1.1</h3></section>',
      '<section class="ltx_bibliography"><h2 class="ltx_title">References</h2></section>',
      '</section>',
      '</article>',
    ].join('');
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Structural markers preserved
    expect(result.content).toContain('class="ltx_section"');
    expect(result.content).toContain('class="ltx_subsection"');
    expect(result.content).toContain('class="ltx_bibliography"');
    expect(result.content).toContain('ltx_title');
    // Decorative noise stripped
    expect(result.content).not.toContain('ltx_para');
    expect(result.content).not.toContain('ltx_text');
    expect(result.content).not.toContain('ltx_font_bold');
    // Text content survives
    expect(result.content).toContain('1 Introduction');
    expect(result.content).toContain('References');
  });

  it('truncates based on body_characters, not raw total', async () => {
    // Raw HTML with lots of ltx noise that strips down to a small body.
    const raw = `<article>${'<span class="ltx_text" id="x">a</span>'.repeat(20)}</article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50 }, ctx);

    expect(result.total_characters).toBe(raw.length);
    // Cleaned content is much smaller than raw; truncation applies to cleaned form
    expect(result.body_characters).toBeLessThan(raw.length);
    expect(result.content.length).toBeLessThanOrEqual(50);
    if (result.body_characters > 50) {
      expect(result.truncated).toBe(true);
    }
  });

  it('throws on unexpected content-type from API', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal error', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toThrow(/content-type/i);
  });
});
