/**
 * @fileoverview arxiv_read_paper tool — fetch the full HTML content of an arXiv paper.
 * @module mcp-server/tools/definitions/arxiv-read-paper
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const arxivReadPaper = tool('arxiv_read_paper', {
  description:
    'Fetch the full text of an arXiv paper as HTML, with automatic fallback if the primary source is unavailable.',
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
      when: 'Paper exists but no HTML rendering is available; only PDF.',
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
  }),

  output: z.object({
    paper_id: z.string().describe('arXiv paper ID.'),
    title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
    content: z.string().describe('Cleaned paper body HTML, truncated to max_characters.'),
    source: z
      .enum(['arxiv_html', 'ar5iv'])
      .describe('Which HTML source the content was fetched from.'),
    truncated: z.boolean().describe('Whether content was truncated due to max_characters.'),
    total_characters: z.number().describe('Character count of the original unprocessed HTML body.'),
    body_characters: z
      .number()
      .describe(
        'Character count of the cleaned body HTML — what fits into max_characters. Typically 3-4× smaller than total_characters for math-heavy papers.',
      ),
    pdf_url: z.string().describe('Direct PDF download URL.'),
    abstract_url: z.string().describe('arXiv abstract page URL for attribution.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const result = await service.readContent(input.paper_id, input.max_characters, ctx);
    ctx.log.info('Paper content fetched', {
      paperId: result.paper_id,
      source: result.source,
      truncated: result.truncated,
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
    if (result.truncated) {
      lines.push(
        `\n[Truncated: showing ${result.content.length.toLocaleString()} of ${result.body_characters.toLocaleString()} body characters]`,
      );
    }
    lines.push('', result.content);
    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
