/**
 * @fileoverview arxiv_get_metadata tool — get full metadata for one or more papers by arXiv ID.
 * @module mcp-server/tools/definitions/arxiv-get-metadata
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { partialResult, partialResultSchema } from '@cyanheads/mcp-ts-core/utils';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { normalizePaperId, PAPER_ID_FORMS } from '@/services/arxiv/paper-id.js';
import {
  formatPaper,
  type PaperLookupMiss,
  PaperMetadataSchema,
  PaperNotFoundReasonSchema,
} from '@/services/arxiv/types.js';

/** Well-formed IDs looked up per call; the rest come back in `remaining_ids`. */
const LOOKUP_CAP = 10;

/** What makes a lone string a possible joined list: a comma or any Unicode mandatory line break. */
const LIST_SEPARATOR = /[,\n\v\f\r\x85\p{Zl}\p{Zp}]/u;

/**
 * `paper_ids` preprocess: a lone string becomes the one ID of the list.
 *
 * The framework wraps a lone string for a plain array field but refuses one
 * holding a line break anywhere, which rejected an ID with a trailing newline;
 * and it never wraps at a field routed through `z.preprocess()`. So this does
 * the wrap itself: a string whose trimmed form carries no separator and is not
 * JSON becomes `[trimmed]` — a blank one included, so it fails as the empty ID
 * it is, with the message a blank array element gets. Every other string is
 * reported as the not-an-array it is, so the framework still decodes a
 * stringified array and refuses the rest with its send-an-array hint. The
 * advertised schema is the inner array's.
 */
function wrapLonePaperId(value: unknown, ctx: z.core.$RefinementCtx): unknown {
  if (typeof value !== 'string') return value;
  const id = value.trim();
  if (!LIST_SEPARATOR.test(id) && !id.startsWith('[') && !id.startsWith('{')) {
    return [id];
  }
  ctx.addIssue({ code: 'invalid_type', expected: 'array', input: value });
  return value;
}

const OutputSchema = partialResultSchema({
  succeededKey: 'papers',
  succeededSchema: PaperMetadataSchema,
  succeededDescription:
    'Papers found, in request order. Fewer than requested when an ID is malformed, absent from arXiv, a version arXiv will not serve, one whose live lookup failed behind the local mirror, or past the first 10 well-formed IDs.',
  failedKey: 'not_found',
  idKey: 'id',
  idDescription:
    'Requested ID that returned no data — in canonical form when it was looked up, as sent when it is not an arXiv ID.',
  reason: PaperNotFoundReasonSchema,
  failureDescription: 'A requested ID that could not be returned, with the reason it was missed.',
}).extend({
  remaining_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Well-formed IDs past the first 10, in canonical form and request order, that this call did not look up. Pass them as paper_ids in the next call. Absent when every well-formed ID was looked up.',
    ),
});

