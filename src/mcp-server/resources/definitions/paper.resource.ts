/**
 * @fileoverview arxiv://paper/{paperId} resource — paper metadata by arXiv ID.
 * @module mcp-server/resources/definitions/paper
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const paperResource = resource('arxiv://paper/{paperId}', {
  name: 'arXiv Paper Metadata',
  description: 'Paper metadata by arXiv ID. Returns PaperMetadata as JSON.',
  mimeType: 'application/json',
  params: z.object({
    paperId: z.string().describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
  }),

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm the paper exists via arxiv_search.',
    },
  ],

  async handler(params, ctx) {
    const service = getArxivService();
    const result = await service.getPapers([params.paperId], ctx);
    const [paper] = result.papers;
    if (!paper) {
      throw ctx.fail('no_match', `Paper '${params.paperId}' not found.`, {
        paperId: params.paperId,
        ...ctx.recoveryFor('no_match'),
      });
    }
    return paper;
  },
});
