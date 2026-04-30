/**
 * @fileoverview arxiv_get_metadata tool — get full metadata for one or more papers by arXiv ID.
 * @module mcp-server/tools/definitions/arxiv-get-metadata
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { partialResult, partialResultSchema } from '@cyanheads/mcp-ts-core/utils';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { formatPaper, PaperMetadataSchema } from '@/services/arxiv/types.js';

const NotFoundReason = z.enum(['not_in_arxiv']).describe('Why the paper ID could not be returned.');

const OutputSchema = partialResultSchema({
  succeededKey: 'papers',
  succeededSchema: PaperMetadataSchema,
  succeededDescription: 'Papers found. May be fewer than requested if some IDs are invalid.',
  failedKey: 'not_found',
  idKey: 'id',
  idDescription: 'arXiv ID that returned no data.',
  reason: NotFoundReason,
  failureDescription: 'A requested ID that arXiv did not return.',
});

export const arxivGetMetadata = tool('arxiv_get_metadata', {
  description:
    'Get full metadata for one or more arXiv papers by ID. Use when you have known IDs from citations, prior search results, or memory.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested IDs returned data from arXiv.',
      recovery:
        'Verify the ID format (e.g., "2401.12345" or "2401.12345v2") and confirm the paper exists via arxiv_search.',
    },
  ],

  input: z.object({
    paper_ids: z
      .union([
        z
          .string()
          .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
          .describe('Single arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
        z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('Array of up to 10 arXiv paper IDs for batch lookup.'),
      ])
      .describe(
        'arXiv paper ID or array of up to 10 IDs. Format: "2401.12345" or "2401.12345v2" (with version). Also accepts legacy IDs like "hep-th/9901001".',
      ),
  }),

  output: OutputSchema,

  async handler(input, ctx) {
    const service = getArxivService();
    const ids = Array.isArray(input.paper_ids) ? input.paper_ids : [input.paper_ids];
    const result = await service.getPapers(ids, ctx);

    if (result.papers.length === 0) {
      throw ctx.fail('no_match', `No papers found for the given IDs.`, {
        ids,
        ...ctx.recoveryFor('no_match'),
      });
    }

    ctx.log.info('Metadata lookup completed', {
      requested: ids.length,
      found: result.papers.length,
    });

    return partialResult({
      succeededKey: 'papers' as const,
      succeeded: result.papers,
      failedKey: 'not_found' as const,
      failed: (result.not_found_ids ?? []).map((id) => ({
        id,
        reason: 'not_in_arxiv' as const,
      })),
    });
  },

  format: (result) => {
    const parts: string[] = [
      `Found ${result.totalSucceeded} of ${result.totalSucceeded + (result.not_found?.length ?? 0)} papers.`,
    ];
    if (result.papers.length > 0) {
      parts.push(result.papers.map(formatPaper).join('\n\n---\n\n'));
    }
    if (result.not_found && result.not_found.length > 0) {
      const lines = result.not_found.map((entry) =>
        entry.detail
          ? `- ${entry.id} (${entry.reason}): ${entry.detail}`
          : `- ${entry.id} (${entry.reason})`,
      );
      parts.push(`\nNot found:\n${lines.join('\n')}`);
    }
    return [{ type: 'text' as const, text: parts.join('\n\n') }];
  },
});
