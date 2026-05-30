/**
 * @fileoverview Input validation tests for all tool definitions.
 * Verifies Zod schema enforcement — missing required fields, out-of-range values,
 * malformed types, and injection/oversized payloads are rejected before handler runs.
 * @module mcp-server/tools/definitions/input-validation.test
 */

import { describe, expect, it } from 'vitest';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivListCategories } from '@/mcp-server/tools/definitions/arxiv-list-categories.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';

// ---------------------------------------------------------------------------
// arxiv_search
// ---------------------------------------------------------------------------

describe('arxivSearch input validation', () => {
  it('rejects empty query', () => {
    expect(() => arxivSearch.input.parse({ query: '' })).toThrow(/cannot be empty/i);
  });

  it('rejects whitespace-only query (trimmed to empty)', () => {
    expect(() => arxivSearch.input.parse({ query: '   ' })).toThrow(/cannot be empty/i);
  });

  it('rejects query exceeding 1000 characters', () => {
    const longQuery = 'a'.repeat(1001);
    expect(() => arxivSearch.input.parse({ query: longQuery })).toThrow(/too long/i);
  });

  it('rejects query containing C0 control characters', () => {
    // \x01 is a control character the schema explicitly forbids
    expect(() => arxivSearch.input.parse({ query: 'valid\x01query' })).toThrow(
      /control characters/i,
    );
  });

  it('accepts query with tab (\\x09), LF (\\x0A), and CR (\\x0D) — tolerated whitespace', () => {
    const input = arxivSearch.input.parse({ query: 'ti:attention\tand\nstuff\r' });
    // Schema allows these; the trimmed result must be non-empty after strip
    expect(typeof input.query).toBe('string');
  });

  it('rejects max_results of 0', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', max_results: 0 })).toThrow();
  });

  it('rejects max_results exceeding 50', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', max_results: 51 })).toThrow();
  });

  it('accepts boundary max_results of 1 and 50', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', max_results: 1 })).not.toThrow();
    expect(() => arxivSearch.input.parse({ query: 'test', max_results: 50 })).not.toThrow();
  });

  it('rejects start exceeding 10000', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', start: 10_001 })).toThrow(/too deep/i);
  });

  it('accepts boundary start of 0 and 10000', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', start: 0 })).not.toThrow();
    expect(() => arxivSearch.input.parse({ query: 'test', start: 10_000 })).not.toThrow();
  });

  it('rejects negative start', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', start: -1 })).toThrow();
  });

  it('rejects invalid sort_by value', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', sort_by: 'bogus' })).toThrow();
  });

  it('rejects invalid sort_order value', () => {
    expect(() => arxivSearch.input.parse({ query: 'test', sort_order: 'sideways' })).toThrow();
  });

  it('rejects missing query field entirely', () => {
    expect(() => arxivSearch.input.parse({})).toThrow();
  });

  it('accepts valid optional fields', () => {
    const input = arxivSearch.input.parse({
      query: 'all:transformer',
      category: 'cs.CL',
      max_results: 5,
      sort_by: 'submitted',
      sort_order: 'ascending',
      start: 20,
    });
    expect(input.category).toBe('cs.CL');
    expect(input.max_results).toBe(5);
  });

  it('applies defaults when optional fields are omitted', () => {
    const input = arxivSearch.input.parse({ query: 'all:gpt' });
    expect(input.max_results).toBe(10);
    expect(input.sort_by).toBe('relevance');
    expect(input.sort_order).toBe('descending');
    expect(input.start).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// arxiv_get_metadata
// ---------------------------------------------------------------------------

describe('arxivGetMetadata input validation', () => {
  it('rejects empty string paper_id', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: '' })).toThrow(/cannot be empty/i);
  });

  it('rejects array with empty string element', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: [''] })).toThrow();
  });

  it('rejects empty array', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: [] })).toThrow();
  });

  it('rejects array with more than 10 IDs', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `2401.0000${i}`);
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids })).toThrow();
  });

  it('accepts exactly 10 IDs', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `2401.0000${i}`);
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids })).not.toThrow();
  });

  it('accepts a single string ID', () => {
    const input = arxivGetMetadata.input.parse({ paper_ids: '2401.12345' });
    expect(input.paper_ids).toBe('2401.12345');
  });

  it('accepts a single-element array', () => {
    const input = arxivGetMetadata.input.parse({ paper_ids: ['2401.12345'] });
    expect(Array.isArray(input.paper_ids)).toBe(true);
  });

  it('rejects missing paper_ids field', () => {
    expect(() => arxivGetMetadata.input.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// arxiv_read_paper
// ---------------------------------------------------------------------------

describe('arxivReadPaper input validation', () => {
  it('rejects empty paper_id', () => {
    expect(() => arxivReadPaper.input.parse({ paper_id: '' })).toThrow(/cannot be empty/i);
  });

  it('rejects missing paper_id', () => {
    expect(() => arxivReadPaper.input.parse({})).toThrow();
  });

  it('rejects max_characters of 0', () => {
    expect(() =>
      arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 0 }),
    ).toThrow();
  });

  it('accepts max_characters of 1', () => {
    expect(() =>
      arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 1 }),
    ).not.toThrow();
  });

  it('rejects negative start', () => {
    expect(() => arxivReadPaper.input.parse({ paper_id: '2401.12345', start: -1 })).toThrow();
  });

  it('accepts start of 0', () => {
    expect(() => arxivReadPaper.input.parse({ paper_id: '2401.12345', start: 0 })).not.toThrow();
  });

  it('applies defaults for max_characters and start', () => {
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345' });
    expect(input.max_characters).toBe(100_000);
    expect(input.start).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// arxiv_list_categories
// ---------------------------------------------------------------------------

describe('arxivListCategories input validation', () => {
  it('rejects invalid group value', () => {
    expect(() => arxivListCategories.input.parse({ group: 'notagroup' })).toThrow();
  });

  it('accepts omitted group (returns all)', () => {
    expect(() => arxivListCategories.input.parse({})).not.toThrow();
  });

  it('accepts each valid group', () => {
    const validGroups = ['cs', 'econ', 'eess', 'math', 'physics', 'q-bio', 'q-fin', 'stat'];
    for (const group of validGroups) {
      expect(() => arxivListCategories.input.parse({ group })).not.toThrow();
    }
  });
});
