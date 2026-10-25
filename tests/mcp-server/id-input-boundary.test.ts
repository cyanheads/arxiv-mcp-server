/**
 * @fileoverview Boundary guard for arXiv ID inputs (issue #26) — a whitespace-only
 * ID must be rejected by the tool/resource schema and never dispatched to the
 * rate-limited arXiv API. These cases drive the real `ArxivService` with a stubbed
 * `fetch`, so the assertion is "no upstream request happened", not merely "an
 * error was returned": if a schema stops guarding, the handler runs and the
 * stubbed fetch records the call.
 * @module mcp-server/id-input-boundary.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperResource } from '@/mcp-server/resources/definitions/paper.resource.js';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';
import { readCommonMarkText } from '../helpers/commonmark-text.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
    readTimeoutMs: 50_000,
    mirrorEnabled: false,
    mirrorPath: '',
    mirrorFallbackLive: true,
    mirrorRecentDaysLive: 0,
  }),
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  // A request no test mocked is refused rather than answered.
  mockFetch.mockImplementation(async (url) => {
    throw new Error(`Unmocked request: ${url}`);
  });
  initArxivService();
});

/**
 * Run a handler for its side effects only. A whitespace ID that slips past the
 * schema fails somewhere downstream; the upstream call it makes on the way is
 * what the surrounding assertion is looking for.
 */
async function runIgnoringFailure(invoke: () => unknown): Promise<void> {
  try {
    await invoke();
  } catch {
    // Intentionally ignored — see doc comment.
  }
}

