/**
 * @fileoverview arxiv_list_categories tool — list arXiv category taxonomy.
 * @module mcp-server/tools/definitions/arxiv-list-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { ARXIV_CATEGORIES, GROUPS } from '@/services/arxiv/categories.js';

const CategorySchema = z.object({
  code: z.string().describe('Category code (e.g., "cs.AI").'),
  name: z.string().describe('Full name (e.g., "Artificial Intelligence").'),
  group: z.string().describe('Top-level group (e.g., "cs").'),
});

export const arxivListCategories = tool('arxiv_list_categories', {
  description:
    'List arXiv category codes and names. Useful for discovering valid category filters for arxiv_search.',
  annotations: { readOnlyHint: true },

  input: z.object({
    group: z
      .enum(GROUPS)
      .optional()
      .describe(
        'Filter by top-level group (e.g., "cs", "math", "physics"). Returns all categories if omitted.',
      ),
  }),

  output: z.object({
    categories: z.array(CategorySchema).describe('arXiv categories matching the filter.'),
  }),

  handler(input) {
    const categories = input.group
      ? ARXIV_CATEGORIES.filter((c) => c.group === input.group)
      : [...ARXIV_CATEGORIES];
    return { categories };
  },

  format: (result) => {
    const grouped = Map.groupBy(result.categories, (cat) => cat.group);
    const groupCount = grouped.size;
    const total = result.categories.length;
    const header =
      groupCount === 1
        ? `Showing ${total} categories in group "${[...grouped.keys()][0]}":`
        : `Showing ${total} categories across ${groupCount} groups:`;
    const sections = [...grouped.entries()]
      .map(([group, cats]) => `## ${group}\n${cats.map((c) => `${c.code} — ${c.name}`).join('\n')}`)
      .join('\n\n');
    return [{ type: 'text' as const, text: `${header}\n\n${sections}` }];
  },
});
