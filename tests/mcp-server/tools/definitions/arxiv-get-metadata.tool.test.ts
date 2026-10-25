/**
 * @fileoverview Tests for arxiv_get_metadata tool.
 * @module mcp-server/tools/definitions/arxiv-get-metadata.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import type { PaperLookupResult, PaperMetadata } from '@/services/arxiv/types.js';
import { COMMONMARK_PRESETS, readCommonMarkText } from '../../../helpers/commonmark-text.js';

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
    // The schema takes an array and wraps a lone string into it.
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const result = await runToolContract(arxivGetMetadata, { paper_ids: '2401.12345' } as never);

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345'], expect.anything());
  });

  it('looks up each ID in canonical form (#41)', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({
      paper_ids: ['arXiv:2401.12345', 'HEP-TH/9901001V2', 'https://arxiv.org/abs/math.GT/0309136'],
    });
    await arxivGetMetadata.handler(input, ctx);

    expect(mockGetPapers).toHaveBeenCalledWith(
      ['2401.12345', 'hep-th/9901001v2', 'math/0309136'],
      ctx,
    );
  });

  it('passes array input directly', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['2401.12345', '2401.67890'] });
    await arxivGetMetadata.handler(input, ctx);

    expect(mockGetPapers).toHaveBeenCalledWith(['2401.12345', '2401.67890'], ctx);
  });

  it('throws when no papers found', async () => {
    mockGetPapers.mockResolvedValue({ papers: [] });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['9999.99999'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toThrow(/not found|no papers/i);
  });

  it('names the malformed IDs in the no_match message (#41)', async () => {
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [{ id: '9999.99999', reason: 'not_in_arxiv' }],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['9999.99999', 'doi:10.1/x'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_match',
        not_found: [
          { id: '9999.99999', reason: 'not_in_arxiv' },
          expect.objectContaining({ id: 'doi:10.1/x', reason: 'invalid_id' }),
        ],
      },
      message: expect.stringContaining("'doi:10.1/x'"),
    });
    expect(mockGetPapers).toHaveBeenCalledWith(['9999.99999'], ctx);
  });

  it('fails with version_unavailable, not no_match, when every miss is a mirror version miss (#35)', async () => {
    // `no_match` recovery tells the caller to doubt the ID. The ID is fine —
    // this deployment just cannot reach that version.
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
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['1706.03762v7'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'version_unavailable' },
      message: expect.stringContaining("'1706.03762v3'"),
    });
  });

  it('fails with version_not_served, not no_match, when every miss is a version arXiv will not serve (#53)', async () => {
    const detail =
      "arXiv's API answered HTTP 500 for the lookup holding this version; the latest version is v3.";
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [{ id: 'hep-th/9901001v1', reason: 'version_not_served', detail }],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['hep-th/9901001v1', 'not an id'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'version_not_served',
        not_found: [
          { id: 'hep-th/9901001v1', reason: 'version_not_served', detail },
          expect.objectContaining({ id: 'not an id', reason: 'invalid_id' }),
        ],
      },
      message: `'hep-th/9901001v1' could not be served. ${detail} Not arXiv IDs, so never looked up: 'not an id'.`,
    });
  });

  it('fails with no_match when version_not_served misses mix with IDs absent from arXiv (#53)', async () => {
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [
        { id: 'hep-th/9901001v1', reason: 'version_not_served', detail: 'Latest is v3.' },
        { id: 'hep-th/9901001v4', reason: 'not_in_arxiv' },
      ],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({
      paper_ids: ['hep-th/9901001v1', 'hep-th/9901001v4'],
    });

    // The message still names the version that can be served, so a caller
    // reading only the text is not told to doubt a real version.
    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
      message:
        "No papers found for the given IDs. 'hep-th/9901001v1' could not be served. Latest is v3.",
    });
  });

  it('still fails with no_match when the IDs are genuinely absent from arXiv (#35)', async () => {
    mockGetPapers.mockResolvedValue({
      papers: [],
      not_found: [{ id: '9999.99999', reason: 'not_in_arxiv' }],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['9999.99999'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('forwards each miss with the reason the service assigned (#35)', async () => {
    mockGetPapers.mockResolvedValue({
      papers: [MOCK_PAPER],
      not_found: [
        { id: '1706.03762v7', reason: 'version_not_in_mirror', detail: 'Mirror holds version 3.' },
        { id: '9999.99999', reason: 'not_in_arxiv' },
      ],
    });
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({
      paper_ids: ['2401.12345', '1706.03762v7', '9999.99999'],
    });
    const result = await arxivGetMetadata.handler(input, ctx);

    expect(result.not_found).toEqual([
      { id: '1706.03762v7', reason: 'version_not_in_mirror', detail: 'Mirror holds version 3.' },
      { id: '9999.99999', reason: 'not_in_arxiv' },
    ]);
  });

  it('formats papers and not-found list', () => {
    const blocks =
      arxivGetMetadata.format?.({
        papers: [MOCK_PAPER],
        totalSucceeded: 1,
        not_found: [
          { id: '9999.99999', reason: 'not_in_arxiv' },
          {
            id: '1706.03762v7',
            reason: 'version_not_in_mirror',
            detail: 'Mirror holds version 3.',
          },
        ],
      }) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Test Paper**');
    expect(text).toContain('Found 1 of 3 papers');
    expect(text).toContain('9999.99999 (not_in_arxiv)');
    expect(text).toContain('1706.03762v7 (version_not_in_mirror): Mirror holds version 3.');
  });

  it('advertises version_not_served in the not_found reason enum and errors[], and renders it (#53)', () => {
    const result = {
      papers: [MOCK_PAPER],
      totalSucceeded: 1,
      not_found: [
        { id: 'hep-th/9901001v1', reason: 'version_not_served' as const, detail: 'Latest is v3.' },
      ],
    };
    const output = arxivGetMetadata.output.parse(result);
    expect(output.not_found?.[0]?.reason).toBe('version_not_served');
    const blocks = arxivGetMetadata.format?.(output) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Found 1 of 2 papers');
    expect(text).toContain('- hep-th/9901001v1 (version_not_served): Latest is v3.');
    const contract = arxivGetMetadata.errors?.find((e) => e.reason === 'version_not_served');
    expect(contract).toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(contract).not.toHaveProperty('retryable', true);
  });

  it('carries remaining_ids and invalid_id entries on both surfaces (#41, #51)', async () => {
    mockGetPapers.mockResolvedValue({ papers: [MOCK_PAPER] });
    const ids = Array.from({ length: 11 }, (_, i) => `2401.${String(i + 12345).padStart(5, '0')}`);
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['not an id', ...ids],
    });

    const output = arxivGetMetadata.output.parse(result.structuredContent);
    expect(output.remaining_ids).toEqual(['2401.12355']);
    expect(output.not_found).toEqual([
      expect.objectContaining({ id: 'not an id', reason: 'invalid_id' }),
    ]);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('Found 1 of 2 papers.');
    expect(text).toContain('- not an id (invalid_id): Not an arXiv ID.');
    expect(text).toContain(
      'Remaining IDs (not looked up; pass as paper_ids in the next call): ["2401.12355"]',
    );
  });

  // formatPaper()'s encoding is tabled in security.test.ts; one escaped title
  // proves this tool routes papers through it. The not_found lines are this
  // tool's own: an id and a detail, with and without the detail, and
  // remaining_ids read back from content[] as structuredContent carries them.
  it('reads back every paper, not_found entry, and remaining ID as structuredContent carries it (#87)', async () => {
    const paper: PaperMetadata = {
      ...MOCK_PAPER,
      id: 'astro-ph/9705060v1',
      title: 'Line strength indices Hb, <Fe>, and Mg2',
    };
    mockGetPapers.mockResolvedValue({
      papers: [paper],
      not_found: [
        {
          id: '2401.00002',
          reason: 'live_lookup_failed',
          detail: 'arXiv API returned *HTTP 503* <html> [retry](x)',
        },
        { id: '2401.00010', reason: 'not_in_arxiv' },
      ],
    });
    const ids = Array.from({ length: 9 }, (_, i) => `2401.${String(i + 10).padStart(5, '0')}`);
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['*bad* [x](y) <b>', 'astro-ph/9705060', '2401.00002', ...ids],
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent);
    expect(output.papers).toEqual([paper]);
    expect(output.remaining_ids).toEqual(['2401.00018']);
    const [invalid] = output.not_found ?? [];
    expect(output.not_found).toEqual([
      {
        id: '*bad* [x](y) <b>',
        reason: 'invalid_id',
        detail: expect.stringMatching(/^Not an arXiv ID\. Use /),
      },
      {
        id: '2401.00002',
        reason: 'live_lookup_failed',
        detail: 'arXiv API returned *HTTP 503* <html> [retry](x)',
      },
      { id: '2401.00010', reason: 'not_in_arxiv' },
    ]);
    const block = result.content[0];
    const text = block?.type === 'text' ? block.text : '';
    for (const preset of COMMONMARK_PRESETS) {
      expect(readCommonMarkText(text, preset), preset).toBe(
        [
          'Found 1 of 4 papers. Looked up the first 10 well-formed IDs; 1 more ID is listed under Remaining IDs below.',
          `⟨strong⟩${paper.title}⟨/strong⟩\narXiv:${paper.id} | cs.AI | 2024-01-22\nAlice`,
          '⟨blockquote_open⟩',
          paper.abstract,
          '⟨blockquote_close⟩',
          `Published: ${paper.published} | Updated: ${paper.updated}\nAbstract: ⟨a href=${paper.abstract_url}⟩${paper.abstract_url}⟨/a⟩\nPDF: ⟨a href=${paper.pdf_url}⟩${paper.pdf_url}⟨/a⟩`,
          'Not found:',
          '⟨bullet_list_open⟩',
          '⟨list_item_open⟩',
          `*bad* [x](y) <b> (invalid_id): ${invalid?.detail}`,
          '⟨list_item_close⟩',
          '⟨list_item_open⟩',
          '2401.00002 (live_lookup_failed): arXiv API returned *HTTP 503* <html> [retry](x)',
          '⟨list_item_close⟩',
          '⟨list_item_open⟩',
          '2401.00010 (not_in_arxiv)',
          '⟨list_item_close⟩',
          '⟨bullet_list_close⟩',
          'Remaining IDs (not looked up; pass as paper_ids in the next call): ["2401.00018"]',
        ].join('\n\n'),
      );
    }
  });

  it('fails invalid_id without a lookup when no ID is well-formed (#41)', async () => {
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const input = arxivGetMetadata.input.parse({ paper_ids: ['doi:10.1/x', '1706.03762 | cs'] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_id', ids: ['doi:10.1/x', '1706.03762 | cs'] },
    });
    expect(mockGetPapers).not.toHaveBeenCalled();
  });
});

/**
 * Per-call thread CPU of `fn`, in ms: the fastest of three samples, each
 * repeating `fn` until it has used ~20 ms of CPU.
 */
