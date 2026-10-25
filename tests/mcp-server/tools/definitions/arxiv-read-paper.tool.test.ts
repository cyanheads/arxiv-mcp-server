/**
 * @fileoverview Tests for arxiv_read_paper tool.
 * @module mcp-server/tools/definitions/arxiv-read-paper.test
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  JsonRpcErrorCode,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import type { PaperContent } from '@/services/arxiv/types.js';
import {
  COMMONMARK_PRESETS,
  readCommonMarkFences,
  readCommonMarkText,
} from '../../../helpers/commonmark-text.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

// Read by the real service the fixture-body cases construct; mirror off, no pacing.
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

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_CONTENT: PaperContent = {
  paper_id: '2401.12345v1',
  title: 'Test Paper',
  content: '<html><body>Full paper content</body></html>',
  source: 'arxiv_html',
  truncated: false,
  start: 0,
  total_characters: 44,
  body_characters: 44,
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const mockReadContent = vi.fn<() => Promise<PaperContent>>();

beforeEach(() => {
  mockReadContent.mockReset();
  vi.mocked(getArxivService).mockReturnValue({ readContent: mockReadContent } as any);
});

describe('arxivReadPaper', () => {
  it('calls service.readContent and returns result', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 5000 });
    const result = await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 5000, start: 0 },
      ctx,
    );
    expect(result.paper_id).toBe('2401.12345v1');
    expect(result.source).toBe('arxiv_html');
  });

  it('passes start offset through to the service', async () => {
    mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, start: 100_000 });
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({
      paper_id: '2401.12345',
      max_characters: 100_000,
      start: 100_000,
    });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 100_000, start: 100_000 },
      ctx,
    );
  });

  it('formats with truncation notice including slice range and next-start hint', () => {
    const truncated: PaperContent = {
      ...MOCK_CONTENT,
      content: 'x'.repeat(20_000),
      truncated: true,
      start: 0,
      total_characters: 150_000,
      body_characters: 50_000,
    };
    const blocks = arxivReadPaper.format?.(truncated) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Test Paper');
    expect(text).toContain('[Truncated:');
    expect(text).toContain('50,000 body characters');
    expect(text).toContain('chars 0–19,999');
    expect(text).toContain('start=20000');
  });

  it('formats with mid-paper slice notice when start > 0 and truncated', () => {
    const slice: PaperContent = {
      ...MOCK_CONTENT,
      content: 'y'.repeat(10_000),
      truncated: true,
      start: 100_000,
      body_characters: 250_000,
    };
    const blocks = arxivReadPaper.format?.(slice) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('chars 100,000–109,999');
    expect(text).toContain('start=110000');
  });

  it('formats final-chunk notice when start > 0 and not truncated', () => {
    const finalChunk: PaperContent = {
      ...MOCK_CONTENT,
      content: 'z'.repeat(50_000),
      truncated: false,
      start: 200_000,
      body_characters: 250_000,
    };
    const blocks = arxivReadPaper.format?.(finalChunk) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('final chunk');
    expect(text).toContain('chars 200,000–249,999');
    expect(text).not.toContain('Truncated:');
  });

  it('formats past-end notice when start exceeds body_characters', () => {
    const pastEnd: PaperContent = {
      ...MOCK_CONTENT,
      content: '',
      truncated: false,
      start: 999_999,
      body_characters: 50_000,
    };
    const blocks = arxivReadPaper.format?.(pastEnd) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('past end of body');
    expect(text).toContain('999,999');
    expect(text).toContain('start=0');
  });

  it('surfaces raw and cleaned body character counts distinctly in the header', () => {
    const mixed: PaperContent = {
      ...MOCK_CONTENT,
      total_characters: 150_000,
      body_characters: 40_000,
    };
    const blocks = arxivReadPaper.format?.(mixed) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Raw: 150000 chars');
    expect(text).toContain('Body: 40000 chars');
  });

  it('passes max_characters: null through as an unbounded read (#24)', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: null });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: null, start: 0 },
      ctx,
    );
  });

  it('defaults max_characters to 100,000 when omitted (#24)', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345' });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 100_000, start: 0 },
      ctx,
    );
  });

  it('flags PDF-extracted content with its fidelity caveat in the text block (#23)', () => {
    const pdfText: PaperContent = {
      ...MOCK_CONTENT,
      content: 'Chip-Scale Rydberg Atomic Electrometer',
      source: 'pdf_text',
    };
    const blocks = arxivReadPaper.format?.(pdfText) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Source: pdf_text');
    expect(text).toContain('Extracted from the PDF');
    expect(text).toContain('flattened');
  });

  it('omits the PDF caveat for HTML sources (#23)', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Extracted from the PDF');
  });

  it('advertises pdf_text in the source output enum (#23)', () => {
    expect(arxivReadPaper.output.shape.source.options).toEqual(['arxiv_html', 'ar5iv', 'pdf_text']);
  });

  it('formats without truncation notice when not truncated and start=0', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Test Paper');
    expect(text).not.toContain('Truncated');
    expect(text).not.toContain('final chunk');
    expect(text).toContain('<html><body>Full paper content</body></html>');
  });

  // -------------------------------------------------------------------------
  // Section outline (#44)
  // -------------------------------------------------------------------------

  const OUTLINED: PaperContent = {
    ...MOCK_CONTENT,
    outline: [
      { level: 1, title: '1 Introduction', start: 5912 },
      { level: 2, title: '3.1 Encoder and Decoder Stacks', start: 12593 },
      { level: 4, title: 'Encoder:', start: 12701 },
      { level: 1, title: 'References', start: 50002 },
    ],
  };

  it('carries the outline through the output schema', () => {
    const parsed = arxivReadPaper.output.parse({ ...OUTLINED, outline_omitted_levels: [3] });

    expect(parsed.outline).toEqual(OUTLINED.outline);
    expect(parsed.outline_omitted_levels).toEqual([3]);
    expect(arxivReadPaper.output.parse(MOCK_CONTENT)).not.toHaveProperty('outline');
  });

  const formatText = (result: PaperContent) =>
    ((arxivReadPaper.format?.(result) ?? [])[0] as { text: string }).text;

  it('renders each outline entry with its level and start, nested under the heading above it', () => {
    const text = formatText(OUTLINED);

    expect(text).toContain("Outline (pass an entry's start to read from that heading):");
    expect(text).toContain('\n- 1 Introduction (level 1, start=5912)\n');
    expect(text).toContain('\n  - 3.1 Encoder and Decoder Stacks (level 2, start=12593)\n');
    expect(text).toContain('\n    - Encoder: (level 4, start=12701)\n');
    expect(text).toContain('\n- References (level 1, start=50002)\n');
    expect(text.indexOf('Outline')).toBeLessThan(text.indexOf(MOCK_CONTENT.content));
  });

  // Indenting by level number put a level 4 after a level 1 six columns in:
  // past its parent's content, so CommonMark read it as that entry's text (#87).
  it('keeps each entry its own list item across a jump of several levels', () => {
    const outline = [
      { level: 1, title: '7 Conclusion', start: 41_289 },
      { level: 4, title: 'Acknowledgements', start: 42_627 },
      { level: 4, title: 'Funding', start: 42_700 },
      { level: 2, title: '7.1 Limits', start: 42_800 },
      { level: 1, title: 'References', start: 42_881 },
    ];
    const text = formatText({ ...MOCK_CONTENT, outline });

    expect(text).toContain(
      '\n- 7 Conclusion (level 1, start=41289)\n  - Acknowledgements (level 4, start=42627)\n  - Funding (level 4, start=42700)\n  - 7.1 Limits (level 2, start=42800)\n- References (level 1, start=42881)\n',
    );
    for (const preset of COMMONMARK_PRESETS) {
      const readout = readCommonMarkText(text, preset);
      expect(readout.match(/⟨list_item_open⟩/g), preset).toHaveLength(outline.length);
      expect(inlineRuns(readout).slice(-outline.length), preset).toEqual(
        outline.map((e) => `${e.title} (level ${e.level}, start=${e.start})`),
      );
    }
  });

  it('indents from the shallowest level present', () => {
    const text = formatText({
      ...MOCK_CONTENT,
      outline: [
        { level: 2, title: 'A', start: 1 },
        { level: 3, title: 'A.1', start: 2 },
      ],
    });

    expect(text).toContain('\n- A (level 2, start=1)\n  - A.1 (level 3, start=2)');
  });

  it('says which heading levels were left out of a capped outline', () => {
    const text = formatText({ ...OUTLINED, outline_omitted_levels: [4, 3] });

    expect(text).toContain(
      '[Outline capped at 200 entries: level 3 and level 4 headings omitted. Page through the body to reach them.]',
    );
  });

  // A single level over 200 entries is cut, not dropped; both surfaces name the
  // start that reads on past the cut.
  it('discloses a cut single-level outline through structuredContent and content[]', async () => {
    const outline = Array.from({ length: 200 }, (_, i) => ({
      level: 1,
      title: `${i + 1} Part`,
      start: 100 + i * 50,
    }));
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      outline,
      outline_continues_at: 10_100,
    });
    const result = await runToolContract(arxivReadPaper, { paper_id: '2401.12345' });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = result.structuredContent as {
      outline: unknown[];
      outline_continues_at: number;
    };
    expect(structured.outline).toHaveLength(200);
    expect(structured.outline_continues_at).toBe(10_100);
    expect(structured).not.toHaveProperty('outline_omitted_levels');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(
      '[Outline cut at 200 entries: more level 1 headings follow. Read on with start=10100 to reach them.]',
    );
    // The notice is a paragraph of its own: a line right after the last item
    // would read as that item's text (#87).
    const runs = inlineRuns(readCommonMarkText(text));
    expect(runs.slice(-2)).toEqual([
      '200 Part (level 1, start=10050)',
      '[Outline cut at 200 entries: more level 1 headings follow. Read on with start=10100 to reach them.]',
    ]);
  });

  it('renders no cut line when the outline was not cut', () => {
    expect(formatText(OUTLINED)).not.toContain('Outline cut');
  });

  it('renders "Outline: none" for an empty outline', () => {
    const text = formatText({ ...MOCK_CONTENT, source: 'pdf_text', outline: [] });

    expect(text).toContain('\nOutline: none\n');
  });

  it('renders no outline lines when the outline was not returned', () => {
    expect(formatText({ ...MOCK_CONTENT, start: 100 })).not.toContain('Outline');
  });

  it('names the outline-then-start chain in the tool and start descriptions', () => {
    expect(arxivReadPaper.description).toContain('outline from the first page');
    expect(arxivReadPaper.input.shape.start.description).toContain("outline entry's start");
  });

  it('renders pdf_url so the LLM can reach the PDF without inspecting structuredContent', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(
      'Abstract: [https://arxiv.org/abs/2401.12345v1](<https://arxiv.org/abs/2401.12345v1>)\nPDF: [https://arxiv.org/pdf/2401.12345v1](<https://arxiv.org/pdf/2401.12345v1>)',
    );
  });

  // -------------------------------------------------------------------------
  // ar5iv keeps one render per paper (#63)
  // -------------------------------------------------------------------------

  const AR5IV_UNCONFIRMED: PaperContent = {
    ...MOCK_CONTENT,
    paper_id: '2411.15218v2',
    source: 'ar5iv',
    pdf_url: 'https://arxiv.org/pdf/2411.15218v2',
    abstract_url: 'https://arxiv.org/abs/2411.15218v2',
    revision_unconfirmed: true,
  };

  const NOTICE =
    '[Revision unconfirmed: ar5iv keeps one render per paper, so this body may be another revision than arXiv:2411.15218v2. The PDF at [https://arxiv.org/pdf/2411.15218v2](<https://arxiv.org/pdf/2411.15218v2>) is exactly arXiv:2411.15218v2.]';

  it('discloses an unconfirmed ar5iv revision through structuredContent and content[]', async () => {
    mockReadContent.mockResolvedValue(AR5IV_UNCONFIRMED);
    const result = await runToolContract(arxivReadPaper, { paper_id: '2411.15218v2' });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = result.structuredContent as { revision_unconfirmed?: boolean };
    expect(structured.revision_unconfirmed).toBe(true);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(NOTICE);
    expect(text.indexOf(NOTICE)).toBeLessThan(text.indexOf(AR5IV_UNCONFIRMED.content));
  });

  it('carries no flag and no notice when the service sets none', async () => {
    for (const source of ['arxiv_html', 'ar5iv', 'pdf_text'] as const) {
      mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, source });
      const result = await runToolContract(arxivReadPaper, { paper_id: '2401.12345' });

      expect(result.structuredContent, source).not.toHaveProperty('revision_unconfirmed');
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text, source).not.toContain('Revision unconfirmed');
    }
  });

  it('declares the flag as present-or-absent, never false', () => {
    const shape = arxivReadPaper.output.shape;
    expect(shape.revision_unconfirmed.safeParse(true).success).toBe(true);
    expect(shape.revision_unconfirmed.safeParse(undefined).success).toBe(true);
    expect(shape.revision_unconfirmed.safeParse(false).success).toBe(false);
    expect(shape.revision_unconfirmed.description).toContain(
      'pdf_url is exactly the paper_id revision',
    );
    expect(shape.source.description).toContain('ar5iv keeps one render per paper');
  });

  it('puts the version_not_served recovery on both surfaces, as a failure not to retry (#53)', async () => {
    mockReadContent.mockRejectedValue(
      notFound(
        "Paper 'hep-th/9901001v1' could not be served. arXiv's API answered HTTP 500 for the lookup holding this version; the latest version is v3.",
        {
          paperId: 'hep-th/9901001v1',
          pdfUrl: 'https://arxiv.org/pdf/hep-th/9901001v1',
          reason: 'version_not_served',
        },
      ),
    );
    const result = await runToolContract(arxivReadPaper, { paper_id: 'hep-th/9901001v1' });

    expect(result.isError).toBe(true);
    const contract = arxivReadPaper.errors?.find((e) => e.reason === 'version_not_served');
    expect(contract).toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(contract).not.toHaveProperty('retryable', true);
    const error = (
      result.structuredContent as {
        error: {
          code: number;
          data: { pdfUrl?: string; recovery?: { hint: string }; retryable?: boolean };
        };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.recovery?.hint).toBe(contract?.recovery);
    expect(error.data.retryable).not.toBe(true);
    // The recovery sends the caller to error.data.pdfUrl, so that field must arrive.
    expect(contract?.recovery).toContain('error.data.pdfUrl');
    expect(error.data.pdfUrl).toBe('https://arxiv.org/pdf/hep-th/9901001v1');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('the latest version is v3');
    expect(text).toContain(contract?.recovery ?? '<missing>');
  });

  it('passes a live outage through as itself on both surfaces, with no not-found guidance (#68)', async () => {
    mockReadContent.mockRejectedValue(
      serviceUnavailable('arXiv API returned HTTP 503 (failed after 2 attempts)', {
        url: 'https://export.arxiv.org/api/query?id_list=0704.0001v1&max_results=1',
        status: 503,
        body: '<feed/>',
      }),
    );
    const result = await runToolContract(arxivReadPaper, { paper_id: '0704.0001v1' });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data: { reason?: string; status?: number } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('arXiv API returned HTTP 503 (failed after 2 attempts)');
    expect(error.data).toMatchObject({ status: 503 });
    expect(error.data).not.toHaveProperty('reason');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('arXiv API returned HTTP 503 (failed after 2 attempts)');
    for (const contract of arxivReadPaper.errors ?? []) {
      expect(text).not.toContain(contract.recovery);
    }
  });

  it('passes a read that ran out of time through as a retryable Timeout on both surfaces (#69)', async () => {
    const message =
      "Reading arXiv paper '2401.12345' timed out after 50000ms; the request to arXiv PDF was still open.";
    mockReadContent.mockRejectedValue(
      timeout(message, { paperId: '2401.12345', timeoutMs: 50_000 }),
    );
    const result = await runToolContract(arxivReadPaper, { paper_id: '2401.12345' });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data: { reason?: string; timeoutMs?: number } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(message);
    expect(error.data).toMatchObject({ paperId: '2401.12345', timeoutMs: 50_000 });
    expect(error.data).not.toHaveProperty('reason');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(message);
    expect(text).not.toContain('not retryable');
    for (const contract of arxivReadPaper.errors ?? []) {
      expect(text).not.toContain(contract.recovery);
    }
  });
});

// ---------------------------------------------------------------------------
// content[] reads back as structuredContent carries it (#87): the title and
// outline titles escaped, the body in a fence whose literal is the body itself
// ---------------------------------------------------------------------------

/** The one text block of a successful call. */
async function readText(input: Parameters<typeof runToolContract<typeof arxivReadPaper>>[1]) {
  const result = await runToolContract(arxivReadPaper, input);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  return {
    structured: result.structuredContent as PaperContent,
    text: block?.type === 'text' ? block.text : '',
  };
}

