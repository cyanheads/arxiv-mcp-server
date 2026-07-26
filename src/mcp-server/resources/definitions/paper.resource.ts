/**
 * @fileoverview arxiv://paper/{paperId} resource — paper metadata by arXiv ID.
 * @module mcp-server/resources/definitions/paper
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

/**
 * Percent-decode a URI-template variable. Template matching yields the raw text
 * of the URI segment, so a client that encodes the ID — mandatory for legacy IDs
 * such as `hep-th/9901001`, whose slash cannot appear literally inside a single
 * `{paperId}` segment — would otherwise have the escapes reach arXiv verbatim.
 * A malformed escape sequence is left untouched so it fails the empty-ID check
 * or the arXiv lookup rather than throwing an unclassified `URIError`.
 */
function decodeUriSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export const paperResource = resource('arxiv://paper/{paperId}', {
  name: 'arXiv Paper Metadata',
  description: 'Paper metadata by arXiv ID. Returns PaperMetadata as JSON.',
  mimeType: 'application/json',
  params: z.object({
    paperId: z
      .string()
      .trim()
      .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
      .describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
  }),

  errors: [
    {
      reason: 'empty_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The paper ID is blank once percent-escapes are decoded, e.g. arxiv://paper/%20%20%20.',
      recovery: 'Supply a non-blank arXiv ID such as "2401.12345" and read the URI again.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm the paper exists via arxiv_search.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'arXiv has throttled requests (HTTP 429 or "Rate exceeded." body).',
      retryable: true,
      recovery:
        'Wait for the cooldown indicated by error.data.retryAfter (seconds) before retrying.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'arXiv rejected the request (HTTP 4xx other than 429), e.g. malformed ID syntax.',
      recovery: 'Verify the paper ID format (e.g., "2401.12345") and retry.',
    },
  ],

  async handler(params, ctx) {
    const service = getArxivService();
    // The params schema trims the matched segment, but the match is raw URI
    // text — `%20` is three ordinary characters to it. Decode first, then
    // re-apply the blank check so an encoded blank is rejected here instead of
    // consuming an arXiv request slot.
    const paperId = decodeUriSegment(params.paperId).trim();
    if (!paperId) {
      throw ctx.fail('empty_id', `Paper ID '${params.paperId}' is blank once decoded.`, {
        paperId: params.paperId,
        ...ctx.recoveryFor('empty_id'),
      });
    }

    const result = await service.getPapers([paperId], ctx);
    const [paper] = result.papers;
    if (!paper) {
      throw ctx.fail('no_match', `Paper '${paperId}' not found.`, {
        paperId,
        ...ctx.recoveryFor('no_match'),
      });
    }
    return paper;
  },
});
