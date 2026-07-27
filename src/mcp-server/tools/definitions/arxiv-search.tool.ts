/**
 * @fileoverview arxiv_search tool — search arXiv papers by query with category and sort filters.
 * @module mcp-server/tools/definitions/arxiv-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { formatPaper, PaperMetadataSchema } from '@/services/arxiv/types.js';

/**
 * Deepest pagination offset arXiv serves — it answers HTTP 500 beyond this, so
 * the cap is a real upstream boundary rather than a policy choice. Shared by the
 * `start` schema and the truncation guidance, which has to know when "page
 * further" stops being an executable instruction. See issues #2 and #27.
 */
const MAX_START = 10_000;

/** Optional `YYYY-MM-DD`. Empty string passes so form-based clients that submit
 * the whole schema shape aren't punished; the handler treats it as unset. */
const OPTIONAL_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

export const arxivSearch = tool('arxiv_search', {
  description:
    'Search arXiv papers by query with category and sort filters. Returns paper metadata including title, authors, abstract, categories, and links.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'unknown_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Provided category code is not part of the arXiv taxonomy.',
      recovery: 'Call arxiv_list_categories to discover valid category codes and retry.',
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
      when: 'arXiv rejected the request (HTTP 4xx other than 429), typically malformed query syntax.',
      recovery:
        'Check query syntax — use field prefixes ti:, au:, abs:, cat: and boolean operators AND, OR, ANDNOT.',
    },
    {
      reason: 'unsupported_query_syntax',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Query translates to a mirror FTS5 expression the search engine cannot parse, typically two operands juxtaposed across a parenthesized group without an explicit operator.',
      recovery:
        'Add an explicit AND or OR between adjacent terms and parenthesized groups, then retry.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'submitted_from or submitted_to is not a real UTC calendar date, or the window starts after it ends.',
      recovery:
        'Give both bounds as real UTC calendar dates in YYYY-MM-DD form, with submitted_from on or before submitted_to.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .trim()
      .min(
        1,
        'Query cannot be empty. Provide a search term with optional field prefixes (ti:, au:, abs:, cat:).',
      )
      .max(
        1000,
        'Query is too long (max 1000 chars). Use arXiv field prefixes (ti:, au:, abs:, cat:) to narrow the search instead.',
      )
      // Reject C0 control characters except tab (\x09), LF (\x0A), CR (\x0D); arXiv tolerates those in query whitespace.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this regex filters them out.
      .regex(/^[^\x00-\x08\x0B\x0C\x0E-\x1F]*$/, 'Query contains control characters.')
      .describe(
        `Search query. Field prefixes: ti: (title), au: (author — token-based; quote multi-token names like au:"hinton g" or pair with a topical clause to disambiguate common surnames), abs: (abstract), cat: (category — a leaf code matches exactly, a bare archive code such as cat:astro-ph matches its whole subtree), co: (comment), jr: (journal ref), all: (all fields). Boolean operators: AND, OR, ANDNOT. Examples: "au:bengio AND ti:attention", "all:transformer AND cat:cs.CL".`,
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Restrict results to an arXiv category. A leaf code ("cs.CL", "math.AG") matches exactly. A bare archive code ("astro-ph", "cond-mat", "cs", "math") matches the whole archive — its subject classes plus the legacy flat papers filed before the archive was subdivided. Note "physics" is the general-physics archive (physics.*), not the wider physics group: astro-ph, cond-mat, hep-*, quant-ph and the rest are separate archive codes. Use arxiv_list_categories to discover subject classes.',
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Maximum results to return (1-50). Default 10. Each result includes title, authors, abstract, and metadata — keep low to limit response size.',
      ),
    sort_by: z
      .enum(['relevance', 'submitted', 'updated'])
      .default('relevance')
      .describe(
        'Sort criterion. Use "submitted" for newest papers, "relevance" for best query matches.',
      ),
    sort_order: z
      .enum(['ascending', 'descending'])
      .default('descending')
      .describe('Sort direction. "descending" returns newest/most relevant first.'),
    start: z
      .number()
      .int()
      .min(0)
      .max(
        MAX_START,
        `Pagination offset too deep (max ${MAX_START}). arXiv returns 500s for very deep offsets.`,
      )
      .default(0)
      .describe(
        `Pagination offset (0-${MAX_START}). Use with max_results to page through results. E.g., start=10 with max_results=10 returns results 11-20. Matches beyond offset ${MAX_START} + max_results are unreachable by paging — carve the search into submitted_from/submitted_to windows and page within each.`,
      ),
    submitted_from: z
      .string()
      .regex(OPTIONAL_DATE, 'Use a UTC calendar date in YYYY-MM-DD form, e.g. "2024-01-01".')
      .optional()
      .describe(
        'Earliest submission date to include, inclusive, as a UTC YYYY-MM-DD date. Omit for no lower bound.',
      ),
    submitted_to: z
      .string()
      .regex(OPTIONAL_DATE, 'Use a UTC calendar date in YYYY-MM-DD form, e.g. "2024-01-31".')
      .optional()
      .describe(
        'Latest submission date to include, inclusive, as a UTC YYYY-MM-DD date. Omit for no upper bound. Both bounds are inclusive, so consecutive windows ("2024-01-01".."2024-01-15" then "2024-01-16".."2024-01-31") cover the matches with no gap; a paper submitted at exactly the midnight seam between two windows appears in both, so de-duplicate collected results by paper id. That is the way to reach matches past the start ceiling: split the date range, then page within each window.',
      ),
  }),

  output: z.object({
    papers: z.array(PaperMetadataSchema).describe('Matching papers with full metadata.'),
  }),

  // Result-set context the agent reasons with — the effective query, total match count,
  // pagination offset, and recovery guidance for empty or overshot pages. Populated via
  // ctx.enrich() so it reaches structuredContent and content[] alike; kept out of the
  // domain return.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The query as actually searched, carrying every filter applied — the category subtree and submitted-date window folded into arXiv syntax alongside the supplied terms. Replaying it as `query` with no other filters reproduces this exact result set.',
      ),
    totalFound: z.number().describe('Total matching papers reported by arXiv (before pagination).'),
    pageStart: z.number().describe('Pagination offset of this result page.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more matching papers exist beyond this page (totalFound > start + shown).',
      ),
    shown: z.number().optional().describe('Papers returned on this page.'),
    cap: z.number().optional().describe('The max_results limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when results are empty or paging overshot. Absent on successful pages.',
      ),
  },

  enrichmentTrailer: {
    effectiveQuery: { label: 'Query' },
    totalFound: { label: 'Total Found' },
    pageStart: { label: 'Page Start' },
  },

  async handler(input, ctx) {
    const service = getArxivService();
    // Empty strings arrive from form-based clients that submit the whole schema
    // shape; treat them as unset rather than as a window nobody asked for.
    const result = await service.search(
      input.query,
      {
        ...(input.category && { category: input.category }),
        ...(input.submitted_from && { submittedFrom: input.submitted_from }),
        ...(input.submitted_to && { submittedTo: input.submitted_to }),
        maxResults: input.max_results,
        sortBy: input.sort_by,
        sortOrder: input.sort_order,
        start: input.start,
      },
      ctx,
    );
    ctx.log.info('Search completed', {
      query: input.query,
      effectiveQuery: result.effective_query,
      total: result.total_results,
      returned: result.papers.length,
    });

    // The service builds the query that every filter dimension folds into, so
    // the echo is read back from the result rather than reconstructed here —
    // a handler-side reconstruction goes stale the moment a filter is added.
    ctx.enrich({
      effectiveQuery: result.effective_query,
      totalFound: result.total_results,
      pageStart: result.start,
    });

    // Disclose when this page was capped — more matches exist past start + shown.
    // Past the offset ceiling "page further" stops being an executable
    // instruction, so the guidance names the date-window mechanism instead.
    if (result.papers.length > 0 && result.total_results > result.start + result.papers.length) {
      const nextStart = result.start + result.papers.length;
      const reachable = MAX_START + input.max_results;
      ctx.enrich.truncated({
        shown: result.papers.length,
        cap: input.max_results,
        guidance:
          result.total_results > reachable
            ? `${result.total_results} total matches, but only the first ${reachable} are reachable by paging (start caps at ${MAX_START}). Split the search into submitted_from/submitted_to date windows and page within each — both bounds are inclusive, so consecutive windows cover every match with no gap; de-duplicate by paper id, since one submitted exactly at a window seam appears in both.`
            : `${result.total_results} total matches. Page further with start=${nextStart}, or refine the query.`,
      });
    }

    // Empty-result and pagination-overshoot notices surface as enrichment, not throws.
    if (result.papers.length === 0) {
      if (result.total_results > 0 && result.start >= result.total_results) {
        const lastValidStart = Math.max(0, result.total_results - 1);
        ctx.enrich.notice(
          `Offset ${result.start} exceeds total results (${result.total_results}). Last valid page starts at ${lastValidStart}.`,
        );
      } else {
        ctx.enrich.notice(
          'No papers found. Try broader search terms, remove field prefixes (ti:, au:), or check category codes with arxiv_list_categories.',
        );
      }
    }

    return { papers: result.papers };
  },

  format: (result) => {
    if (result.papers.length === 0) {
      return [{ type: 'text' as const, text: '' }];
    }
    const papers = result.papers.map(formatPaper).join('\n\n---\n\n');
    return [{ type: 'text' as const, text: papers }];
  },
});
