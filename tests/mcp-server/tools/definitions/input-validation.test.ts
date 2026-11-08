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
import { arxivSearchPapers } from '@/mcp-server/tools/definitions/arxiv-search-papers.tool.js';

// ---------------------------------------------------------------------------
// arxiv_search_papers
// ---------------------------------------------------------------------------

describe('arxivSearchPapers input validation', () => {
  it('rejects empty query', () => {
    expect(() => arxivSearchPapers.input.parse({ query: '' })).toThrow(/cannot be empty/i);
  });

  it('rejects whitespace-only query (trimmed to empty)', () => {
    expect(() => arxivSearchPapers.input.parse({ query: '   ' })).toThrow(/cannot be empty/i);
  });

  it('rejects query exceeding 1000 characters', () => {
    const longQuery = 'a'.repeat(1001);
    expect(() => arxivSearchPapers.input.parse({ query: longQuery })).toThrow(/too long/i);
  });

  it('rejects query containing C0 control characters', () => {
    // \x01 is a control character the schema explicitly forbids
    expect(() => arxivSearchPapers.input.parse({ query: 'valid\x01query' })).toThrow(
      /control characters/i,
    );
  });

  it('accepts query with tab (\\x09), LF (\\x0A), and CR (\\x0D) — tolerated whitespace', () => {
    const input = arxivSearchPapers.input.parse({ query: 'ti:attention\tand\nstuff\r' });
    // Schema allows these; the trimmed result must be non-empty after strip
    expect(typeof input.query).toBe('string');
  });

  it('rejects max_results of 0', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', max_results: 0 })).toThrow();
  });

  // Issue #51: a larger max_results serves 50 and names the next start instead
  // of rejecting; the schema ceiling is the paging ceiling, 10,000.
  it('accepts max_results up to 10000 and rejects 10001', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', max_results: 51 })).not.toThrow();
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'test', max_results: 10_000 }),
    ).not.toThrow();
    expect(() => arxivSearchPapers.input.parse({ query: 'test', max_results: 10_001 })).toThrow();
  });

  it('accepts boundary max_results of 1 and 50', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', max_results: 1 })).not.toThrow();
    expect(() => arxivSearchPapers.input.parse({ query: 'test', max_results: 50 })).not.toThrow();
  });

  it('rejects start exceeding 10000', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', start: 10_001 })).toThrow(
      /too deep/i,
    );
  });

  it('accepts boundary start of 0 and 10000', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', start: 0 })).not.toThrow();
    expect(() => arxivSearchPapers.input.parse({ query: 'test', start: 10_000 })).not.toThrow();
  });

  it('rejects negative start', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', start: -1 })).toThrow();
  });

  it('rejects invalid sort_by value', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'test', sort_by: 'bogus' })).toThrow();
  });

  it("reads arXiv's own sortBy names, in any case and padding, as the canonical sort_by (#105)", () => {
    const readings: [sent: string, canonical: string][] = [
      ['submittedDate', 'submitted'],
      ['lastUpdatedDate', 'updated'],
      ['SubmittedDate', 'submitted'],
      ['submitteddate', 'submitted'],
      ['LASTUPDATEDDATE', 'updated'],
      [' lastUpdatedDate\n', 'updated'],
      ['Submitted', 'submitted'],
      ['RELEVANCE', 'relevance'],
      [' updated ', 'updated'],
      ['relevance', 'relevance'],
      ['submitted', 'submitted'],
      ['updated', 'updated'],
    ];
    for (const [sort_by, canonical] of readings) {
      expect(arxivSearchPapers.input.parse({ query: 'test', sort_by }).sort_by, sort_by).toBe(
        canonical,
      );
    }
  });

  it('rejects a sort_by with no one reading with the enum message', () => {
    for (const sort_by of ['bogus', 'submitted_date', 'lastUpdated', 'date', '', 3]) {
      const parsed = arxivSearchPapers.input.safeParse({ query: 'test', sort_by });
      expect(parsed.success, JSON.stringify(sort_by)).toBe(false);
      expect(parsed.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        {
          path: ['sort_by'],
          message: 'Invalid option: expected one of "relevance"|"submitted"|"updated"',
        },
      ]);
    }
  });

  it('rejects invalid sort_order value', () => {
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'test', sort_order: 'sideways' }),
    ).toThrow();
  });

  it('rejects missing query field entirely', () => {
    expect(() => arxivSearchPapers.input.parse({})).toThrow();
  });

  it('accepts valid optional fields', () => {
    const input = arxivSearchPapers.input.parse({
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
    const input = arxivSearchPapers.input.parse({ query: 'all:gpt' });
    expect(input.max_results).toBe(10);
    expect(input.sort_by).toBe('relevance');
    expect(input.sort_order).toBe('descending');
    expect(input.start).toBe(0);
  });

  // Issue #32 — bare archive and group codes are valid filter targets now, so
  // the schema must not be the thing that rejects them.
  it('accepts bare archive and group category codes', () => {
    for (const category of ['astro-ph', 'cond-mat', 'nlin', 'q-bio', 'cs', 'math', 'stat']) {
      expect(() => arxivSearchPapers.input.parse({ query: 'test', category })).not.toThrow();
    }
  });

  // Issue #27 — the date window params.
  it('accepts a well-formed submitted-date window', () => {
    const input = arxivSearchPapers.input.parse({
      query: 'test',
      submitted_from: '2024-01-01',
      submitted_to: '2024-01-31',
    });
    expect(input.submitted_from).toBe('2024-01-01');
    expect(input.submitted_to).toBe('2024-01-31');
  });

  it('accepts either date bound on its own', () => {
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'test', submitted_from: '2024-01-01' }),
    ).not.toThrow();
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'test', submitted_to: '2024-01-31' }),
    ).not.toThrow();
  });

  it('rejects date bounds that are not YYYY-MM-DD', () => {
    for (const submitted_from of ['01/01/2024', '2024-1-1', '20240101', 'yesterday']) {
      expect(() => arxivSearchPapers.input.parse({ query: 'test', submitted_from })).toThrow(
        /YYYY-MM-DD/,
      );
    }
  });

  // Form-based clients submit the full schema shape; an empty optional string is
  // valid MCP behavior, so the schema stays permissive and the handler ignores it.
  it('accepts empty date strings from form-based clients', () => {
    expect(() =>
      arxivSearchPapers.input.parse({ query: 'test', submitted_from: '', submitted_to: '' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// arxiv_get_metadata
// ---------------------------------------------------------------------------

describe('arxivGetMetadata input validation', () => {
  // A blank lone string is wrapped like any other, so it fails as the one empty
  // ID it is — the sole issue is the blank-element one, never a not-an-array.
  it('rejects empty string paper_id as an empty ID', () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: '' });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").',
    ]);
  });

  it('rejects whitespace-only paper_id (trimmed to empty) as an empty ID', () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: ' \t\r\n' });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").',
    ]);
  });

  it('rejects array with empty string element', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: [''] })).toThrow();
  });

  it('rejects array with whitespace-only element (trimmed to empty)', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ['2401.12345', ' \t '] })).toThrow(
      /cannot be empty/i,
    );
  });

  it('trims surrounding whitespace off accepted IDs', () => {
    expect(arxivGetMetadata.input.parse({ paper_ids: ['  2401.12345  '] }).paper_ids).toEqual([
      '2401.12345',
    ]);
    expect(arxivGetMetadata.input.parse({ paper_ids: [' 2401.12345 '] }).paper_ids).toEqual([
      '2401.12345',
    ]);
  });

  it('rejects empty array', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: [] })).toThrow();
  });

  // Issue #51: past the 10-ID lookup cap the rest come back in remaining_ids;
  // the schema ceiling is 100.
  it('accepts up to 100 IDs and rejects 101', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `2401.${String(i).padStart(5, '0')}`);
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids.slice(0, 100) })).not.toThrow();
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids })).toThrow();
  });

  it('accepts exactly 10 IDs', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `2401.0000${i}`);
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ids })).not.toThrow();
  });

  // Issue #41: the schema takes a list and wraps a lone string itself, line
  // breaks at its edges included. A string that may be a joined list stays a
  // not-an-array for the framework to decode or refuse (id-input-boundary.test.ts).
  it('wraps a single string ID into a one-element list', () => {
    for (const paper_ids of ['2401.12345', ' 2401.12345\r\n']) {
      expect(arxivGetMetadata.input.parse({ paper_ids }).paper_ids).toEqual(['2401.12345']);
    }
    for (const paper_ids of ['2401.12345\n2401.12346', '2401.12345,2401.12346', '["2401.12345"]']) {
      expect(() => arxivGetMetadata.input.parse({ paper_ids })).toThrow(/expected array/i);
    }
    expect(arxivGetMetadata.input.parse({ paper_ids: ['2401.12345'] }).paper_ids).toEqual([
      '2401.12345',
    ]);
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

  it('rejects whitespace-only paper_id (trimmed to empty)', () => {
    expect(() => arxivReadPaper.input.parse({ paper_id: '   ' })).toThrow(/cannot be empty/i);
  });

  it('trims surrounding whitespace off an accepted paper_id', () => {
    expect(arxivReadPaper.input.parse({ paper_id: '  2401.12345  ' }).paper_id).toBe('2401.12345');
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

  it('accepts max_characters of null as the explicit whole-paper read', () => {
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: null });
    expect(input.max_characters).toBeNull();
  });

  it('rejects a non-integer max_characters', () => {
    expect(() =>
      arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 1.5 }),
    ).toThrow();
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
