/**
 * @fileoverview Tests for arxiv_list_categories tool.
 * @module mcp-server/tools/definitions/arxiv-list-categories.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { arxivListCategories } from '@/mcp-server/tools/definitions/arxiv-list-categories.tool.js';

describe('arxivListCategories', () => {
  it('returns all categories when no group specified', async () => {
    const ctx = createMockContext();
    const input = arxivListCategories.input.parse({});
    const result = await arxivListCategories.handler(input, ctx);
    expect(result.categories.length).toBeGreaterThan(100);
    expect(result.categories).toContainEqual(
      expect.objectContaining({ code: 'cs.AI', group: 'cs' }),
    );
  });

  it('filters by group', async () => {
    const ctx = createMockContext();
    const input = arxivListCategories.input.parse({ group: 'econ' });
    const result = await arxivListCategories.handler(input, ctx);
    expect(result.categories).toHaveLength(3);
    expect(result.categories.every((c) => c.group === 'econ')).toBe(true);
  });

  it('formats output with group headers and a single-group operational header', async () => {
    const ctx = createMockContext();
    const input = arxivListCategories.input.parse({ group: 'stat' });
    const result = await arxivListCategories.handler(input, ctx);
    const blocks = arxivListCategories.format?.(result) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/^Showing \d+ categories in group "stat":/);
    expect(text).toContain('## stat');
    expect(text).toContain('stat.ML — Machine Learning');
  });

  it('renders multi-group header when no filter is applied', async () => {
    const ctx = createMockContext();
    const input = arxivListCategories.input.parse({});
    const result = await arxivListCategories.handler(input, ctx);
    const blocks = arxivListCategories.format?.(result) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/^Showing \d+ categories across \d+ groups:/);
  });
});
