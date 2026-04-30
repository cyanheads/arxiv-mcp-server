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
        `Search query. Supports field prefixes: ti: (title), au: (author), abs: (abstract), cat: (category), co: (comment), jr: (journal ref), all: (all fields). Boolean operators: AND, OR, ANDNOT. Examples: "au:bengio AND ti:attention", "all:transformer AND cat:cs.CL".`,
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
    total_results: z
      .number()
      .describe('Total matching papers (may exceed returned count due to pagination).'),
    start: z.number().describe('Pagination offset of this result set.'),
    papers: z.array(PaperMetadataSchema).describe('Matching papers with full metadata.'),
  }),

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
    return result;
  },

  format: (result) => {
    if (result.papers.length === 0) {
      // Paging past the end of a valid result set — distinguish from no matches.
      if (result.total_results > 0 && result.start >= result.total_results) {
        const lastValidStart = Math.max(0, result.total_results - 1);
        return [
          {
            type: 'text' as const,
            text: `Offset ${result.start} exceeds total results (${result.total_results}). Last valid page starts at ${lastValidStart}.`,
          },
        ];
      }
      return [
        {
          type: 'text' as const,
          text: 'No papers found. Try broader search terms, remove field prefixes (ti:, au:), or check category codes with arxiv_list_categories.',
        },
      ];
    }
    const range = `${result.start + 1}-${result.start + result.papers.length}`;
    const header = `Found ${result.total_results} papers (offset ${result.start}, showing ${range}):\n\n`;
    const papers = result.papers.map(formatPaper).join('\n\n---\n\n');
    return [{ type: 'text' as const, text: header + papers }];
  },
});
