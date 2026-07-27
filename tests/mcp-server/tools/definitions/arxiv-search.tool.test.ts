/**
 * @fileoverview Tests for arxiv_search tool.
 * @module mcp-server/tools/definitions/arxiv-search.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import type { PaperMetadata, SearchResult } from '@/services/arxiv/types.js';

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

describe('arxivSearch', () => {
  it('calls service.search with correct options', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({
      query: 'au:bengio AND ti:attention',
      max_results: 5,
      sort_by: 'submitted',
      sort_order: 'descending',
      start: 10,
    });
    const result = await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'au:bengio AND ti:attention', start: 5 });
    await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({
      query: 'all:transformer',
      category: 'cs.CL',
      submitted_from: '2020-01-01',
      submitted_to: '2020-01-31',
    });
    await arxivSearch.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe(
      '(all:transformer) AND cat:cs.CL AND submittedDate:[202001010000 TO 202002010000]',
    );
    expect(enrichment.effectiveQuery).not.toBe(input.query);
  });

  // Issue #27: the date window reaches the service as SearchOptions.
  it('passes the submitted-date window through to the service', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({
      query: 'all:transformer',
      submitted_from: '2024-01-01',
      submitted_to: '2024-01-31',
    });
    await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({
      query: 'all:transformer',
      submitted_from: '',
      submitted_to: '',
    });
    await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({
      query: 'all:transformer',
      category: 'cs.CL',
      max_results: 1,
    });
    await arxivSearch.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('submitted_from');
    expect(enrichment.notice).toContain('submitted_to');
    // The unreachable-offset branch must not hand back a start= the schema rejects.
    expect(enrichment.notice).not.toMatch(/start=/);
  });

  it('keeps the page-further guidance while the next offset is still reachable', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT); // 42 total, 1 shown at start 0
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'all:transformer', max_results: 10 });
    await arxivSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('start=1');
    // The suggested next offset must satisfy the schema it will be replayed against.
    const suggested = Number(/start=(\d+)/.exec(notice)?.[1]);
    expect(() =>
      arxivSearch.input.parse({ query: 'all:transformer', start: suggested }),
    ).not.toThrow();
  });

  it('discloses truncation when matches exceed the returned page', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT); // 42 total, 1 returned at start 0
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'all:transformer', max_results: 10 });
    await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'all:transformer' });
    await arxivSearch.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes category filter when provided', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'all:transformer', category: 'cs.CL' });
    await arxivSearch.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      'all:transformer',
      expect.objectContaining({ category: 'cs.CL' }),
      ctx,
    );
  });

  it('applies defaults for optional fields', () => {
    const input = arxivSearch.input.parse({ query: 'test' });
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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'xyzzy_nonexistent_term' });
    const result = await arxivSearch.handler(input, ctx);

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
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const input = arxivSearch.input.parse({ query: 'neural networks', start: 100 });
    const result = await arxivSearch.handler(input, ctx);

    expect(result.papers).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Offset 100 exceeds total results (27)');
    expect(enrichment.notice).toContain('Last valid page starts at 26');
  });

  it('formats papers', () => {
    const result = { papers: [MOCK_PAPER] };
    const blocks = arxivSearch.format?.(result) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Attention Is All You Need**');
  });

  it('formats empty results as empty string (notice is in enrichment)', () => {
    const blocks = arxivSearch.format?.({ papers: [] }) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toBe('');
  });
});