/** The inline runs a parse reads, in order, leaving out the block markers between them. */
const inlineRuns = (readout: string) =>
  readout.split('\n\n').filter((part) => !/^⟨[a-z_]+(?::[^⟩]*)?⟩$/.test(part));

// escapeMarkdownInline's own value table lives in mcp-ts-core; these rows are
// headingText()'s branch sides: no trailing # run, and a run set off by a space
// or a tab (a closing sequence) or by nothing (text).
describe('arxivReadPaper — the header title reads back as written (#87)', () => {
  it.each([
    ['<Fe>', 'Hb, <Fe>, and Mg2'],
    // An ATX heading strips a trailing run of # after a space or tab as its closing sequence.
    ['a closing # run', 'Programming in C #'],
    ['a closing ## run', 'Ends on ##'],
    ['a closing # run after a tab', 'Ends on\t#'],
    ['a lone #', '#'],
  ])('%s', async (_name, title) => {
    mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, title });
    const { structured, text } = await readText({ paper_id: '2401.12345' });

    expect(structured.title).toBe(title);
    const heading = `⟨heading_open⟩\n\n${title}\n\n⟨heading_close⟩\n\n`;
    for (const preset of COMMONMARK_PRESETS) {
      expect(readCommonMarkText(text, preset).slice(0, heading.length), preset).toBe(heading);
    }
  });

  it('reads the whole page as its fields: heading, header lines, notices, outline, body fence', async () => {
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      title: 'Sgr A* and <Fe>',
      source: 'ar5iv',
      revision_unconfirmed: true,
      outline: [{ level: 1, title: '1. Go Somewhere (33.0%)', start: 5 }],
    });
    const { text } = await readText({ paper_id: '2401.12345' });

    expect(readCommonMarkText(text)).toBe(
      [
        '⟨heading_open⟩',
        'Sgr A* and <Fe>',
        '⟨heading_close⟩',
        'arXiv:2401.12345v1 | Source: ar5iv | Raw: 44 chars | Body: 44 chars\nAbstract: ⟨a href=https://arxiv.org/abs/2401.12345v1⟩https://arxiv.org/abs/2401.12345v1⟨/a⟩\nPDF: ⟨a href=https://arxiv.org/pdf/2401.12345v1⟩https://arxiv.org/pdf/2401.12345v1⟨/a⟩',
        '[Revision unconfirmed: ar5iv keeps one render per paper, so this body may be another revision than arXiv:2401.12345v1. The PDF at ⟨a href=https://arxiv.org/pdf/2401.12345v1⟩https://arxiv.org/pdf/2401.12345v1⟨/a⟩ is exactly arXiv:2401.12345v1.]',
        "Outline (pass an entry's start to read from that heading):",
        '⟨bullet_list_open⟩',
        '⟨list_item_open⟩',
        '1. Go Somewhere (33.0%) (level 1, start=5)',
        '⟨list_item_close⟩',
        '⟨bullet_list_close⟩',
        '⟨fence:html⟩',
      ].join('\n\n'),
    );
    expect(readCommonMarkFences(text)).toEqual([
      { info: 'html', literal: '<html><body>Full paper content</body></html>\n' },
    ]);
  });
});

