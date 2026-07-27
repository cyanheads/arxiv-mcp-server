/**
 * @fileoverview Tests for the arXiv → FTS5 query translator including
 * field prefixes, boolean operators, phrase quoting, category-subtree
 * expansion via the bundled taxonomy, `submittedDate:` window extraction
 * (issue #27), parenthesis-boundary adjacency (issue #13), and `cat:`
 * extraction cleanup inside parens (issue #14), all verified against a real
 * in-memory FTS5 index.
 * @module services/arxiv/mirror/query.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categorySubtree } from '@/services/arxiv/categories.js';
import { translateQuery } from '@/services/arxiv/mirror/query.js';
import { MirrorStore } from '@/services/arxiv/mirror/store.js';

describe('translateQuery', () => {
  it('passes bare words straight through as a quoted FTS term', () => {
    const { matchExpr, categoryFilters } = translateQuery('hello');
    expect(matchExpr).toBe('"hello"');
    expect(categoryFilters).toEqual([]);
  });

  it('maps field prefixes to FTS columns', () => {
    expect(translateQuery('ti:transformer').matchExpr).toBe('title:"transformer"');
    expect(translateQuery('au:knuth').matchExpr).toBe('authors:"knuth"');
    expect(translateQuery('abs:dynamics').matchExpr).toBe('abstract:"dynamics"');
  });

  it('expands all: across title, authors, abstract', () => {
    const { matchExpr } = translateQuery('all:dark');
    expect(matchExpr).toBe('(title:"dark" OR authors:"dark" OR abstract:"dark")');
  });

  it('translates boolean operators including ANDNOT → NOT', () => {
    expect(translateQuery('a AND b').matchExpr).toBe('"a" AND "b"');
    expect(translateQuery('a OR b').matchExpr).toBe('"a" OR "b"');
    expect(translateQuery('a ANDNOT b').matchExpr).toBe('"a" NOT "b"');
  });

  it('preserves quoted phrases as single FTS tokens', () => {
    const { matchExpr } = translateQuery('ti:"deep learning"');
    expect(matchExpr).toBe('title:"deep learning"');
  });

  it('extracts cat: operands as structured filters and removes them from the FTS expression', () => {
    const { matchExpr, categoryFilters } = translateQuery('transformer AND cat:cs.LG');
    expect(matchExpr).toBe('"transformer"');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('expands archive-level cat:cs to the bare code plus every cs.* code', () => {
    const { matchExpr, categoryFilters } = translateQuery('attention AND cat:cs');
    expect(matchExpr).toBe('"attention"');
    expect(categoryFilters.length).toBeGreaterThan(10);
    expect(categoryFilters).toContain('cs.LG');
    expect(categoryFilters).toContain('cs.AI');
    // The bare archive code carries legacy flat papers filed before the archive
    // was subdivided; dropping it makes the mirror narrower than live (#32).
    expect(categoryFilters).toContain('cs');
    expect(categoryFilters.every((c) => c === 'cs' || c.startsWith('cs.'))).toBe(true);
  });

  it('drops dangling boolean operators when cat: is the sole non-operator term', () => {
    const { matchExpr, categoryFilters } = translateQuery('cat:cs.LG');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('emits no matchExpr when the query is empty', () => {
    const { matchExpr, categoryFilters } = translateQuery('');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters).toEqual([]);
  });

  it('escapes embedded quotes by doubling them', () => {
    const { matchExpr } = translateQuery('ti:foo"bar');
    expect(matchExpr).toBe('title:"foo""bar"');
  });

  it('honors parentheses for grouping', () => {
    const { matchExpr } = translateQuery('(a OR b) AND c');
    expect(matchExpr).toBe('("a" OR "b") AND "c"');
  });
});

describe('translateQuery — parenthesis-boundary adjacency (issue #13)', () => {
  it('inserts AND between a bare term and an all: expansion', () => {
    expect(translateQuery('language all:automated').matchExpr).toBe(
      '"language" AND (title:"automated" OR authors:"automated" OR abstract:"automated")',
    );
  });

  it('inserts AND between an all: expansion and a trailing bare term', () => {
    expect(translateQuery('all:dark matter').matchExpr).toBe(
      '(title:"dark" OR authors:"dark" OR abstract:"dark") AND "matter"',
    );
  });

  it('inserts AND between consecutive all: expansions sandwiching a phrase', () => {
    expect(translateQuery('all:language "language" all:automated').matchExpr).toBe(
      '(title:"language" OR authors:"language" OR abstract:"language") AND "language" AND (title:"automated" OR authors:"automated" OR abstract:"automated")',
    );
  });

  it('inserts AND between two user-parenthesized groups', () => {
    expect(translateQuery('(foo) (bar)').matchExpr).toBe('("foo") AND ("bar")');
  });

  it('inserts AND between a bare term and a user-parenthesized all: group', () => {
    expect(translateQuery('bar (all:foo)').matchExpr).toBe(
      '"bar" AND ((title:"foo" OR authors:"foo" OR abstract:"foo"))',
    );
  });

  it('does NOT insert AND between bare phrases (implicit-AND is valid for phrases)', () => {
    expect(translateQuery('foo bar').matchExpr).toBe('"foo" "bar"');
  });

  it('does NOT insert AND between bare column qualifiers and phrases', () => {
    expect(translateQuery('ti:foo bar').matchExpr).toBe('title:"foo" "bar"');
    expect(translateQuery('foo ti:bar').matchExpr).toBe('"foo" title:"bar"');
  });

  it('preserves explicit operators without doubling them up', () => {
    expect(translateQuery('a AND (b OR c)').matchExpr).toBe('"a" AND ("b" OR "c")');
    expect(translateQuery('(a OR b) AND c').matchExpr).toBe('("a" OR "b") AND "c"');
    expect(translateQuery('a ANDNOT (b OR c)').matchExpr).toBe('"a" NOT ("b" OR "c")');
  });

  it('inserts AND between consecutive all: expansions', () => {
    expect(translateQuery('all:foo all:bar').matchExpr).toBe(
      '(title:"foo" OR authors:"foo" OR abstract:"foo") AND (title:"bar" OR authors:"bar" OR abstract:"bar")',
    );
  });

  it('inserts AND across literal-paren ↔ all: boundaries in both directions', () => {
    expect(translateQuery('(a) all:b').matchExpr).toBe(
      '("a") AND (title:"b" OR authors:"b" OR abstract:"b")',
    );
    expect(translateQuery('all:b (a)').matchExpr).toBe(
      '(title:"b" OR authors:"b" OR abstract:"b") AND ("a")',
    );
  });

  it('does NOT insert AND when an explicit operator already bridges a paren boundary', () => {
    expect(translateQuery('attention OR all:transformer').matchExpr).toBe(
      '"attention" OR (title:"transformer" OR authors:"transformer" OR abstract:"transformer")',
    );
    expect(translateQuery('a ANDNOT all:b').matchExpr).toBe(
      '"a" NOT (title:"b" OR authors:"b" OR abstract:"b")',
    );
  });
});

describe('translateQuery — cat: extraction cleanup (issue #14)', () => {
  // -------------------------------------------------------------------------
  // The six failing shapes from the issue's table.
  // -------------------------------------------------------------------------

  it('drops dangling OR when cat: opens a parenthesized group', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG OR term)');
    expect(matchExpr).toBe('("term")');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('drops dangling OR when cat: closes a parenthesized group', () => {
    const { matchExpr, categoryFilters } = translateQuery('(term OR cat:cs.LG)');
    expect(matchExpr).toBe('("term")');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('drops dangling AND when cat: opens a parenthesized group', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG AND term)');
    expect(matchExpr).toBe('("term")');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('collapses an empty group to no matchExpr when cat: was the sole operand', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG)');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('collapses to no matchExpr when every operand in a group is cat:', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG OR cat:cs.AI)');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters.sort()).toEqual(['cs.AI', 'cs.LG']);
  });

  it('reduces (cat OR cat OR term) to just the surviving term', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG OR cat:cs.AI OR term)');
    expect(matchExpr).toBe('("term")');
    expect(categoryFilters.sort()).toEqual(['cs.AI', 'cs.LG']);
  });

  // -------------------------------------------------------------------------
  // Broader cleanup scenarios — cleanup must handle every operator/paren
  // boundary, not just the shapes in the issue table.
  // -------------------------------------------------------------------------

  it('joins surviving operands when cat: sits between two terms at top level', () => {
    expect(translateQuery('a AND cat:cs.LG AND b').matchExpr).toBe('"a" AND "b"');
  });

  it('drops a leading operator when cat: was the first token at top level', () => {
    const { matchExpr, categoryFilters } = translateQuery('cat:cs.LG AND a');
    expect(matchExpr).toBe('"a"');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('drops a trailing operator when cat: was the last token at top level', () => {
    const { matchExpr, categoryFilters } = translateQuery('a AND cat:cs.LG');
    expect(matchExpr).toBe('"a"');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('removes an emptied group from the middle of a larger expression', () => {
    expect(translateQuery('term AND (cat:cs.LG)').matchExpr).toBe('"term"');
    expect(translateQuery('(cat:cs.LG) AND term').matchExpr).toBe('"term"');
  });

  it('handles nested groups where the inner group empties out', () => {
    expect(translateQuery('(a AND (cat:cs.LG))').matchExpr).toBe('("a")');
  });

  it('collapses double-operator artifacts when cat: bridged the operators', () => {
    // `a AND cat:cs.LG OR b` → after strip: `"a" AND OR "b"`; first op wins.
    expect(translateQuery('a AND cat:cs.LG OR b').matchExpr).toBe('"a" AND "b"');
  });

  it('preserves explicit grouping when the group still has surviving operands', () => {
    expect(translateQuery('(a OR cat:cs.LG OR b)').matchExpr).toBe('("a" OR "b")');
  });

  it('preserves categoryFilters even when matchExpr collapses to undefined', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG AND cat:cs.AI)');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters.sort()).toEqual(['cs.AI', 'cs.LG']);
  });

  it('expands archive-level cat: inside parens (cs → bare code + every cs.* code)', () => {
    const { matchExpr, categoryFilters } = translateQuery('(term OR cat:cs)');
    expect(matchExpr).toBe('("term")');
    expect(categoryFilters.length).toBeGreaterThan(10);
    expect(categoryFilters.every((c) => c === 'cs' || c.startsWith('cs.'))).toBe(true);
  });

  it('does not regress non-cat parenthesized queries', () => {
    expect(translateQuery('(a OR b)').matchExpr).toBe('("a" OR "b")');
    expect(translateQuery('(a AND b) OR c').matchExpr).toBe('("a" AND "b") OR "c"');
  });

  it('does not insert AND across a cleanup-emptied paren boundary', () => {
    // After cleanup the trailing `()` is gone — issue #13's adjacency
    // pass must not re-inject an AND between `"term"` and nothing.
    expect(translateQuery('term AND (cat:cs.LG)').matchExpr).toBe('"term"');
  });

  it('handles cat: adjacent to an all: expansion inside parens', () => {
    const { matchExpr, categoryFilters } = translateQuery('(all:dark OR cat:cs.LG)');
    expect(matchExpr).toBe('((title:"dark" OR authors:"dark" OR abstract:"dark"))');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('handles cat: as the sole operand alongside an all: expansion', () => {
    const { matchExpr, categoryFilters } = translateQuery('all:dark AND cat:cs.LG');
    expect(matchExpr).toBe('(title:"dark" OR authors:"dark" OR abstract:"dark")');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('handles cat: with a phrase operand inside parens', () => {
    const { matchExpr, categoryFilters } = translateQuery('(cat:cs.LG OR "deep learning")');
    expect(matchExpr).toBe('("deep learning")');
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('handles a single cat: at top level with no other tokens', () => {
    const { matchExpr, categoryFilters } = translateQuery('cat:cs.LG');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters).toEqual(['cs.LG']);
  });

  it('handles multiple consecutive cat: at top level with no other tokens', () => {
    const { matchExpr, categoryFilters } = translateQuery('cat:cs.LG OR cat:cs.AI OR cat:cs.CL');
    expect(matchExpr).toBeUndefined();
    expect(categoryFilters.sort()).toEqual(['cs.AI', 'cs.CL', 'cs.LG']);
  });
});

describe('translateQuery → FTS5 parser parity (issue #13)', () => {
  let dir: string;
  let store: MirrorStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-query-parity-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cases: string[] = [
    // All five failing shapes from issue #13.
    'language all:automated',
    'all:language "language" all:automated',
    'all:dark matter',
    '(foo) (bar)',
    'bar (all:foo)',
    // Adjacency combinations beyond the issue's table — exercise every
    // paren-form ↔ paren-form / paren ↔ phrase boundary direction.
    'all:foo all:bar',
    '(a) all:b',
    'all:b (a)',
    '(a) "phrase"',
    '"phrase" (a)',
    'a ANDNOT all:b',
    'all:b ANDNOT a',
    'attention OR all:transformer',
    'all:transformer OR attention',
    // Plus a sampling of existing shapes that must continue to parse.
    'hello',
    'foo bar',
    'foo OR bar',
    'a AND b',
    'a ANDNOT b',
    'ti:transformer',
    '(a OR b) AND c',
    'all:dark',
    'ti:foo bar',
    // cat: extraction leaves an FTS expression behind:
    'attention AND cat:cs.LG',
    // All failing shapes from issue #14 — cat: extraction inside parens.
    '(cat:cs.LG OR term)',
    '(term OR cat:cs.LG)',
    '(cat:cs.LG AND term)',
    '(cat:cs.LG)',
    '(cat:cs.LG OR cat:cs.AI)',
    '(cat:cs.LG OR cat:cs.AI OR term)',
    // Broader #14 cleanup combinations beyond the issue's table.
    'cat:cs.LG AND a',
    'a AND cat:cs.LG',
    'cat:cs.LG',
    'cat:cs.LG OR cat:cs.AI OR cat:cs.CL',
    'a AND cat:cs.LG AND b',
    'a AND cat:cs.LG OR b',
    'term AND (cat:cs.LG)',
    '(cat:cs.LG) AND term',
    '(a AND (cat:cs.LG))',
    '(a OR cat:cs.LG OR b)',
    '(cat:cs.LG AND cat:cs.AI)',
    '(term OR cat:cs)',
    '(all:dark OR cat:cs.LG)',
    'all:dark AND cat:cs.LG',
    '(cat:cs.LG OR "deep learning")',
  ];

  it.each(cases)('emitted FTS5 expression parses for %s', (q) => {
    const { matchExpr } = translateQuery(q);
    if (matchExpr === undefined) return;
    expect(() =>
      store.search({
        matchExpr,
        categoryFilters: [],
        limit: 1,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      }),
    ).not.toThrow();
  });
});

describe('cat: operand expansion', () => {
  it('expands a cat: operand through the shared taxonomy subtree', () => {
    expect(translateQuery('cat:cs.LG').categoryFilters).toEqual(categorySubtree('cs.LG'));
    expect(translateQuery('cat:astro-ph').categoryFilters).toEqual(categorySubtree('astro-ph'));
  });

  it('understands the subtree wildcards this server emits on the live path', () => {
    // `categorySearchTerm` can produce `cat:math.*` / `cat:astro-ph*`. Replaying an
    // echoed query through the mirror only works if the translator reads them too.
    expect(translateQuery('cat:astro-ph*').categoryFilters).toContain('astro-ph.CO');
    expect(translateQuery('cat:astro-ph*').categoryFilters).toContain('astro-ph');
    expect(translateQuery('cat:math.*').categoryFilters).toContain('math.AG');
    expect(translateQuery('cat:math.*').categoryFilters).not.toContain('math-ph');
  });
});

describe('submittedDate: window extraction (issue #27)', () => {
  it('lifts a submittedDate range out of the FTS expression into published bounds', () => {
    const { matchExpr, published } = translateQuery(
      'all:transformer AND submittedDate:[202001010000 TO 202002010000]',
    );
    expect(published.from).toBe('2020-01-01T00:00:00.000Z');
    expect(published.to).toBe('2020-02-01T00:00:00.000Z');
    // The range must not leak into FTS as bare terms.
    expect(matchExpr).not.toContain('submittedDate');
    expect(matchExpr).not.toContain('202001010000');
  });

  it('drops the operator the extracted range leaves behind', () => {
    const { matchExpr } = translateQuery('submittedDate:[202001010000 TO 202002010000]');
    expect(matchExpr).toBeUndefined();
  });

  it('narrows to the intersection when a query carries two windows', () => {
    const { published } = translateQuery(
      'submittedDate:[202001010000 TO 202004010000] AND submittedDate:[202002010000 TO 202006010000]',
    );
    expect(published.from).toBe('2020-02-01T00:00:00.000Z');
    expect(published.to).toBe('2020-04-01T00:00:00.000Z');
  });

  it('leaves a malformed range as ordinary terms rather than guessing a window', () => {
    const { published } = translateQuery('submittedDate:[2020 TO yesterday]');
    expect(published.from).toBeUndefined();
    expect(published.to).toBeUndefined();
  });

  it('reports no window when the query has none', () => {
    expect(translateQuery('all:transformer').published).toEqual({});
  });
});
