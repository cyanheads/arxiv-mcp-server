/**
 * @fileoverview arxiv_get_metadata tool — get full metadata for one or more papers by arXiv ID.
 * @module mcp-server/tools/definitions/arxiv-get-metadata
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { formatPaper, PaperMetadataSchema } from '@/services/arxiv/types.js';

export const arxivGetMetadata = tool('arxiv_get_metadata', {
  description:
    'Get full metadata for one or more arXiv papers by ID. Use when you have known IDs from citations, prior search results, or memory.',
  annotations: { readOnlyHint: true },

  input: z.object({
    paper_ids: z
      .union([z.string(), z.array(z.string()).min(1).max(10)])
      .describe(
        'arXiv paper ID or array of up to 10 IDs. Format: "2401.12345" or "2401.12345v2" (with version). Also accepts legacy IDs like "hep-th/9901001".',
      ),
  }),

  output: z.object({
    papers: z
      .array(PaperMetadataSchema)
      .describe('Papers found. May be fewer than requested if some IDs are invalid.'),
    not_found: z.array(z.string()).optional().describe('Paper IDs that returned no results.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const ids = Array.isArray(input.paper_ids) ? input.paper_ids : [input.paper_ids];
    const result = await service.getPapers(ids, ctx);

    if (result.papers.length === 0) {
      throw notFound(
        `No papers found for the given IDs. Verify ID format (e.g., '2401.12345' or '2401.12345v2').`,
        { ids },
      );
    }

    ctx.log.info('Metadata lookup completed', {
      requested: ids.length,
      found: result.papers.length,
    });
    return result;
  },

  format: (result) => {
    const parts: string[] = [];
    if (result.papers.length > 0) {
      parts.push(result.papers.map(formatPaper).join('\n\n---\n\n'));
    }
    if (result.not_found && result.not_found.length > 0) {
      parts.push(`\nNot found: ${result.not_found.join(', ')}`);
    }
    return [{ type: 'text' as const, text: parts.join('\n') }];
  },
});
