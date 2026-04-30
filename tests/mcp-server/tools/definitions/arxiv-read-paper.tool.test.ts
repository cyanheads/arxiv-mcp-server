/**
 * @fileoverview Tests for arxiv_read_paper tool.
 * @module mcp-server/tools/definitions/arxiv-read-paper.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import type { PaperContent } from '@/services/arxiv/types.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
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

  it('surfaces raw HTML and body character counts distinctly in the header', () => {
    const mixed: PaperContent = {
      ...MOCK_CONTENT,
      total_characters: 150_000,
      body_characters: 40_000,
    };
    const blocks = arxivReadPaper.format?.(mixed) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Raw HTML: 150000 chars');
    expect(text).toContain('Body: 40000 chars');
  });

  it('formats without truncation notice when not truncated and start=0', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Test Paper');
    expect(text).not.toContain('Truncated');
    expect(text).not.toContain('final chunk');
    expect(text).toContain('<html><body>Full paper content</body></html>');
  });

  it('renders pdf_url so the LLM can reach the PDF without inspecting structuredContent', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('PDF: https://arxiv.org/pdf/2401.12345v1');
    expect(text).toContain('Abstract: https://arxiv.org/abs/2401.12345v1');
  });
});