function cpuMs(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    do {
      fn();
      calls++;
      const used = process.threadCpuUsage(start);
      usedMs = (used.user + used.system) / 1000;
    } while (usedMs < 20);
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

/**
 * Assert a `paper_ids` parse stays linear on `make(size)` as `size` doubles from
 * 5k to 320k characters. Each size must meet an absolute CPU bound before the
 * next runs, so a superlinear cost fails at the first doubling it outgrows; the
 * full 64× span must cost under 256× (a quadratic costs ~4,096×).
 */
function expectLinear(make: (size: number) => string): void {
  const times: number[] = [];
  for (let size = 5_000; size <= 320_000; size *= 2) {
    const paper_ids = make(size);
    const ms = cpuMs(() => arxivGetMetadata.input.safeParse({ paper_ids }));
    expect(ms, `${size} characters took ${ms.toFixed(3)} ms`).toBeLessThan(2 + size / 2_000);
    times.push(ms);
  }
  expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
}

// The bound is thread CPU; the wall-clock timeout only has to outlast a loaded machine.
describe('arxivGetMetadata paper_ids parse cost on caller-sized input', { timeout: 30_000 }, () => {
  // A lone string is trimmed and scanned for a list separator before it is
  // wrapped or refused; both outcomes stay within the linear bound.
  it('keeps the parse of a lone string it wraps linear in input length', () => {
    const make = (size: number) => 'a'.repeat(size);
    expect(arxivGetMetadata.input.safeParse({ paper_ids: make(5_000) }).success).toBe(true);
    expectLinear(make);
  });

  it('keeps the parse of a lone string it refuses linear in input length', () => {
    const make = (size: number) => `${' \t'.repeat(size / 2)}x\n${' '.repeat(size / 2)}y`;
    expect(arxivGetMetadata.input.safeParse({ paper_ids: make(5_000) }).success).toBe(false);
    expectLinear(make);
  });
});