describe('whitespace-only paper IDs never reach the arXiv API (#26)', () => {
  it('arxiv_get_metadata — scalar paper_ids', async () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: '   ' });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
        typeof arxivGetMetadata.handler
      >[1];
      await runIgnoringFailure(() => arxivGetMetadata.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv_get_metadata — array element', async () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: ['2401.12345', ' \t '] });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
        typeof arxivGetMetadata.handler
      >[1];
      await runIgnoringFailure(() => arxivGetMetadata.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv_read_paper — paper_id', async () => {
    const parsed = arxivReadPaper.input.safeParse({ paper_id: '   ', max_characters: 100 });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
        typeof arxivReadPaper.handler
      >[1];
      await runIgnoringFailure(() => arxivReadPaper.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv://paper/{paperId} — resource parameter', async () => {
    const parsed = paperResource.params!.safeParse({ paperId: '   ' });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
        typeof paperResource.handler
      >[1];
      const params = parsed.data as Parameters<typeof paperResource.handler>[0];
      await runIgnoringFailure(() => paperResource.handler(params, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv://paper/{paperId} — percent-encoded blank segment', async () => {
    // URI-template matching yields raw segment text, so `%20%20%20` is nine
    // ordinary characters to the params schema and reaches the handler. The
    // decoded blank must still stop short of arXiv.
    const params = paperResource.params!.parse({ paperId: '%20%20%20' }) as Parameters<
      typeof paperResource.handler
    >[0];
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    await runIgnoringFailure(() => paperResource.handler(params, ctx));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Paper ID normalization (#41) and batch remainder (#51)
// ---------------------------------------------------------------------------

/** arXiv's own spelling of an ID: new-style or archive/YYMMNNN, optional version. */
const CANONICAL_ID = /^(?:\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)?\/\d{7})(?:v\d+)?$/;

/**
 * Answer the way arXiv does: one entry per `id_list` member spelled the way
 * arXiv spells IDs (an unversioned ID resolves to v1), no entry for any other
 * spelling, and HTTP 400 for a batch holding a foreign identifier. Any request
 * off the API host is an HTML render of the paper.
 */
function serveArxiv(): void {
  mockFetch.mockImplementation(async (request) => {
    const url = new URL(String(request));
    if (url.hostname !== 'export.arxiv.org') {
      return new Response(
        '<html><body><article><h2 class="ltx_title ltx_title_section">1 Intro</h2><p>Body.</p></article></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    }
    const requested = (url.searchParams.get('id_list') ?? '').split(',');
    if (requested.some((id) => id.startsWith('biorxiv:') || id.startsWith('hepth/'))) {
      return new Response('<feed><entry><summary>incorrect id format</summary></entry></feed>', {
        status: 400,
        headers: { 'content-type': 'application/atom+xml' },
      });
    }
    const entries = requested
      .filter((id) => CANONICAL_ID.test(id))
      .map((id) => (/v\d+$/.test(id) ? id : `${id}v1`))
      .map(
        (id) => `<entry><id>http://arxiv.org/abs/${id}</id><title>Paper ${id}</title>
          <summary>s</summary><author><name>A</name></author>
          <published>2020-01-01T00:00:00Z</published><updated>2020-01-01T00:00:00Z</updated></entry>`,
      );
    return new Response(
      `<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
        <opensearch:totalResults>${entries.length}</opensearch:totalResults>
        <opensearch:startIndex>0</opensearch:startIndex>${entries.join('')}</feed>`,
      { headers: { 'content-type': 'application/atom+xml' } },
    );
  });
}

/** The `id_list` of every arXiv API request made so far, in order. */
function idLists(): string[] {
  return mockFetch.mock.calls
    .map(([request]) => new URL(String(request)))
    .filter((url) => url.hostname === 'export.arxiv.org')
    .map((url) => url.searchParams.get('id_list') ?? '');
}

/** Every text block of a tool result, joined — what a format-only client reads. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

type MetadataOutput = {
  papers: { id: string }[];
  not_found?: { id: string; reason: string; detail?: string }[];
  remaining_ids?: string[];
};

async function readResource(paperId: string): Promise<unknown> {
  const params = paperResource.params!.parse({ paperId }) as Parameters<
    typeof paperResource.handler
  >[0];
  const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
    typeof paperResource.handler
  >[1];
  return paperResource.handler(params, ctx);
}

describe('IDs that resolve today keep resolving with an unchanged id_list (#41)', () => {
  const regression: [input: string, resolved: string][] = [
    ['0704.0001', '0704.0001v1'],
    ['0704.0001v1', '0704.0001v1'],
    ['1706.03762', '1706.03762v1'],
    ['1706.03762v7', '1706.03762v7'],
    ['2401.12345', '2401.12345v1'],
    ['hep-th/9901001', 'hep-th/9901001v1'],
    ['math/0309136', 'math/0309136v1'],
    ['math/0309136v1', 'math/0309136v1'],
    ['cs/0001001', 'cs/0001001v1'],
    ['cond-mat/0501001', 'cond-mat/0501001v1'],
    ['q-bio/0401001', 'q-bio/0401001v1'],
    [' 1706.03762v7 ', '1706.03762v7'],
    ['\thep-th/9901001\n', 'hep-th/9901001v1'],
  ];

  for (const [input, resolved] of regression) {
    it(`${JSON.stringify(input)} on arxiv_get_metadata and arxiv://paper`, async () => {
      serveArxiv();
      const result = await runToolContract(arxivGetMetadata, { paper_ids: input } as never);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
      expect(output.papers.map((paper) => paper.id)).toEqual([resolved]);

      await expect(readResource(input)).resolves.toMatchObject({ id: resolved });
      expect(idLists()).toEqual([input.trim(), input.trim()]);
    });
  }

  it('a batch pairing a valid ID with a malformed one still returns the valid paper', async () => {
    serveArxiv();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['1706.03762', '1706.03762v7 | cs.CL'],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['1706.03762v1']);
    expect(output.not_found?.map((miss) => miss.id)).toEqual(['1706.03762v7 | cs.CL']);
  });
});

/** The `error` object a failed tool call carries on `structuredContent`. */
function errorOf(result: { structuredContent?: unknown }): Record<string, unknown> {
  const structured = result.structuredContent as { error?: Record<string, unknown> } | undefined;
  expect(structured?.error, JSON.stringify(result)).toBeDefined();
  return structured!.error!;
}

/** `count` well-formed, distinct new-style IDs. */
function wellFormedIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `2401.${String(i + 1).padStart(5, '0')}`);
}

describe('every ID surface normalizes one-reading spellings before the lookup (#41)', () => {
  const spellings: [input: string, canonical: string][] = [
    ['arXiv:1706.03762', '1706.03762'],
    ['ARXIV:1706.03762', '1706.03762'],
    ['arXiv: 1706.03762', '1706.03762'],
    ['arxiv:hep-th/9901001', 'hep-th/9901001'],
    ['math.GT/0309136', 'math/0309136'],
    ['HEP-TH/9901001', 'hep-th/9901001'],
    ['https://arxiv.org/abs/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v7.pdf', '1706.03762v7'],
  ];

  for (const [input, canonical] of spellings) {
    const resolved = /v\d+$/.test(canonical) ? canonical : `${canonical}v1`;
    it(`${input} → ${canonical} on all three surfaces`, async () => {
      serveArxiv();
      const metadata = await runToolContract(arxivGetMetadata, { paper_ids: [input] });
      expect(metadata.isError, JSON.stringify(metadata)).not.toBe(true);
      const output = arxivGetMetadata.output.parse(metadata.structuredContent) as MetadataOutput;
      expect(output.papers.map((paper) => paper.id)).toEqual([resolved]);
      expect(output.not_found).toBeUndefined();
      expect(textOf(metadata)).toContain(`arXiv:${resolved} |`);

      const read = await runToolContract(arxivReadPaper, { paper_id: input });
      expect(read.isError, JSON.stringify(read)).not.toBe(true);
      expect(arxivReadPaper.output.parse(read.structuredContent).paper_id).toBe(resolved);
      expect(textOf(read)).toContain(`arXiv:${resolved} |`);

      await expect(readResource(encodeURIComponent(input))).resolves.toMatchObject({
        id: resolved,
      });
      expect(idLists()).toEqual([canonical, canonical, canonical]);
    });
  }
});

describe('a malformed ID fails invalid_id before any upstream request (#41)', () => {
  const malformed = [
    'biorxiv:10.64898/2026.07.22.740050',
    '1706.03762v7 | cs.CL',
    'https://example.org/abs/1706.03762',
    '1706.0376',
  ];

  for (const input of malformed) {
    it(`${input} on all three surfaces`, async () => {
      serveArxiv();
      const metadata = await runToolContract(arxivGetMetadata, { paper_ids: [input] });
      expect(metadata.isError).toBe(true);
      expect(errorOf(metadata)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_id' },
      });
      // An error's text is Markdown-encoded: read it back as a CommonMark parse does.
      expect(readCommonMarkText(textOf(metadata))).toContain(input);
      expect(readCommonMarkText(textOf(metadata))).toContain('hep-th/9901001');

      const read = await runToolContract(arxivReadPaper, { paper_id: input });
      expect(read.isError).toBe(true);
      expect(errorOf(read)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_id' },
      });
      expect(readCommonMarkText(textOf(read))).toContain(input);

      await expect(readResource(encodeURIComponent(input))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_id' },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  }

  it('a batch reports the malformed ID as not_found and still looks up the rest', async () => {
    serveArxiv();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['1706.03762', 'biorxiv:10.64898/2026.07.22.740050'],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['1706.03762v1']);
    expect(output.not_found).toEqual([
      expect.objectContaining({ id: 'biorxiv:10.64898/2026.07.22.740050', reason: 'invalid_id' }),
    ]);
    expect(textOf(result)).toContain('biorxiv:10.64898/2026.07.22.740050 (invalid_id)');
    expect(idLists()).toEqual(['1706.03762']);
  });

  it('keeps not_found in input order across malformed IDs and arXiv misses', async () => {
    serveArxiv();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['bad one', 'arXiv:1706.03762', 'hep-th/9901001x', 'math.GT/0309136'],
    });
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['1706.03762v1', 'math/0309136v1']);
    expect(output.not_found?.map((miss) => [miss.id, miss.reason])).toEqual([
      ['bad one', 'invalid_id'],
      ['hep-th/9901001x', 'invalid_id'],
    ]);
  });

  it('decodes a stringified array and wraps a lone string', async () => {
    serveArxiv();
    const decoded = await runToolContract(arxivGetMetadata, {
      paper_ids: '["2303.08774","hep-th/9901001"]',
    } as never);
    expect(decoded.isError, JSON.stringify(decoded)).not.toBe(true);
    expect(
      (arxivGetMetadata.output.parse(decoded.structuredContent) as MetadataOutput).papers.map(
        (paper) => paper.id,
      ),
    ).toEqual(['2303.08774v1', 'hep-th/9901001v1']);

    const wrapped = await runToolContract(arxivGetMetadata, { paper_ids: '2303.08774' } as never);
    expect(wrapped.isError, JSON.stringify(wrapped)).not.toBe(true);
    expect(idLists()).toEqual(['2303.08774,hep-th/9901001', '2303.08774']);
  });

  it('resolves a lone string whose only line breaks sit at its edges', async () => {
    const edges: [input: string, canonical: string][] = [
      ['hep-th/9901001\n', 'hep-th/9901001'],
      ['1706.03762\r\n', '1706.03762'],
      ['\n2401.12345', '2401.12345'],
      [' arXiv:1706.03762v7 \r\n', '1706.03762v7'],
      ['\u20282401.12345\u2029', '2401.12345'],
    ];
    serveArxiv();
    for (const [input, canonical] of edges) {
      const resolved = /v\d+$/.test(canonical) ? canonical : `${canonical}v1`;
      const result = await runToolContract(arxivGetMetadata, { paper_ids: input } as never);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
      expect(output.papers.map((paper) => paper.id)).toEqual([resolved]);
      expect(textOf(result)).toContain(`arXiv:${resolved} |`);
    }
    expect(idLists()).toEqual(edges.map(([, canonical]) => canonical));
  });

  it('decodes a stringified array framed by line breaks and wraps a space-padded lone string', async () => {
    serveArxiv();
    for (const paper_ids of ['\n["2303.08774","hep-th/9901001"]\r\n', '  2303.08774  ']) {
      const result = await runToolContract(arxivGetMetadata, { paper_ids } as never);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    expect(idLists()).toEqual(['2303.08774,hep-th/9901001', '2303.08774']);
  });

  it('refuses a lone string holding a comma or an inner line break, before any fetch', async () => {
    serveArxiv();
    for (const paper_ids of [
      '2401.12345,2401.12346',
      '2401.12345\r2401.12346',
      '2401.12345\n2401.12346',
      ' 2401.12345\n2401.12346\n',
      '2401.12345\u2028x',
    ]) {
      const result = await runToolContract(arxivGetMetadata, { paper_ids } as never);
      expect(result.isError, JSON.stringify(paper_ids)).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
      expect(textOf(result)).toContain('Send paper_ids as an array, not a string.');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // A blank lone string is one empty ID, not a misshapen list: it fails with the
  // message a blank array element gets, never the send-an-array hint, so
  // following the hint with ["   "] no longer turns up a second, different error.
  it('refuses a blank lone string with the blank-element message, before any fetch', async () => {
    serveArxiv();
    const element = await runToolContract(arxivGetMetadata, { paper_ids: ['   '] });
    expect(element.isError).toBe(true);
    const elementMessage = (errorOf(element) as { message: string }).message;
    expect(elementMessage).toContain('Paper ID cannot be empty');
    for (const paper_ids of ['', '   ', '\n', ' \t\r\n']) {
      const result = await runToolContract(arxivGetMetadata, { paper_ids } as never);
      expect(result.isError, JSON.stringify(paper_ids)).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: elementMessage,
      });
      expect(textOf(result)).toContain('Paper ID cannot be empty');
      expect(textOf(result)).not.toContain('Send paper_ids as an array');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('advertises paper_ids as a plain array of strings', () => {
    const { properties } = z.toJSONSchema(arxivGetMetadata.input, { io: 'input' });
    expect(properties).toBeDefined();
    const { description, ...shape } = properties!.paper_ids as Record<string, unknown>;
    expect(shape).toEqual({
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1 },
    });
    expect(description).toEqual(expect.stringContaining('arXiv paper IDs, up to 100.'));
  });
});

describe('arxiv_get_metadata looks up the first 10 well-formed IDs and names the rest (#51)', () => {
  it('12 IDs: the first 10 are looked up, the last 2 come back in remaining_ids', async () => {
    serveArxiv();
    const ids = wellFormedIds(12);
    const result = await runToolContract(arxivGetMetadata, { paper_ids: ids });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers).toHaveLength(10);
    expect(output.remaining_ids).toEqual(ids.slice(10));
    expect(idLists()).toEqual([ids.slice(0, 10).join(',')]);
    expect(textOf(result)).toContain('Found 10 of 10 papers.');
    expect(textOf(result)).toContain(JSON.stringify(ids.slice(10)));
  });

  // The summary line counts what was looked up and says the rest are named —
  // "Found 10 of 10 papers." alone read as the whole request.
  it('25 IDs: the summary line says 10 were looked up and 15 are named below', async () => {
    serveArxiv();
    const ids = wellFormedIds(25);
    const result = await runToolContract(arxivGetMetadata, { paper_ids: ids });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.remaining_ids).toHaveLength(15);
    expect(textOf(result).split('\n')[0]).toBe(
      'Found 10 of 10 papers. Looked up the first 10 well-formed IDs; 15 more IDs are listed under Remaining IDs below.',
    );
  });

  it('a single remaining ID reads in the singular', () => {
    const text = (
      (arxivGetMetadata.format?.({
        papers: [],
        totalSucceeded: 0,
        not_found: wellFormedIds(10).map((id) => ({ id, reason: 'not_in_arxiv' as const })),
        remaining_ids: ['2401.99999'],
      }) ?? [])[0] as { text: string }
    ).text;
    expect(text.split('\n')[0]).toBe(
      'Found 0 of 10 papers. Looked up the first 10 well-formed IDs; 1 more ID is listed under Remaining IDs below.',
    );
  });

  it('100 IDs: 10 looked up, 90 remaining; 101 IDs are rejected before any fetch', async () => {
    serveArxiv();
    const ids = wellFormedIds(101);
    const hundred = await runToolContract(arxivGetMetadata, { paper_ids: ids.slice(0, 100) });
    const output = arxivGetMetadata.output.parse(hundred.structuredContent) as MetadataOutput;
    expect(output.papers).toHaveLength(10);
    expect(output.remaining_ids).toEqual(ids.slice(10, 100));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const over = await runToolContract(arxivGetMetadata, { paper_ids: ids });
    expect(over.isError).toBe(true);
    expect(errorOf(over)).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('counts only well-formed IDs toward the 10: a malformed eleventh leaves nothing remaining', async () => {
    serveArxiv();
    const ids = [...wellFormedIds(10), 'not-an-id'];
    const result = await runToolContract(arxivGetMetadata, { paper_ids: ids });
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers).toHaveLength(10);
    expect(output.remaining_ids).toBeUndefined();
    expect(output.not_found).toEqual([
      expect.objectContaining({ id: 'not-an-id', reason: 'invalid_id' }),
    ]);
    expect(textOf(result)).not.toContain('Remaining');
  });

  it('a malformed ID among the first ten is skipped, so the eleventh well-formed one is looked up', async () => {
    serveArxiv();
    const ids = wellFormedIds(12);
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: [ids[0]!, 'arXiv:bogus', ...ids.slice(1)],
    });
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(idLists()).toEqual([ids.slice(0, 10).join(',')]);
    expect(output.remaining_ids).toEqual(ids.slice(10));
    expect(output.not_found?.map((miss) => miss.id)).toEqual(['arXiv:bogus']);
  });

  it('names the remainder instead of failing when every looked-up ID misses', async () => {
    serveArxiv();
    const misses = Array.from({ length: 10 }, (_, i) => `hep-th/990100${i}`);
    mockFetch.mockImplementationOnce(
      async () =>
        new Response(
          '<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>',
          { headers: { 'content-type': 'application/atom+xml' } },
        ),
    );
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: [...misses, '2401.00001'],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers).toEqual([]);
    expect(output.not_found).toHaveLength(10);
    expect(output.remaining_ids).toEqual(['2401.00001']);
    expect(textOf(result)).toContain('Found 0 of 10 papers.');
    // One blank line between the summary and the not-found list, not two.
    expect(textOf(result)).toContain('below.\n\nNot found:\n');
    expect(textOf(result)).not.toContain('\n\n\n');
  });

  it('reports an unknown legacy archive as invalid_id and keeps it out of the id_list', async () => {
    serveArxiv();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['1706.03762', 'hepth/9901001'],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['1706.03762v1']);
    expect(output.not_found).toEqual([
      expect.objectContaining({ id: 'hepth/9901001', reason: 'invalid_id' }),
    ]);
    expect(idLists()).toEqual(['1706.03762']);
  });

  it('interleaves arXiv misses and malformed IDs in input order', async () => {
    serveArxiv();
    mockFetch.mockImplementationOnce(
      async () =>
        new Response(
          `<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
            <opensearch:totalResults>1</opensearch:totalResults>
            <entry><id>http://arxiv.org/abs/2401.00002v1</id><title>T</title><summary>s</summary>
            <author><name>A</name></author><published>2020-01-01T00:00:00Z</published>
            <updated>2020-01-01T00:00:00Z</updated></entry></feed>`,
          { headers: { 'content-type': 'application/atom+xml' } },
        ),
    );
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['2401.00001', 'bad one', '2401.00002', '2401.00003'],
    });
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['2401.00002v1']);
    expect(output.not_found?.map((miss) => [miss.id, miss.reason])).toEqual([
      ['2401.00001', 'not_in_arxiv'],
      ['bad one', 'invalid_id'],
      ['2401.00003', 'not_in_arxiv'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Superseded old-style versions arXiv answers HTTP 500 for (#53)
// ---------------------------------------------------------------------------

/** A captured arXiv API response from `tests/fixtures/arxiv-api/`. */
function capturedFeed(name: string): string {
  return readFileSync(new URL(`../fixtures/arxiv-api/${name}.xml`, import.meta.url), 'utf8');
}

/**
 * Answer the way arXiv does for `hep-th/9901001` (latest v3): HTTP 500 with its
 * internal-error feed for an `id_list` holding `v1`, otherwise the response
 * captured for that list. Anything else is refused, the paper's HTML and PDF
 * included. `onFailure` runs as the 500 is served.
 */
function serveSupersededVersion(onFailure?: () => void): void {
  mockFetch.mockImplementation(async (request) => {
    const url = new URL(String(request));
    if (url.hostname !== 'export.arxiv.org') throw new Error(`Unexpected request: ${url}`);
    const idList = url.searchParams.get('id_list') ?? '';
    if (idList.split(',').includes('hep-th/9901001v1')) {
      onFailure?.();
      return new Response(capturedFeed('http-500'), {
        status: 500,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      });
    }
    return new Response(capturedFeed(idList.replaceAll('/', '_').replaceAll(',', '+')), {
      headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
    });
  });
}

describe('a superseded old-style version arXiv answers HTTP 500 for resolves per ID (#53)', () => {
  it('arxiv_get_metadata returns the rest of the batch and names the latest version', async () => {
    serveSupersededVersion();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['1706.03762', 'hep-th/9901001v1'],
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = arxivGetMetadata.output.parse(result.structuredContent) as MetadataOutput;
    expect(output.papers.map((paper) => paper.id)).toEqual(['1706.03762v7']);
    expect(output.not_found).toEqual([
      {
        id: 'hep-th/9901001v1',
        reason: 'version_not_served',
        detail: expect.stringContaining('the latest version is v3'),
      },
    ]);
    const text = textOf(result);
    expect(text).toContain('Found 1 of 2 papers.');
    expect(text).toContain('arXiv:1706.03762v7 |');
    expect(text).toContain(
      `- hep-th/9901001v1 (version_not_served): ${output.not_found?.[0]?.detail}`,
    );
    expect(idLists()).toEqual(['1706.03762,hep-th/9901001v1', '1706.03762,hep-th/9901001']);
  });

  it('arxiv_get_metadata names the latest version in the text when such a pin misses beside an ID absent from arXiv', async () => {
    serveSupersededVersion();
    const result = await runToolContract(arxivGetMetadata, {
      paper_ids: ['hep-th/9901001v1', 'hep-th/9901001v4'],
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
    const text = textOf(result);
    expect(text).toContain('No papers found for the given IDs.');
    expect(text).toContain("'hep-th/9901001v1' could not be served.");
    expect(text).toContain('the latest version is v3');
    expect(text).toContain('https://arxiv.org/pdf/hep-th/9901001v1');
    expect(idLists()).toEqual(['hep-th/9901001v1,hep-th/9901001v4', 'hep-th/9901001']);
  });

  it('a lone pin fails version_not_served on all three surfaces, never no_match or a 500', async () => {
    serveSupersededVersion();

    const metadata = await runToolContract(arxivGetMetadata, { paper_ids: ['hep-th/9901001v1'] });
    expect(metadata.isError).toBe(true);
    const metadataError = errorOf(metadata) as { code: number; data: Record<string, unknown> };
    expect(metadataError.code).toBe(JsonRpcErrorCode.NotFound);
    expect(metadataError.data.reason).toBe('version_not_served');
    expect(metadataError.data.retryable).not.toBe(true);
    expect(textOf(metadata)).toContain('the latest version is v3');
    expect(textOf(metadata)).toContain('https://arxiv.org/pdf/hep-th/9901001v1');
    expect(textOf(metadata)).toContain('(reason version_not_served)');

    const read = await runToolContract(arxivReadPaper, { paper_id: 'hep-th/9901001v1' });
    expect(read.isError).toBe(true);
    expect(errorOf(read)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_served', pdfUrl: 'https://arxiv.org/pdf/hep-th/9901001v1' },
    });
    expect(textOf(read)).toContain('the latest version is v3');
    expect(textOf(read)).toContain('https://arxiv.org/pdf/hep-th/9901001v1');

    await expect(readResource('hep-th%2F9901001v1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_served' },
      message: expect.stringMatching(
        /the latest version is v3.*https:\/\/arxiv\.org\/pdf\/hep-th\/9901001v1/,
      ),
    });

    // Two API requests per surface, and no body fetch for the version not served.
    expect(idLists()).toEqual(Array(3).fill(['hep-th/9901001v1', 'hep-th/9901001']).flat());
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('arxiv_get_metadata reports a call cancelled at the 500 as cancelled on both surfaces', async () => {
    const controller = new AbortController();
    serveSupersededVersion(() =>
      controller.abort(new DOMException('The client cancelled the call.', 'AbortError')),
    );
    const result = await runToolContract(
      arxivGetMetadata,
      { paper_ids: ['1706.03762', 'hep-th/9901001v1'] },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    const error = errorOf(result) as { code: number; message: string };
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.message).toBe('The client cancelled the call.');
    expect(textOf(result)).toContain('The client cancelled the call.');
    expect(textOf(result)).not.toContain('1706.03762v7');
    expect(idLists()).toEqual(['1706.03762,hep-th/9901001v1']);
  });
});