describe('arxivReadPaper — outline titles read back as written (#87)', () => {
  // One title per kind of syntax a list item's text could open: an ordered and
  // a bullet marker (a nested list), and inline markup.
  const titles = ['1. Go Somewhere (33.0%)', '- Dash opening', '<b>Bold</b> *star* [x](y) `code`'];

  it('renders each title as one list item, nested by level, reading back as its title', async () => {
    const outline = titles.map((title, i) => ({ level: 1 + (i % 3), title, start: 100 * i }));
    mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, outline });
    const { structured, text } = await readText({ paper_id: '2401.12345' });

    expect(structured.outline).toEqual(outline);
    for (const preset of COMMONMARK_PRESETS) {
      const readout = readCommonMarkText(text, preset);
      expect(readout.match(/⟨list_item_open⟩/g), preset).toHaveLength(titles.length);
      const runs = inlineRuns(readout);
      const first = runs.indexOf("Outline (pass an entry's start to read from that heading):");
      expect(runs.slice(first + 1), preset).toEqual(
        outline.map((e) => `${e.title} (level ${e.level}, start=${e.start})`),
      );
    }
  });
});

/** Assert `text` carries `content` as its one fence, last in the page, read under both presets. */
function expectFencedBody(text: string, content: string, info: 'html' | 'text' = 'html'): void {
  for (const preset of COMMONMARK_PRESETS) {
    // A fence's literal holds every content line plus the line end before the closing fence.
    expect(readCommonMarkFences(text, preset), preset).toEqual([{ info, literal: `${content}\n` }]);
    expect(readCommonMarkText(text, preset).endsWith(`⟨fence:${info}⟩`), preset).toBe(true);
  }
}