export const arxivGetMetadata = tool('arxiv_get_metadata', {
  description:
    'Get full metadata for one or more arXiv papers by ID. Use when you have known IDs from citations, prior search results, or memory. Looks up 10 IDs per call; any further IDs come back in remaining_ids for the next call.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of the requested IDs is an arXiv identifier in an accepted form.',
      recovery:
        'Send IDs like "2401.12345", "2401.12345v2", or "hep-th/9901001" (a pre-2007 archive spelled as arXiv issued it); an arXiv: prefix or an arxiv.org abs, pdf, or html URL also works.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested IDs returned data from arXiv.',
      recovery:
        'Verify the ID format (e.g., "2401.12345" or "2401.12345v2") and confirm the paper exists via arxiv_search_papers.',
      severity: 'notice',
    },
    {
      reason: 'version_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every requested ID pinned a version the local mirror does not hold, and live arXiv fallback is disabled.',
      recovery:
        'Request the version named in the error detail, or drop the version suffix to get the latest.',
    },
    {
      reason: 'version_not_served',
      code: JsonRpcErrorCode.NotFound,
      when: "Every requested ID pinned a superseded version of a pre-2007 paper that arXiv's API answers HTTP 500 for. The version exists, but its metadata cannot be returned.",
      recovery:
        'Request the latest version each not_found detail names, or drop the version suffix; a version whose detail says to request it alone may be served that way.',
      severity: 'notice',
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
      recovery: 'Verify the ID format (e.g., "2401.12345" or "2401.12345v2") and retry.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    paper_ids: z
      .preprocess(
        wrapLonePaperId,
        z
          .array(
            z
              .string()
              .trim()
              .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").'),
          )
          .min(1)
          .max(100),
      )
      .describe(
        'arXiv paper IDs, up to 100. The first 10 well-formed IDs are looked up; the rest come back in remaining_ids to pass to the next call. Accepted forms: "2401.12345", "2401.12345v2" (a pinned version), or a pre-2007 ID like "hep-th/9901001" (archive spelled as arXiv issued it), each optionally prefixed "arXiv:", or an arxiv.org abs, pdf, or html URL, with or without https:// or a ?query or #fragment. An ID in any other form is reported in not_found with reason invalid_id and is not looked up.',
      ),
  }),

  output: OutputSchema,

  async handler(input, ctx) {
    const service = getArxivService();
    const requested = input.paper_ids.map((raw) => ({ raw, id: normalizePaperId(raw) }));
    const wellFormed = requested.flatMap((entry) => (entry.id ? [entry.id] : []));
    if (wellFormed.length === 0) {
      throw ctx.fail(
        'invalid_id',
        `None of the requested IDs is an arXiv ID: ${input.paper_ids.map((id) => `'${id}'`).join(', ')}. Use ${PAPER_ID_FORMS}.`,
        { ids: input.paper_ids },
      );
    }

    const lookup = wellFormed.slice(0, LOOKUP_CAP);
    const remaining = wellFormed.slice(LOOKUP_CAP);
    const result = await service.getPapers(lookup, ctx);
    const lookupMisses = result.not_found ?? [];

    // Report not_found in request order: a malformed ID where it sat, each
    // lookup miss at its ID's slot. Misses arrive in lookup order, so each
    // looked-up slot takes the next one when it names that slot's ID.
    const pending = [...lookupMisses];
    let lookedUp = 0;
    const notFound = requested.flatMap<PaperLookupMiss>((entry) => {
      if (!entry.id) {
        return [
          {
            id: entry.raw,
            reason: 'invalid_id',
            detail: `Not an arXiv ID. Use ${PAPER_ID_FORMS}.`,
          },
        ];
      }
      const miss = pending[0];
      if (lookedUp++ >= LOOKUP_CAP || miss?.id !== entry.id) return [];
      pending.shift();
      return [miss];
    });

    // With IDs still to look up, an all-miss page is a result that names them,
    // not a failure that would drop them.
    if (result.papers.length === 0 && remaining.length === 0) {
      // A version the mirror lacks (#35) or one arXiv will not serve (#53) is a
      // real version, so `no_match` would tell the caller to doubt an ID that
      // is in fact valid. Fail with the reason that names the real constraint.
      const everyMiss = (reason: PaperLookupMiss['reason']) =>
        lookupMisses.length > 0 && lookupMisses.every((m) => m.reason === reason);
      const versionReason = everyMiss('version_not_in_mirror')
        ? 'version_unavailable'
        : everyMiss('version_not_served')
          ? 'version_not_served'
          : undefined;
      // Every path's message carries each miss's detail and the malformed
      // inputs, so a caller reading only the text still learns which version
      // can be served — a `no_match` included, where such a miss sits beside
      // IDs absent from arXiv.
      const malformed = requested.filter((entry) => !entry.id).map((entry) => `'${entry.raw}'`);
      const message = [
        !versionReason && 'No papers found for the given IDs.',
        ...lookupMisses.flatMap((miss) =>
          miss.detail ? [`'${miss.id}' could not be served. ${miss.detail}`] : [],
        ),
        malformed.length > 0 && `Not arXiv IDs, so never looked up: ${malformed.join(', ')}.`,
      ]
        .filter(Boolean)
        .join(' ');
      throw ctx.fail(versionReason ?? 'no_match', message, { ids: lookup, not_found: notFound });
    }

    ctx.log.info('Metadata lookup completed', {
      requested: input.paper_ids.length,
      lookedUp: lookup.length,
      found: result.papers.length,
      remaining: remaining.length,
    });

    return {
      ...partialResult({
        succeededKey: 'papers' as const,
        succeeded: result.papers,
        failedKey: 'not_found' as const,
        failed: notFound,
      }),
      ...(remaining.length > 0 ? { remaining_ids: remaining } : {}),
    };
  },

  format: (result) => {
    const remaining = result.remaining_ids?.length ?? 0;
    const parts: string[] = [
      [
        `Found ${result.totalSucceeded} of ${result.totalSucceeded + (result.not_found?.length ?? 0)} papers.`,
        // IDs remain only past the lookup cap, so exactly LOOKUP_CAP were looked up.
        remaining > 0 &&
          `Looked up the first ${LOOKUP_CAP} well-formed IDs; ${remaining} more ${remaining === 1 ? 'ID is' : 'IDs are'} listed under Remaining IDs below.`,
      ]
        .filter(Boolean)
        .join(' '),
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
      // An extra blank line sets the list off from the paper blocks above it.
      parts.push(`${result.papers.length > 0 ? '\n' : ''}Not found:\n${lines.join('\n')}`);
    }
    if (result.remaining_ids && result.remaining_ids.length > 0) {
      parts.push(
        `Remaining IDs (not looked up; pass as paper_ids in the next call): ${JSON.stringify(result.remaining_ids)}`,
      );
    }
    return [{ type: 'text' as const, text: parts.join('\n\n') }];
  },
});
