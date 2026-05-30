/**
 * @fileoverview Additional tests for arxiv://paper/{paperId} resource covering
 * versioned IDs, optional metadata fields, and error contract.
 * @module mcp-server/resources/definitions/paper.extra.test
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

const MOCK_SPARSE_PAPER: PaperMetadata = {
  id: '2401.99999v2',
  title: 'Sparse Paper',
  authors: ['Bob'],
  abstract: 'Minimal.',
  primary_category: 'math.AG',
  categories: ['math.AG'],
  published: '2024-02-01T00:00:00Z',
  updated: '2024-02-01T00:00:00Z',
  pdf_url: 'https://arxiv.org/pdf/2401.99999v2',
  abstract_url: 'https://arxiv.org/abs/2401.99999v2',
  // comment, journal_ref, doi all absent
};

const mockGetPapers = vi.fn<() => Promise<PaperLookupResult>>();

beforeEach(() => {
  mockGetPapers.mockReset();
  vi.mocked(getArxivService).mockReturnValue({ getPapers: mockGetPapers } as any);
});

describe('paperResource — additional cases', () => {
  it('passes versioned ID to service unchanged', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    await paperResource.handler({ paperId: '2401.12345v1' }, ctx);
    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345v1'], ctx);
  });

  it('returns sparse paper without optional fields set', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_SPARSE_PAPER] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    const result = (await paperResource.handler({ paperId: '2401.99999v2' }, ctx)) as PaperMetadata;
    expect(result.id).toBe('2401.99999v2');
    expect(result.comment).toBeUndefined();
    expect(result.journal_ref).toBeUndefined();
    expect(result.doi).toBeUndefined();
  });

  it('throws with paper ID in error message when not found', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    await expect(paperResource.handler({ paperId: '9999.99999' }, ctx)).rejects.toThrow(
      /9999\.99999/,
    );
  });

  it('has correct resource metadata', () => {
    expect(paperResource.uriTemplate).toBe('arxiv://paper/{paperId}');
    expect(paperResource.name).toBe('arXiv Paper Metadata');
    expect(paperResource.mimeType).toBe('application/json');
  });

  it('returns paper with all optional metadata when provided by service', async () => {
    const full: PaperMetadata = {
      ...MOCK_PAPER,
      comment: '12 pages, 5 figures',
      journal_ref: 'NeurIPS 2024',
      doi: '10.1234/test.2024',
    };
    mockGetPapers.mockResolvedValue({ papers: [full] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    const result = (await paperResource.handler({ paperId: '2401.12345' }, ctx)) as PaperMetadata;
    expect(result.comment).toBe('12 pages, 5 figures');
    expect(result.journal_ref).toBe('NeurIPS 2024');
    expect(result.doi).toBe('10.1234/test.2024');
  });

  it('errors contract has no_match with NotFound code', () => {
    const noMatch = paperResource.errors?.find((e) => e.reason === 'no_match');
    expect(noMatch).toBeDefined();
    // -32001 is JsonRpcErrorCode.NotFound
    expect(noMatch?.code).toBe(-32001);
  });
});
