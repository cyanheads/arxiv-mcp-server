/**
 * @fileoverview Tests for arXiv category taxonomy and helpers.
 * @module services/arxiv/categories.test
 */

import { describe, expect, it } from 'vitest';
import {
  ARXIV_CATEGORIES,
  GROUPS,
  getGroup,
  suggestCategories,
  VALID_CATEGORY_CODES,
} from '@/services/arxiv/categories.js';

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

describe('VALID_CATEGORY_CODES', () => {
  it('matches every code in ARXIV_CATEGORIES', () => {
    expect(VALID_CATEGORY_CODES.size).toBe(ARXIV_CATEGORIES.length);
    for (const cat of ARXIV_CATEGORIES) {
      expect(VALID_CATEGORY_CODES.has(cat.code)).toBe(true);
    }
  });

  it('rejects unknown codes', () => {
    expect(VALID_CATEGORY_CODES.has('cs.INVALID')).toBe(false);
    expect(VALID_CATEGORY_CODES.has('foo.BAR')).toBe(false);
    expect(VALID_CATEGORY_CODES.has('')).toBe(false);
  });
});

describe('suggestCategories', () => {
  it('returns same-archive codes when the archive prefix is valid', () => {
    const suggestions = suggestCategories('cs.INVALID');
    expect(suggestions.length).toBeGreaterThan(0);
    for (const code of suggestions) {
      expect(code.startsWith('cs.')).toBe(true);
    }
  });

  it('falls back to edit-distance ranking when the prefix is unknown', () => {
    const suggestions = suggestCategories('foo.BAR');
    expect(suggestions.length).toBeGreaterThan(0);
    // Each suggestion must be a valid category code
    for (const code of suggestions) {
      expect(VALID_CATEGORY_CODES.has(code)).toBe(true);
    }
  });

  it('returns an empty list for empty input', () => {
    expect(suggestCategories('')).toEqual([]);
    expect(suggestCategories('   ')).toEqual([]);
  });

  it('respects the limit argument', () => {
    expect(suggestCategories('cs.INVALID', 2)).toHaveLength(2);
    expect(suggestCategories('cs.INVALID', 1)).toHaveLength(1);
  });
});
