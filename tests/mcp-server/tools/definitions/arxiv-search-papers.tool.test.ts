/**
 * @fileoverview Tests for arxiv_search_papers tool.
 * @module mcp-server/tools/definitions/arxiv-search-papers.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivSearchPapers } from '@/mcp-server/tools/definitions/arxiv-search-papers.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import type { PaperMetadata, SearchResult } from '@/services/arxiv/types.js';
import {
  COMMONMARK_PRESETS,
  readCommonMarkFences,
  readCommonMarkText,
} from '../../../helpers/commonmark-text.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_PAPER: PaperMetadata = {
  id: '2401.12345v1',
  title: 'Attention Is All You Need',
  authors: ['Alice', 'Bob'],
  abstract: 'We propose a novel architecture.',
  primary_category: 'cs.CL',
  categories: ['cs.CL', 'cs.AI'],
  published: '2024-01-22T00:00:00Z',
  updated: '2024-01-23T00:00:00Z',
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const MOCK_RESULT: SearchResult = {
  total_results: 42,
  start: 0,
  papers: [MOCK_PAPER],
  effective_query: 'au:bengio AND ti:attention',
};

const mockSearch = vi.fn<() => Promise<SearchResult>>();

beforeEach(() => {
  mockSearch.mockReset();
  vi.mocked(getArxivService).mockReturnValue({ search: mockSearch } as any);
});

describe('arxivSearchPapers', () => {
  // Issue #46: the search tool names its object; the old bare name is gone, with no alias.
  it('registers as arxiv_search_papers beside the other three tools and nothing else', () => {
    expect(arxivSearchPapers.name).toBe('arxiv_search_papers');
    expect(allToolDefinitions.map((def) => def.name)).toEqual([
      'arxiv_search_papers',
      'arxiv_get_metadata',
      'arxiv_read_paper',
      'arxiv_list_categories',
    ]);
  });

  it('calls service.search with correct options', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'au:bengio AND ti:attention',
      max_results: 5,
      sort_by: 'submitted',
      sort_order: 'descending',
      start: 10,
    });
    const result = await arxivSearchPapers.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      'au:bengio AND ti:attention',
      expect.objectContaining({
        maxResults: 5,
        sortBy: 'submitted',
        sortOrder: 'descending',
        start: 10,
      }),
      ctx,
    );
    expect(result.papers).toHaveLength(1);
  });

  it('populates enrichment with query, total, and page start', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'au:bengio AND ti:attention', start: 5 });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('au:bengio AND ti:attention');
    expect(enrichment.totalFound).toBe(42);
    expect(enrichment.pageStart).toBe(0); // service echoes back start from result
  });

  // Issue #20: the echo has to be the service's computed query, not input.query.
  // Reconstructing it here would go stale the moment a filter dimension is added,
  // which is exactly how the category wrapper went missing.
  it('echoes the service effective_query rather than the raw input query', async () => {
    mockSearch.mockResolvedValue({
      total_results: 5,
      start: 0,
      papers: [MOCK_PAPER],
      effective_query:
        '(all:transformer) AND cat:cs.CL AND submittedDate:[202001010000 TO 202002010000]',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'all:transformer',
      category: 'cs.CL',
      submitted_from: '2020-01-01',
      submitted_to: '2020-01-31',
    });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe(
      '(all:transformer) AND cat:cs.CL AND submittedDate:[202001010000 TO 202002010000]',
    );
    expect(enrichment.effectiveQuery).not.toBe(input.query);
  });

  // Issue #27: the date window reaches the service as SearchOptions.
  it('passes the submitted-date window through to the service', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'all:transformer',
      submitted_from: '2024-01-01',
      submitted_to: '2024-01-31',
    });
    await arxivSearchPapers.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      'all:transformer',
      expect.objectContaining({ submittedFrom: '2024-01-01', submittedTo: '2024-01-31' }),
      ctx,
    );
  });

  // Form-based clients submit the whole schema shape; empty strings are "unset",
  // not a window bounded by nothing.
  it('treats empty date strings from form clients as no window', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'all:transformer',
      submitted_from: '',
      submitted_to: '',
    });
    await arxivSearchPapers.handler(input, ctx);

    const [, options] = mockSearch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty('submittedFrom');
    expect(options).not.toHaveProperty('submittedTo');
  });

  // Issue #27: past the offset ceiling, "page further with start=N" names a call
  // the input schema rejects. The guidance has to point at a mechanism that works.
  it('points truncation guidance at date windows once matches exceed the reachable offset', async () => {
    mockSearch.mockResolvedValue({
      total_results: 13_549,
      start: 0,
      papers: [MOCK_PAPER],
      effective_query: '(all:transformer) AND cat:cs.CL',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'all:transformer',
      category: 'cs.CL',
      max_results: 1,
    });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('submitted_from');
    expect(enrichment.notice).toContain('submitted_to');
    // The unreachable-offset branch must not hand back a start= the schema rejects.
    expect(enrichment.notice).not.toMatch(/start=/);
  });

  it('keeps the page-further guidance while the next offset is still reachable', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT); // 42 total, 1 shown at start 0
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'all:transformer', max_results: 10 });
    await arxivSearchPapers.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('start=1');
    // The suggested next offset must satisfy the schema it will be replayed against.
    const suggested = Number(/start=(\d+)/.exec(notice)?.[1]);
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'all:transformer', start: suggested }),
    ).not.toThrow();
  });

  it('discloses truncation when matches exceed the returned page', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT); // 42 total, 1 returned at start 0
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'all:transformer', max_results: 10 });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(10);
    expect(enrichment.notice).toContain('42 total matches');
  });

  it('omits truncation disclosure when the page holds all matches', async () => {
    mockSearch.mockResolvedValue({
      total_results: 1,
      start: 0,
      papers: [MOCK_PAPER],
      effective_query: 'all:transformer',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'all:transformer' });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes category filter when provided', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'all:transformer', category: 'cs.CL' });
    await arxivSearchPapers.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      'all:transformer',
      expect.objectContaining({ category: 'cs.CL' }),
      ctx,
    );
  });

  it('applies defaults for optional fields', () => {
    const input = arxivSearchPapers.input.parse({ query: 'test' });
    expect(input.max_results).toBe(10);
    expect(input.sort_by).toBe('relevance');
    expect(input.sort_order).toBe('descending');
    expect(input.start).toBe(0);
  });

  it('sets empty-result notice in enrichment when no papers match', async () => {
    mockSearch.mockResolvedValue({
      total_results: 0,
      start: 0,
      papers: [],
      effective_query: 'xyzzy_nonexistent_term',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'xyzzy_nonexistent_term' });
    const result = await arxivSearchPapers.handler(input, ctx);

    expect(result.papers).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalFound).toBe(0);
    expect(enrichment.notice).toContain('No papers found');
  });

  it('sets pagination-overshoot notice in enrichment', async () => {
    mockSearch.mockResolvedValue({
      total_results: 27,
      start: 100,
      papers: [],
      effective_query: 'neural networks',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({ query: 'neural networks', start: 100 });
    const result = await arxivSearchPapers.handler(input, ctx);

    expect(result.papers).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Offset 100 exceeds total results (27)');
    expect(enrichment.notice).toContain('Last valid page starts at 26');
  });

  it('formats papers', () => {
    const result = { papers: [MOCK_PAPER] };
    const blocks = arxivSearchPapers.format?.(result) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**`Attention Is All You Need`**');
  });

  it('formats empty results as empty string (notice is in enrichment)', () => {
    const blocks = arxivSearchPapers.format?.({ papers: [] }) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toBe('');
  });

  // formatPaper()'s encoding is tabled in security.test.ts, through this tool;
  // this pins the rest of the page: each paper set off by a rule, and the query
  // echo reading back from content[] as structuredContent carries it — a code
  // span, so the copied query carries no backslash escapes.
  it('sets each paper off by a rule and reads back the query echo (#87, #91)', async () => {
    const commented: PaperMetadata = {
      ...MOCK_PAPER,
      title: 'A commented paper',
      comment: '12 pages',
    };
    const query = 'ti:"Sgr A*" AND [x](y)';
    mockSearch.mockResolvedValue({
      ...MOCK_RESULT,
      total_results: 2,
      papers: [commented, MOCK_PAPER],
      effective_query: query,
    });
    const result = await runToolContract(arxivSearchPapers, { query });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = result.structuredContent as {
      papers: PaperMetadata[];
      effectiveQuery: string;
    };
    expect(structured.papers).toEqual([commented, MOCK_PAPER]);
    expect(structured.effectiveQuery).toBe(query);
    const [papers, trailer] = result.content.map((c) => (c.type === 'text' ? c.text : ''));
    const meta = 'cs.CL, cs.AI | 2024-01-22 (updated 2024-01-23)';
    for (const preset of COMMONMARK_PRESETS) {
      expect(readCommonMarkText(papers ?? '', preset), preset).toBe(
        [
          `⟨strong⟩⟨code_inline:${commented.title}⟩⟨/strong⟩\narXiv:${commented.id} | ${meta}\n⟨code_inline:Alice, Bob⟩`,
          '⟨fence:text⟩',
          'Comment:',
          '⟨fence:text⟩',
          `Published: ${commented.published} | Updated: ${commented.updated}\nAbstract: ⟨a href=${commented.abstract_url}⟩${commented.abstract_url}⟨/a⟩\nPDF: ⟨a href=${commented.pdf_url}⟩${commented.pdf_url}⟨/a⟩`,
          '⟨hr⟩',
          `⟨strong⟩⟨code_inline:${MOCK_PAPER.title}⟩⟨/strong⟩\narXiv:${MOCK_PAPER.id} | ${meta}\n⟨code_inline:Alice, Bob⟩`,
          '⟨fence:text⟩',
          `Published: ${MOCK_PAPER.published} | Updated: ${MOCK_PAPER.updated}\nAbstract: ⟨a href=${MOCK_PAPER.abstract_url}⟩${MOCK_PAPER.abstract_url}⟨/a⟩\nPDF: ⟨a href=${MOCK_PAPER.pdf_url}⟩${MOCK_PAPER.pdf_url}⟨/a⟩`,
        ].join('\n\n'),
      );
      expect(readCommonMarkFences(papers ?? '', preset), preset).toEqual(
        [commented.abstract, '12 pages', MOCK_PAPER.abstract].map((value) => ({
          info: 'text',
          literal: `${value}\n`,
        })),
      );
      expect(readCommonMarkText(trailer ?? '', preset), preset).toBe(
        `⟨strong⟩Query:⟨/strong⟩ ⟨code_inline:${query}⟩\n⟨strong⟩Total Found:⟨/strong⟩ 2\n⟨strong⟩Page Start:⟨/strong⟩ 0`,
      );
    }
  });
});

// Issue #51: max_results past the 50-per-call cap serves 50 and names the next
// page through the existing truncation disclosure instead of rejecting.
describe('arxivSearchPapers — max_results past the per-call cap', () => {
  /** A page of `count` distinct papers. */
  function page(count: number): PaperMetadata[] {
    return Array.from({ length: count }, (_, i) => ({
      ...MOCK_PAPER,
      id: `2401.${String(i + 1).padStart(5, '0')}v1`,
    }));
  }

  it('requests 50, reports cap 50, and names start=<start + 50> for the next page', async () => {
    mockSearch.mockResolvedValue({
      total_results: 120,
      start: 0,
      papers: page(50),
      effective_query: 'all:transformer',
    });
    const result = await runToolContract(arxivSearchPapers, {
      query: 'all:transformer',
      max_results: 200,
    });

    expect(mockSearch).toHaveBeenCalledWith(
      'all:transformer',
      expect.objectContaining({ maxResults: 50, start: 0 }),
      expect.anything(),
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toMatch(/\bstart=50\b/);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toMatch(/\bstart=50\b/);
  });

  // A mirror-answered page: no result_limit, so start caps at 10,000 plus a page.
  it('measures the reachable bound with the applied 50, not the requested max_results', async () => {
    mockSearch.mockResolvedValue({
      total_results: 10_051,
      start: 9_990,
      papers: page(50),
      effective_query: 'all:transformer',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const input = arxivSearchPapers.input.parse({
      query: 'all:transformer',
      start: 9_990,
      max_results: 200,
    });
    await arxivSearchPapers.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.cap).toBe(50);
    expect(enrichment.notice).toContain('only the first 10050 are reachable');
    expect(enrichment.notice).toContain('submitted_from');
    expect(enrichment.notice).not.toMatch(/start=/);
  });

  // Issue #56: a live-answered page carries arXiv's result limit — the notice
  // names the 10,000 arXiv serves and cap reports the page the service cut.
  it('states arXiv’s 10,000-result limit on a live page and reports the cut page size', async () => {
    mockSearch.mockResolvedValue({
      total_results: 293_610,
      start: 9_990,
      papers: page(10),
      effective_query: 'cat:cs.LG',
      result_limit: 10_000,
    });
    const result = await runToolContract(arxivSearchPapers, {
      query: 'cat:cs.LG',
      start: 9_990,
      max_results: 200,
    });

    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 10, cap: 10 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('293610 total matches, but arXiv serves only the first 10000');
    expect(notice).not.toContain('10050');
    expect(notice).not.toMatch(/start=/);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('arXiv serves only the first 10000');
  });

  it('keeps the page-further recipe on a live page whose matches end before 10,000', async () => {
    mockSearch.mockResolvedValue({
      total_results: 9_995,
      start: 9_900,
      papers: page(50),
      effective_query: 'all:transformer',
      result_limit: 10_000,
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    await arxivSearchPapers.handler(
      arxivSearchPapers.input.parse({ query: 'all:transformer', start: 9_900, max_results: 50 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.cap).toBe(50);
    expect(enrichment.notice).toMatch(/\bstart=9950\b/);
  });

  it('adds nothing when every match fits on the page', async () => {
    mockSearch.mockResolvedValue({
      total_results: 30,
      start: 0,
      papers: page(30),
      effective_query: 'all:transformer',
    });
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    await arxivSearchPapers.handler(
      arxivSearchPapers.input.parse({ query: 'all:transformer', max_results: 10_000 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.cap).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('keeps a max_results of exactly 50 as requested', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    await arxivSearchPapers.handler(
      arxivSearchPapers.input.parse({ query: 'all:transformer', max_results: 50 }),
      ctx,
    );

    expect(mockSearch).toHaveBeenCalledWith(
      'all:transformer',
      expect.objectContaining({ maxResults: 50 }),
      ctx,
    );
    expect(getEnrichment(ctx).cap).toBe(50);
  });
});

// Issue #78: a mirror search without a free-text term, other than one category
// code, stops counting at 50,000 and flags the total as a lower bound.
describe('arxivSearchPapers — a mirror total that stopped at the cap', () => {
  /** A page of `count` distinct papers. */
  function page(count: number): PaperMetadata[] {
    return Array.from({ length: count }, (_, i) => ({
      ...MOCK_PAPER,
      id: `2401.${String(i + 1).padStart(5, '0')}v1`,
    }));
  }
  const textOf = (result: { content: { type: string; text?: string }[] }): string =>
    result.content.map((block) => block.text ?? '').join('\n');
  const capped = (start: number, count: number): SearchResult => ({
    total_results: 50_000,
    total_is_lower_bound: true,
    start,
    papers: page(count),
    effective_query: 'cat:cs.*',
  });

  it('flags the total and says "or more" on both surfaces', async () => {
    mockSearch.mockResolvedValue(capped(0, 10));
    const result = await runToolContract(arxivSearchPapers, { query: 'cat:cs' });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totalFound: 50_000,
      totalFoundIsLowerBound: true,
      truncated: true,
      shown: 10,
      cap: 10,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('50000 or more total matches');
    expect(notice).toContain('only the first 10010 are reachable');
    expect(notice).toContain('submitted_from');
    expect(notice).not.toMatch(/start=/);
    const text = textOf(result);
    expect(text).toContain('**Total Found Is Lower Bound:** true');
    expect(text).toContain('50000 or more total matches');
  });

  it('keeps the date-window guidance on the deepest page, which is never empty', async () => {
    mockSearch.mockResolvedValue(capped(10_000, 50));
    const result = await runToolContract(arxivSearchPapers, {
      query: 'cat:cs',
      start: 10_000,
      max_results: 50,
    });

    expect(result.structuredContent).toMatchObject({
      totalFoundIsLowerBound: true,
      pageStart: 10_000,
      shown: 50,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('50000 or more total matches, but only the first 10050 are reachable');
    expect(notice).not.toContain('exceeds total results');
    expect(notice).not.toContain('No papers found');
  });

  it('leaves the field out, and the count unqualified, when the total is exact', async () => {
    const { total_is_lower_bound: _flag, ...exact } = capped(0, 10);
    mockSearch.mockResolvedValue(exact);
    const result = await runToolContract(arxivSearchPapers, { query: 'cat:cs' });

    expect(result.structuredContent).not.toHaveProperty('totalFoundIsLowerBound');
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('50000 total matches');
    expect(notice).not.toContain('or more');
    expect(textOf(result)).not.toContain('Lower Bound');
  });

  it('describes totalFound as exact on arXiv and a floor for a capped mirror count', () => {
    const description = arxivSearchPapers.enrichment?.totalFound?.description ?? '';
    expect(description).toContain('50,000 or more');
    expect(description).toContain('totalFoundIsLowerBound');
  });
});
