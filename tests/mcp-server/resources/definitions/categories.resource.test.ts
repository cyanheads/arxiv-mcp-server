/**
 * @fileoverview Tests for arxiv://categories resource.
 * @module mcp-server/resources/definitions/categories.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { categoriesResource } from '@/mcp-server/resources/definitions/categories.resource.js';

describe('categoriesResource', () => {
  it('returns all categories', async () => {
    const ctx = createMockContext();
    const result = await categoriesResource.handler({}, ctx);
    const data = result as { categories: { code: string; name: string; group: string }[] };
    expect(data.categories.length).toBeGreaterThan(100);
    expect(data.categories[0]).toHaveProperty('code');
    expect(data.categories[0]).toHaveProperty('name');
    expect(data.categories[0]).toHaveProperty('group');
  });

  it('lists resource with correct metadata', async () => {
    const listing = await categoriesResource.list?.(
      {} as Parameters<NonNullable<typeof categoriesResource.list>>[0],
    );
    expect(listing?.resources).toHaveLength(1);
    expect(listing?.resources[0]).toMatchObject({
      uri: 'arxiv://categories',
      name: 'arXiv Categories',
      mimeType: 'application/json',
    });
  });
});
