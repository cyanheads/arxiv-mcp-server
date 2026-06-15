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
    mockSearch.mockResolvedValue({ total_results: 1, start: 0, papers: [MOCK_PAPER] });
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
    mockSearch.mockResolvedValue({ total_results: 0, start: 0, papers: [] });
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
    mockSearch.mockResolvedValue({ total_results: 27, start: 100, papers: [] });
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