describe('arxivReadPaper — the body reads back byte-for-byte from its fence (#87)', () => {
  // Fence sizing past the longest backtick run is markdown().codeBlock's, tabled in mcp-ts-core.
  it.each([
    [
      'leading indentation and blank lines that would end an HTML block',
      '    <div>\n<p>a</p>\n\n    </span>\n\n<span>b</span>\n</div>',
    ],
    [
      'a run of three backticks and fence-shaped lines',
      '<p>a ``` b</p>\n```html\n~~~\nnot a fence',
    ],
    ['a final line end', '<p>end</p>\n'],
  ])('an HTML body with %s', async (_name, content) => {
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      content,
      total_characters: content.length,
      body_characters: content.length,
    });
    const { structured, text } = await readText({ paper_id: '2401.12345' });

    expect(structured.content).toBe(content);
    expectFencedBody(text, content, 'html');
  });

  it('labels a pdf_text body as text', async () => {
    const content = '> not a quote\n\n# not a heading\n\n1. not a list ``` x';
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      source: 'pdf_text',
      content,
      outline: [],
    });
    const { text } = await readText({ paper_id: '2401.12345' });

    expectFencedBody(text, content, 'text');
  });

  it('fences every page of a sliced body, a backtick run cut across pages included', async () => {
    const body = 'a``b```c````d\n\n    e```\n```\nf'.repeat(3);
    const pageSize = 7;
    for (let start = 0; start < body.length; start += pageSize) {
      const content = body.slice(start, start + pageSize);
      mockReadContent.mockResolvedValue({
        ...MOCK_CONTENT,
        content,
        start,
        truncated: start + pageSize < body.length,
        total_characters: body.length,
        body_characters: body.length,
      });
      const { structured, text } = await readText({ paper_id: '2401.12345', start });

      expect(structured.start).toBe(start);
      expectFencedBody(text, content, 'html');
    }
  });

  it('emits no fence for a slice past the end, after the past-end notice', async () => {
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      content: '',
      start: 999,
      body_characters: 44,
    });
    const { text } = await readText({ paper_id: '2401.12345', start: 999 });

    for (const preset of COMMONMARK_PRESETS) {
      expect(readCommonMarkFences(text, preset), preset).toEqual([]);
      expect(readCommonMarkText(text, preset), preset).toMatch(
        /\[Offset 999 is past end of body \(44 characters\)\. Use start=0 to read from the beginning\.\]$/,
      );
    }
  });

  it('emits no fence for an empty body', async () => {
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      content: '',
      total_characters: 0,
      body_characters: 0,
    });
    const { text } = await readText({ paper_id: '2401.12345' });

    expect(readCommonMarkFences(text)).toEqual([]);
    expect(
      readCommonMarkText(text).endsWith(
        'PDF: ⟨a href=https://arxiv.org/pdf/2401.12345v1⟩https://arxiv.org/pdf/2401.12345v1⟨/a⟩',
      ),
    ).toBe(true);
  });
});

