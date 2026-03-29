/**
 * @fileoverview Tests for arxiv_get_metadata tool.
 * @module mcp-server/tools/definitions/arxiv-get-metadata.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import type { PaperLookupResult, PaperMetadata } from '@/services/arxiv/types.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_PAPER: PaperMetadata = {
  id: '2401.12345v1',
  title: 'Test Paper',
  authors: ['Alice'],
  abstract: 'An abstract.',
  primary_category: 'cs.AI',
  categories: ['cs.AI'],
  published: '2024-01-22T00:00:00Z',
  updated: '2024-01-22T00:00:00Z',
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const mockGetPapers = vi.fn<() => Promise<PaperLookupResult>>();

beforeEach(() => {
  mockGetPapers.mockReset();
  vi.mocked(getArxivService).mockReturnValue({ getPapers: mockGetPapers } as any);
});

describe('arxivGetMetadata', () => {
  it('normalizes string input to array', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext();
    const input = arxivGetMetadata.input.parse({ paper_ids: '2401.12345' });
    await arxivGetMetadata.handler(input, ctx);

    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345'], ctx);
  });

  it('passes array input directly', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext();
    const input = arxivGetMetadata.input.parse({ paper_ids: ['2401.12345', '2401.67890'] });
    await arxivGetMetadata.handler(input, ctx);

    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345', '2401.67890'], ctx);
  });

  it('throws when no papers found', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext();
    const input = arxivGetMetadata.input.parse({ paper_ids: '9999.99999' });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toThrow(/not found|no papers/i);
  });

  it('formats papers and not-found list', () => {
    const result: PaperLookupResult = {
      papers: [MOCK_PAPER],
      not_found: ['9999.99999'],
    };
    const blocks = arxivGetMetadata.format?.(result) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Test Paper**');
    expect(text).toContain('Not found: 9999.99999');
  });
});
