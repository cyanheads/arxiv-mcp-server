/**
 * @fileoverview Tests for arxiv_search tool.
 * @module mcp-server/tools/definitions/arxiv-search.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext();
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
    expect(result.total_results).toBe(42);
    expect(result.papers).toHaveLength(1);
  });

  it('passes category filter when provided', async () => {
    mockSearch.mockResolvedValue(MOCK_RESULT);
    const ctx = createMockContext();
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

  it('formats papers with header and range', () => {
    const result: SearchResult = { total_results: 42, start: 0, papers: [MOCK_PAPER] };
    const blocks = arxivSearch.format?.(result) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Found 42 papers');
    expect(text).toContain('offset 0');
    expect(text).toContain('showing 1-1');
    expect(text).toContain('**Attention Is All You Need**');
  });

  it('formats empty results', () => {
    const blocks = arxivSearch.format?.({ total_results: 0, start: 0, papers: [] }) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toBe(
      'No papers found. Try broader search terms, remove field prefixes (ti:, au:), or check category codes with arxiv_list_categories.',
    );
  });

  it('distinguishes pagination overflow from genuine no-results', () => {
    // start past the last result of a non-empty set — user paged past the end.
    const blocks = arxivSearch.format?.({ total_results: 27, start: 100, papers: [] }) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Offset 100 exceeds total results (27)');
    expect(text).toContain('Last valid page starts at 26');
  });
});
