/**
 * @fileoverview arxiv_read_paper tool — fetch the full HTML content of an arXiv paper.
 * @module mcp-server/tools/definitions/arxiv-read-paper
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const arxivReadPaper = tool('arxiv_read_paper', {
  description:
    'Fetch the full text content of an arXiv paper from its HTML rendering. Tries native arXiv HTML first, falls back to ar5iv. Returns raw HTML for direct interpretation.',
  annotations: { readOnlyHint: true },

  input: z.object({
    paper_id: z.string().describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
    max_characters: z
      .number()
      .optional()
      .describe(
        'Maximum characters of content to return. Raw HTML can be 500KB-3MB+ for math-heavy papers. Recommended: set a limit based on your context budget. When truncated, a notice and total character count are included.',
      ),
  }),

  output: z.object({
    paper_id: z.string().describe('arXiv paper ID.'),
    title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
    content: z.string().describe('Raw HTML content of the paper.'),
    source: z
      .enum(['arxiv_html', 'ar5iv'])
      .describe('Which HTML source the content was fetched from.'),
    truncated: z.boolean().describe('Whether content was truncated due to max_characters.'),
    total_characters: z
      .number()
      .describe('Total character count of the full (untruncated) content.'),
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
      `arXiv:${result.paper_id} | Source: ${result.source}`,
      result.abstract_url,
    ];
    if (result.truncated) {
      lines.push(
        `\n[Truncated: showing ${result.content.length.toLocaleString()} of ${result.total_characters.toLocaleString()} characters]`,
      );
    }
    lines.push('', result.content);
    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
