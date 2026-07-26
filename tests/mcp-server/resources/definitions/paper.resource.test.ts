/**
 * @fileoverview Tests for arxiv://paper/{paperId} resource.
 * @module mcp-server/resources/definitions/paper.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    const result = await paperResource.handler({ paperId: '2401.12345' }, ctx);
    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345'], ctx);
    expect(result).toMatchObject({ id: '2401.12345v1', title: 'Test Paper' });
  });

  it('rejects an empty or whitespace-only paperId before the handler runs', () => {
    expect(() => paperResource.params!.parse({ paperId: '' })).toThrow(/cannot be empty/i);
    expect(() => paperResource.params!.parse({ paperId: '   ' })).toThrow(/cannot be empty/i);
    expect(mockGetPapers).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace off an accepted paperId', () => {
    expect(paperResource.params!.parse({ paperId: '  2401.12345  ' }).paperId).toBe('2401.12345');
  });

  it('rejects a percent-encoded blank paperId without an arXiv lookup', async () => {
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];

    // URI-template matching hands the handler raw segment text, so `%20%20%20`
    // arrives as nine ordinary characters and clears the schema's blank check.
    await expect(paperResource.handler({ paperId: '%20%20%20' }, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_id' },
    });
    expect(mockGetPapers).not.toHaveBeenCalled();
  });

  it('decodes a percent-encoded legacy paperId before lookup', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];

    await paperResource.handler({ paperId: 'hep-th%2F9901001' }, ctx);
    expect(mockGetPapers).toHaveBeenCalledWith(['hep-th/9901001'], ctx);
  });

  it('passes a malformed escape through rather than throwing a URIError', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];

    await expect(paperResource.handler({ paperId: '%zz' }, ctx)).rejects.toMatchObject({
      data: { reason: 'no_match' },
    });
    expect(mockGetPapers).toHaveBeenCalledWith(['%zz'], ctx);
  });

  it('throws when paper not found', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    await expect(paperResource.handler({ paperId: '9999.99999' }, ctx)).rejects.toThrow(
      /not found/i,
    );
  });

  it('fails with version_unavailable, not no_match, on a mirror version miss (#35)', async () => {
    // `no_match` says the ID is absent from arXiv. It is not — this deployment
    // just cannot reach that version, and the detail names the one it can.
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [
        {
          id: '1706.03762v7',
          reason: 'version_not_in_mirror',
          detail: "The local mirror holds version 3 only. Request '1706.03762v3' instead.",
        },
      ],
    });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];

    await expect(paperResource.handler({ paperId: '1706.03762v7' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'version_unavailable' },
      message: expect.stringContaining("'1706.03762v3'"),
    });
  });

  it('still fails with no_match when the ID is genuinely absent from arXiv (#35)', async () => {
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [{ id: '9999.99999', reason: 'not_in_arxiv' }],
    });
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];

    await expect(paperResource.handler({ paperId: '9999.99999' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });
});
