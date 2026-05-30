/**
 * @fileoverview Security tests for tool definitions.
 * Verifies injection attempts are rejected or safely passed through,
 * that no secrets or env values appear in outputs, and that oversized
 * inputs are bounded before reaching downstream services.
 * @module mcp-server/tools/definitions/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import type { PaperContent, PaperLookupResult, SearchResult } from '@/services/arxiv/types.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_SEARCH_RESULT: SearchResult = { total_results: 0, start: 0, papers: [] };
const MOCK_CONTENT: PaperContent = {
  paper_id: '2401.12345v1',
  title: 'Test',
  content: 'body',
  source: 'arxiv_html',
  truncated: false,
  start: 0,
  total_characters: 4,
  body_characters: 4,
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const mockSearch = vi.fn<() => Promise<SearchResult>>();
const mockGetPapers = vi.fn<() => Promise<PaperLookupResult>>();
const mockReadContent = vi.fn<() => Promise<PaperContent>>();

beforeEach(() => {
  mockSearch.mockReset();
  mockGetPapers.mockReset();
  mockReadContent.mockReset();
  vi.mocked(getArxivService).mockReturnValue({
    search: mockSearch,
    getPapers: mockGetPapers,
    readContent: mockReadContent,
  } as any);
});

// ---------------------------------------------------------------------------
// Query injection via arxiv_search
// ---------------------------------------------------------------------------

describe('arxivSearch — injection and oversized inputs', () => {
  it('schema rejects query with null byte (C0 control char)', () => {
    expect(() => arxivSearch.input.parse({ query: 'valid\x00query' })).toThrow();
  });

  it('schema rejects query with STX control char', () => {
    expect(() => arxivSearch.input.parse({ query: '\x02bad' })).toThrow();
  });

  it('schema rejects query at 1001 chars (one over max)', () => {
    expect(() => arxivSearch.input.parse({ query: 'q'.repeat(1001) })).toThrow();
  });

  it('schema accepts query at exactly 1000 chars (boundary)', () => {
    expect(() => arxivSearch.input.parse({ query: 'q'.repeat(1000) })).not.toThrow();
  });

  it('query-injection payload reaches the service as a plain string — no shell interpretation', async () => {
    // The handler must forward the raw string to the service without further
    // transformation that could cause injection in the URL layer. The query is
    // passed verbatim and the service (mocked) receives it literally.
    mockSearch.mockResolvedValue(MOCK_SEARCH_RESULT);
    const ctx = createMockContext({ errors: arxivSearch.errors! }) as Parameters<
      typeof arxivSearch.handler
    >[1];
    const injection = 'au:alice"; DROP TABLE papers; --';
    const input = arxivSearch.input.parse({ query: injection });
    await arxivSearch.handler(input, ctx);

    // The service received the query exactly as provided — no mutation that
    // could silently drop or alter the injection string.
    expect(mockSearch).toHaveBeenCalledWith(injection, expect.anything(), ctx);
  });

  it('format output does not contain process env values', () => {
    // Set a recognizable env value and confirm it never appears in formatted output.
    const sentinel = 'SUPER_SECRET_SENTINEL_12345';
    vi.stubEnv('ARXIV_API_BASE_URL', sentinel);

    try {
      const result = arxivSearch.format?.({ papers: [] }) ?? [];
      const text = (result[0] as { text: string }).text;
      expect(text).not.toContain(sentinel);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Oversized inputs for arxiv_get_metadata
// ---------------------------------------------------------------------------

describe('arxivGetMetadata — injection and oversized inputs', () => {
  it('schema rejects more than 10 IDs in the batch array', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `2401.${String(i).padStart(5, '0')}`);
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids })).toThrow();
  });

  it('schema rejects empty string ID in the array', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ['2401.12345', ''] })).toThrow();
  });

  it('IDs with path-traversal characters pass schema but arrive at service unmodified', async () => {
    // arxiv_get_metadata accepts free-form ID strings (no path normalization);
    // actual validation happens at the arXiv API. We verify the ID is not
    // silently mutated by the handler layer.
    mockGetPapers.mockResolvedValue({
      papers: [
        {
          id: '2401.12345v1',
          title: 'Test',
          authors: ['A'],
          abstract: 'ab',
          primary_category: 'cs.AI',
          categories: ['cs.AI'],
          published: '2024-01-22T00:00:00Z',
          updated: '2024-01-22T00:00:00Z',
          pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
          abstract_url: 'https://arxiv.org/abs/2401.12345v1',
        },
      ],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const suspiciousId = '../../../etc/passwd';
    const input = arxivGetMetadata.input.parse({ paper_ids: suspiciousId });
    await arxivGetMetadata.handler(input, ctx);

    // Handler calls service with the ID as-is; arXiv API will reject it.
    expect(mockGetPapers).toHaveBeenCalledWith([suspiciousId], ctx);
  });
});

// ---------------------------------------------------------------------------
// arxiv_read_paper — injection and output safety
// ---------------------------------------------------------------------------

describe('arxivReadPaper — output safety', () => {
  it('HTML content from service is returned verbatim without transformation that leaks env vars', async () => {
    const sentinel = 'MY_SECRET_TOKEN_99999';
    vi.stubEnv('ARXIV_CONTENT_TIMEOUT_MS', sentinel);

    try {
      // Even if content happened to contain the sentinel, the FORMAT function
      // must not independently inject env vars into its output framing.
      mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, content: 'clean body content' });
      const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
        typeof arxivReadPaper.handler
      >[1];
      const input = arxivReadPaper.input.parse({ paper_id: '2401.12345' });
      const result = await arxivReadPaper.handler(input, ctx);
      const blocks = arxivReadPaper.format?.(result) ?? [];
      const text = (blocks[0] as { text: string }).text;

      // The format output framing (title, source, char counts, links) must not
      // contain the sentinel env value.
      expect(text).not.toContain(sentinel);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('very large max_characters is accepted by schema (no upper bound enforced at schema level)', () => {
    // No upper cap is enforced by the schema — the service truncates on body_characters.
    // Verify that a large value doesn't throw during parse.
    expect(() =>
      arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 10_000_000 }),
    ).not.toThrow();
  });
});
