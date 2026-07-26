/**
 * @fileoverview arxiv_search tool — search arXiv papers by query with category and sort filters.
 * @module mcp-server/tools/definitions/arxiv-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { formatPaper, PaperMetadataSchema } from '@/services/arxiv/types.js';

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
        `Search query. Field prefixes: ti: (title), au: (author — token-based; quote multi-token names like au:"hinton g" or pair with a topical clause to disambiguate common surnames), abs: (abstract), cat: (category — exact code match, not fuzzy), co: (comment), jr: (journal ref), all: (all fields). Boolean operators: AND, OR, ANDNOT. Examples: "au:bengio AND ti:attention", "all:transformer AND cat:cs.CL".`,
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter results to a specific arXiv category (e.g., "cs.CL", "math.AG"). Use arxiv_list_categories to discover valid codes.',
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
        10_000,
        'Pagination offset too deep (max 10000). arXiv returns 500s for very deep offsets.',
      )
      .default(0)
      .describe(
        'Pagination offset (0-10000). Use with max_results to page through results. E.g., start=10 with max_results=10 returns results 11-20.',
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
    effectiveQuery: z.string().describe('The query as sent to arXiv after input normalization.'),
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
    const result = await service.search(
      input.query,
      {
        ...(input.category && { category: input.category }),
        maxResults: input.max_results,
        sortBy: input.sort_by,
        sortOrder: input.sort_order,
        start: input.start,
      },
      ctx,
    );
    ctx.log.info('Search completed', {
      query: input.query,
      total: result.total_results,
      returned: result.papers.length,
    });

    ctx.enrich({
      effectiveQuery: input.query,
      totalFound: result.total_results,
      pageStart: result.start,
    });

    // Disclose when this page was capped — more matches exist past start + shown.
    if (result.papers.length > 0 && result.total_results > result.start + result.papers.length) {
      ctx.enrich.truncated({
        shown: result.papers.length,
        cap: input.max_results,
        guidance: `${result.total_results} total matches. Page further with start=${result.start + result.papers.length}, or refine the query.`,
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
