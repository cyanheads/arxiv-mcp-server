/**
 * @fileoverview Tests for the arXiv → FTS5 query translator including
 * field prefixes, boolean operators, phrase quoting, category-hierarchy
 * expansion via the bundled taxonomy, and parenthesis-boundary adjacency
 * (issue #13) verified against a real in-memory FTS5 index.
 * @module services/arxiv/mirror/query.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandCategory, translateQuery } from '@/services/arxiv/mirror/query.js';
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

  it('expands group-level cat:cs to every cs.* code in the taxonomy', () => {
    const { matchExpr, categoryFilters } = translateQuery('attention AND cat:cs');
    expect(matchExpr).toBe('"attention"');
    expect(categoryFilters.length).toBeGreaterThan(10);
    expect(categoryFilters).toContain('cs.LG');
    expect(categoryFilters).toContain('cs.AI');
    expect(categoryFilters.every((c) => c.startsWith('cs.'))).toBe(true);
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

describe('expandCategory', () => {
  it('returns a single code untouched when fully qualified', () => {
    expect(expandCategory('cs.LG')).toEqual(['cs.LG']);
  });

  it('expands group codes (cs, math, physics, …) to all member categories', () => {
    const cs = expandCategory('cs');
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.startsWith('cs.'))).toBe(true);
  });

  it('expands archive codes inside physics with sub-categories (e.g. astro-ph)', () => {
    const astro = expandCategory('astro-ph');
    expect(astro.length).toBeGreaterThan(0);
    expect(astro.every((c) => c.startsWith('astro-ph.'))).toBe(true);
  });

  it('returns archive codes that have no sub-categories untouched (e.g. hep-th)', () => {
    expect(expandCategory('hep-th')).toEqual(['hep-th']);
  });

  it('returns unknown codes verbatim so the caller can decide what to do', () => {
    expect(expandCategory('zz.UNKNOWN')).toEqual(['zz.UNKNOWN']);
  });
});
