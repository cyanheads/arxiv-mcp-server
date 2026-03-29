/**
 * @fileoverview arxiv://categories resource — full arXiv category taxonomy.
 * @module mcp-server/resources/definitions/categories
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { ARXIV_CATEGORIES } from '@/services/arxiv/categories.js';

export const categoriesResource = resource('arxiv://categories', {
  name: 'arXiv Categories',
  description: 'Full arXiv category taxonomy. Returns grouped category list as JSON.',
  mimeType: 'application/json',

  handler() {
    return { categories: ARXIV_CATEGORIES };
  },

  list: async () => ({
    resources: [
      {
        uri: 'arxiv://categories',
        name: 'arXiv Categories',
        description: 'Full arXiv category taxonomy with codes, names, and groups.',
        mimeType: 'application/json',
      },
    ],
  }),
});
