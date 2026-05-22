/**
 * @fileoverview Tests for the arXiv → FTS5 query translator including
 * field prefixes, boolean operators, phrase quoting, and category-hierarchy
 * expansion via the bundled taxonomy.
 * @module services/arxiv/mirror/query.test
 */

import { describe, expect, it } from 'vitest';
import { expandCategory, translateQuery } from '@/services/arxiv/mirror/query.js';

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
