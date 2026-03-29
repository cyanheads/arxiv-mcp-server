/**
 * @fileoverview Tests for arXiv category taxonomy and helpers.
 * @module services/arxiv/categories.test
 */

import { describe, expect, it } from 'vitest';
import { ARXIV_CATEGORIES, GROUPS, getGroup } from '@/services/arxiv/categories.js';

describe('getGroup', () => {
  it('returns "physics" for physics archives', () => {
    expect(getGroup('hep-th')).toBe('physics');
    expect(getGroup('astro-ph.CO')).toBe('physics');
    expect(getGroup('quant-ph')).toBe('physics');
    expect(getGroup('cond-mat.str-el')).toBe('physics');
    expect(getGroup('nlin.CD')).toBe('physics');
  });

  it('returns prefix for non-physics categories', () => {
    expect(getGroup('cs.AI')).toBe('cs');
    expect(getGroup('math.AG')).toBe('math');
    expect(getGroup('stat.ML')).toBe('stat');
    expect(getGroup('econ.TH')).toBe('econ');
    expect(getGroup('q-bio.NC')).toBe('q-bio');
    expect(getGroup('q-fin.MF')).toBe('q-fin');
  });
});

describe('ARXIV_CATEGORIES', () => {
  it('contains categories for all groups', () => {
    for (const group of GROUPS) {
      expect(ARXIV_CATEGORIES.some((c) => c.group === group)).toBe(true);
    }
  });

  it('has no duplicate category codes', () => {
    const codes = ARXIV_CATEGORIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
