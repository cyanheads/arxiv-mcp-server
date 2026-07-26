/**
 * @fileoverview arxiv_get_metadata tool — get full metadata for one or more papers by arXiv ID.
 * @module mcp-server/tools/definitions/arxiv-get-metadata
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { partialResult, partialResultSchema } from '@cyanheads/mcp-ts-core/utils';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import {
  formatPaper,
  PaperMetadataSchema,
  PaperNotFoundReasonSchema,
} from '@/services/arxiv/types.js';

const OutputSchema = partialResultSchema({
  succeededKey: 'papers',
  succeededSchema: PaperMetadataSchema,
  succeededDescription: 'Papers found. May be fewer than requested if some IDs are invalid.',
  failedKey: 'not_found',
  idKey: 'id',
  idDescription: 'arXiv ID that returned no data.',
  reason: PaperNotFoundReasonSchema,
  failureDescription: 'A requested ID that could not be returned, with the reason it was missed.',
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
    {
      reason: 'version_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every requested ID pinned a version the local mirror does not hold, and live arXiv fallback is disabled.',
      recovery:
        'Request the version named in the error detail, or drop the version suffix to get the latest.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'arXiv has throttled requests (HTTP 429 or "Rate exceeded." body).',
      retryable: true,
      recovery:
        'Wait error.data.cooldownAppliedMs milliseconds before retrying, and lower concurrent arXiv calls.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'arXiv rejected the request (HTTP 4xx other than 429), e.g. malformed ID syntax.',
      recovery: 'Verify the ID format (e.g., "2401.12345" or "2401.12345v2") and retry.',
    },
  ],

  input: z.object({
    paper_ids: z
      .union([
        z
          .string()
          .trim()
          .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
          .describe('Single arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
        z
          .array(
            z
              .string()
              .trim()
              .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").'),
          )
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
    const notFound = result.not_found ?? [];

    if (result.papers.length === 0) {
      // A version the mirror lacks is reachable upstream, so `no_match` would
      // tell the caller to doubt an ID that is in fact valid. Fail with the
      // reason that names the real constraint. See issue #35.
      if (notFound.length > 0 && notFound.every((m) => m.reason === 'version_not_in_mirror')) {
        throw ctx.fail(
          'version_unavailable',
          notFound
            .map((miss) =>
              [`'${miss.id}' could not be served.`, miss.detail].filter(Boolean).join(' '),
            )
            .join(' '),
          { ids, not_found: notFound, ...ctx.recoveryFor('version_unavailable') },
        );
      }
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
      failed: notFound,
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
