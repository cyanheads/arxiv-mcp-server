/**
 * @fileoverview arxiv_read_paper tool — fetch the full HTML content of an arXiv paper.
 * @module mcp-server/tools/definitions/arxiv-read-paper
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const arxivReadPaper = tool('arxiv_read_paper', {
  description:
    'Fetch the full text of an arXiv paper as HTML. Tries arxiv.org/html first; falls back to ar5iv.labs.arxiv.org when the native render is unavailable. PDF-only papers (no HTML render on either source) return an html_unavailable error with the pdf_url for direct download. Page through long papers with the start and max_characters parameters.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm via arxiv_search before retrying.',
    },
    {
      reason: 'html_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper exists but neither arxiv.org/html nor ar5iv has an HTML rendering; only the PDF is available.',
      recovery: 'Use the pdf_url returned by arxiv_get_metadata to fetch the source PDF directly.',
    },
  ],

  input: z.object({
    paper_id: z
      .string()
      .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
      .describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
    max_characters: z
      .number()
      .int()
      .min(1)
      .default(100_000)
      .describe(
        'Maximum characters of paper body content to return. Defaults to 100,000. HTML head/boilerplate is stripped before counting. When truncated, a notice and total character count are included.',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the cleaned body to begin reading from. Defaults to 0. Use with max_characters to page through long papers — e.g., start=100000 with max_characters=100000 returns chars 100,000–199,999. The total length is reported as body_characters in the response.',
      ),
  }),

  output: z.object({
    paper_id: z.string().describe('arXiv paper ID.'),
    title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
    content: z
      .string()
      .describe(
        'Cleaned paper body HTML for the requested slice. Empty when start is past body_characters.',
      ),
    source: z
      .enum(['arxiv_html', 'ar5iv'])
      .describe('Which HTML source the content was fetched from.'),
    truncated: z
      .boolean()
      .describe(
        'True when more body content exists past this slice (start + content.length < body_characters).',
      ),
    start: z
      .number()
      .describe('Character offset of the first character in content within the cleaned body.'),
    total_characters: z.number().describe('Character count of the original unprocessed HTML body.'),
    body_characters: z
      .number()
      .describe(
        'Character count of the full cleaned body HTML. Use with start and max_characters to page. Typically 3-4× smaller than total_characters for math-heavy papers.',
      ),
    pdf_url: z.string().describe('Direct PDF download URL.'),
    abstract_url: z.string().describe('arXiv abstract page URL for attribution.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const result = await service.readContent(
      input.paper_id,
      { maxCharacters: input.max_characters, start: input.start },
      ctx,
    );
    ctx.log.info('Paper content fetched', {
      paperId: result.paper_id,
      source: result.source,
      truncated: result.truncated,
      start: result.start,
      characters: result.total_characters,
    });
    return result;
  },

  format: (result) => {
    const lines = [
      `# ${result.title}`,
      // Raw integer values in the header so both character counts are discoverable
      // by text-only clients (format-parity) without locale formatting interfering.
      `arXiv:${result.paper_id} | Source: ${result.source} | Raw HTML: ${result.total_characters} chars | Body: ${result.body_characters} chars${result.truncated ? ' (truncated)' : ''}`,
      `Abstract: ${result.abstract_url}`,
      `PDF: ${result.pdf_url}`,
    ];
    const sliceEnd = result.start + result.content.length;
    if (result.start >= result.body_characters && result.body_characters > 0) {
      lines.push(
        `\n[Offset ${result.start.toLocaleString()} is past end of body (${result.body_characters.toLocaleString()} characters). Use start=0 to read from the beginning.]`,
      );
    } else if (result.truncated) {
      lines.push(
        `\n[Truncated: showing chars ${result.start.toLocaleString()}–${(sliceEnd - 1).toLocaleString()} of ${result.body_characters.toLocaleString()} body characters. Call again with start=${sliceEnd} to continue.]`,
      );
    } else if (result.start > 0) {
      lines.push(
        `\n[Showing chars ${result.start.toLocaleString()}–${(sliceEnd - 1).toLocaleString()} of ${result.body_characters.toLocaleString()} body characters (final chunk).]`,
      );
    }
    lines.push('', result.content);
    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