describe('arxivReadPaper — corpus bodies read back whole and page by page (#87)', () => {
  /**
   * The real service reading the `tests/corpus/render/<dir>` fixture: its rung
   * (arxiv.org/html or ar5iv) answers with the stored page, every other page
   * request with a 404.
   */
  async function serveCorpusFixture(dir: string): Promise<{ paperId: string }> {
    const fixture = new URL(`../../../corpus/render/${dir}/`, import.meta.url);
    const meta = JSON.parse(readFileSync(new URL('meta.json', fixture), 'utf8')) as {
      paperId: string;
      rung: 'arxiv_html' | 'ar5iv';
    };
    const html = gunzipSync(readFileSync(new URL('source.html.gz', fixture))).toString('utf8');
    vi.stubGlobal('fetch', async (url: string) => {
      const { host, pathname } = new URL(String(url));
      if (pathname.includes('/api/query')) {
        return new Response(
          `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/${meta.paperId}</id><title>Captured &lt;Fe&gt; [x](n) *body*</title><summary>x</summary><author><name>X</name></author><published>2024-01-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated></entry></feed>`,
          { status: 200, headers: { 'content-type': 'application/atom+xml' } },
        );
      }
      const serves =
        meta.rung === 'ar5iv'
          ? host.startsWith('ar5iv.')
          : host === 'arxiv.org' && pathname.startsWith('/html/');
      return serves
        ? new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('Not Found', { status: 404 });
    });
    const { ArxivService } = await vi.importActual<
      typeof import('@/services/arxiv/arxiv-service.js')
    >('@/services/arxiv/arxiv-service.js');
    vi.mocked(getArxivService).mockReturnValue(new ArxivService());
    return { paperId: meta.paperId };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    // Each fixture's body length, page count, outline, and omitted levels are
    // pinned by its tests/corpus expected.json; these columns size the reads
    // below so none passes on an empty outline or a single page.
    {
      // 801 blank lines (each would end a raw HTML block), 5 pages at 100k, and
      // 276 headings capped at 200 by dropping level 3.
      dir: 'arxiv-2409.09856v3',
      source: 'arxiv_html',
      outlineEntries: 57,
      omittedLevels: [3],
      pages: 5,
      hazard: /\n\n/,
    },
    {
      // Numbered outline titles ("1. …") that would open nested ordered lists.
      dir: 'arxiv-2405.03599v3',
      source: 'arxiv_html',
      outlineEntries: 183,
      omittedLevels: undefined,
      pages: 4,
      hazard: /^\d+[.)] /,
    },
    {
      // An ar5iv body whose outline steps from level 1 to level 3.
      dir: 'ar5iv-1906.00591',
      source: 'ar5iv',
      outlineEntries: 15,
      omittedLevels: undefined,
      pages: 1,
      hazard: /\n\n/,
    },
  ])('$dir', async (row) => {
    const { dir, source, outlineEntries, omittedLevels, pages, hazard } = row;
    const { paperId } = await serveCorpusFixture(dir);
    const whole = await readText({ paper_id: paperId, max_characters: null });
    expect(whole.structured.source).toBe(source);
    expect(whole.structured.outline_omitted_levels).toEqual(omittedLevels);
    expect(
      [whole.structured.content, ...(whole.structured.outline ?? []).map((e) => e.title)].some(
        (text) => hazard.test(text),
      ),
    ).toBe(true);
    expectFencedBody(whole.text, whole.structured.content);

    const outline = whole.structured.outline ?? [];
    expect(outline).toHaveLength(outlineEntries);
    for (const preset of COMMONMARK_PRESETS) {
      const readout = readCommonMarkText(whole.text, preset);
      const runs = inlineRuns(readout);
      expect(runs[0], preset).toBe('Captured <Fe> [x](n) *body*');
      expect(readout.match(/⟨list_item_open⟩/g), preset).toHaveLength(outlineEntries);
      const first = runs.indexOf("Outline (pass an entry's start to read from that heading):");
      expect(runs.slice(first + 1), preset).toEqual([
        ...outline.map((e) => `${e.title} (level ${e.level}, start=${e.start})`),
        ...(omittedLevels
          ? [
              `[Outline capped at 200 entries: level ${omittedLevels.join(' and level ')} headings omitted. Page through the body to reach them.]`,
            ]
          : []),
      ]);
    }

    const contents: string[] = [];
    for (let start = 0; ; start += 100_000) {
      const page = await readText({ paper_id: paperId, start, max_characters: 100_000 });
      expectFencedBody(page.text, page.structured.content);
      contents.push(page.structured.content);
      if (!page.structured.truncated) break;
    }
    expect(contents).toHaveLength(pages);
    expect(contents.join('')).toBe(whole.structured.content);
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

// The bound is thread CPU; the wall-clock timeout only has to outlast a loaded machine.
describe('arxivReadPaper header title cost on upstream-sized titles (#87)', {
  timeout: 60_000,
}, () => {
  /**
   * Format a page whose title is `make(size)` as `size` doubles from 5k to
   * 320k characters. Each size meets an absolute CPU bound before the next
   * runs, so a superlinear cost fails at the first doubling it outgrows; the
   * full 64× span must cost under 256× (a quadratic costs ~4,096×).
   */
  function expectLinear(make: (size: number) => string): void {
    const times: number[] = [];
    for (let size = 5_000; size <= 320_000; size *= 2) {
      const page = { ...MOCK_CONTENT, title: make(size) };
      const ms = cpuMs(() => arxivReadPaper.format?.(page));
      expect(ms, `${size} characters took ${ms.toFixed(3)} ms`).toBeLessThan(2 + size / 1_000);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  }

  it.each<[string, (size: number) => string]>([
    // The closing-run scan walks back over every trailing #.
    ['a title ending in one long # run', (size) => `a ${'#'.repeat(size - 2)}`],
    ['a title of many short # runs', (size) => ' #a'.repeat(size / 3)],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
  ])('stays linear on %s', (_shape, make) => {
    expectLinear(make);
  });
});
