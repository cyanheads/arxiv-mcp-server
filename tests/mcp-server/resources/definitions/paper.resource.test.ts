/**
 * @fileoverview Tests for arxiv://paper/{paperId} resource.
 * @module mcp-server/resources/definitions/paper.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperResource } from '@/mcp-server/resources/definitions/paper.resource.js';
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

describe('paperResource', () => {
  it('returns paper for valid ID', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext();
    const result = await paperResource.handler({ paperId: '2401.12345' }, ctx);
    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345'], ctx);
    expect(result).toMatchObject({ id: '2401.12345v1', title: 'Test Paper' });
  });

  it('throws when paper not found', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext();
    await expect(paperResource.handler({ paperId: '9999.99999' }, ctx)).rejects.toThrow(
      /not found/i,
    );
  });
});
