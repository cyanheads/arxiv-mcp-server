/**
 * @fileoverview arxiv://paper/{paperId} resource — paper metadata by arXiv ID.
 * @module mcp-server/resources/definitions/paper
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { normalizePaperId, PAPER_ID_FORMS } from '@/services/arxiv/paper-id.js';

/**
 * Percent-decode a URI-template variable. Template matching yields the raw text
 * of the URI segment, so a client that encodes the ID — mandatory for legacy IDs
 * such as `hep-th/9901001`, whose slash cannot appear literally inside a single
 * `{paperId}` segment — would otherwise have its ID rejected for the escapes in it.
 * A malformed escape sequence is left untouched so it fails the empty-ID or
 * ID-format check rather than throwing an unclassified `URIError`.
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
      .describe(
        'arXiv paper ID: "2401.12345", "2401.12345v2", or a pre-2007 ID like "hep-th/9901001" (archive spelled as arXiv issued it) with its slash percent-encoded, optionally prefixed "arXiv:".',
      ),
  }),

  errors: [
    {
      reason: 'empty_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The paper ID is blank once percent-escapes are decoded, e.g. arxiv://paper/%20%20%20.',
      recovery: 'Supply a non-blank arXiv ID such as "2401.12345" and read the URI again.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The decoded paper ID is not an arXiv identifier in an accepted form.',
      recovery:
        'Read the URI with an ID like "2401.12345", "2401.12345v2", or "hep-th/9901001" (a pre-2007 archive spelled as arXiv issued it; percent-encode the slash).',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm the paper exists via arxiv_search_papers.',
    },
    {
      reason: 'version_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The URI pinned a version the local mirror does not hold, and live arXiv fallback is disabled.',
      recovery:
        'Read the version named in the error detail, or drop the version suffix to get the latest.',
    },
    {
      reason: 'version_not_served',
      code: JsonRpcErrorCode.NotFound,
      when: "The URI pinned a superseded version of a pre-2007 paper that arXiv's API answers HTTP 500 for. The version exists, but its metadata cannot be returned.",
      recovery:
        'Read the latest version named in the error detail, or drop the version suffix to get the latest.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'arXiv has throttled requests (HTTP 429 or "Rate exceeded." body).',
      retryable: true,
      recovery:
        'Wait error.data.cooldownAppliedMs milliseconds before retrying, and lower concurrent arXiv calls.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'arXiv rejected the request (HTTP 4xx other than 429).',
      recovery: 'Verify the paper ID format (e.g., "2401.12345") and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const service = getArxivService();
    // The params schema trims the matched segment, but the match is raw URI
    // text — `%20` is three ordinary characters to it. Decode first, then
    // re-apply the blank check so an encoded blank is rejected here instead of
    // consuming an arXiv request slot.
    const decoded = decodeUriSegment(params.paperId).trim();
    if (!decoded) {
      throw ctx.fail('empty_id', `Paper ID '${params.paperId}' is blank once decoded.`, {
        paperId: params.paperId,
      });
    }
    const paperId = normalizePaperId(decoded);
    if (!paperId) {
      throw ctx.fail('invalid_id', `'${decoded}' is not an arXiv ID. Use ${PAPER_ID_FORMS}.`, {
        paperId: decoded,
      });
    }

    const result = await service.getPapers([paperId], ctx);
    const [paper] = result.papers;
    if (!paper) {
      // A version the mirror lacks (#35) or one arXiv will not serve (#53) is a
      // real version, so `no_match` would tell the reader to doubt an ID that
      // is in fact valid. Fail with the reason the service assigned, whose
      // detail names the version that can be served.
      const [miss] = result.not_found ?? [];
      const message = [`Paper '${paperId}' could not be served.`, miss?.detail]
        .filter(Boolean)
        .join(' ');
      if (miss?.reason === 'version_not_in_mirror') {
        throw ctx.fail('version_unavailable', message, { paperId, not_found: miss });
      }
      if (miss?.reason === 'version_not_served') {
        throw ctx.fail('version_not_served', message, { paperId, not_found: miss });
      }
      throw ctx.fail('no_match', `Paper '${paperId}' not found.`, { paperId });
    }
    return paper;
  },
});
