/**
 * @fileoverview Tests for arXiv category taxonomy and helpers.
 * @module services/arxiv/categories.test
 */

import { describe, expect, it } from 'vitest';
import {
  ARXIV_CATEGORIES,
  categorySearchTerm,
  categorySubtree,
  GROUPS,
  getGroup,
  SEARCHABLE_CATEGORY_CODES,
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

  it('stays the catalogue set — bare archive codes are not taxonomy entries', () => {
    expect(VALID_CATEGORY_CODES.has('astro-ph')).toBe(false);
    expect(VALID_CATEGORY_CODES.has('cs')).toBe(false);
  });
});

// Issue #32: archive- and group-level codes are heavily populated arXiv query
// targets that the leaf-only validation set rejected outright.
describe('SEARCHABLE_CATEGORY_CODES', () => {
  it('accepts every subdivided archive and group code', () => {
    for (const code of [
      'astro-ph',
      'cond-mat',
      'nlin',
      'physics',
      'q-bio',
      'q-fin',
      'cs',
      'econ',
      'eess',
      'math',
      'stat',
    ]) {
      expect(SEARCHABLE_CATEGORY_CODES.has(code)).toBe(true);
    }
  });

  it('accepts every taxonomy leaf and standalone archive', () => {
    for (const cat of ARXIV_CATEGORIES) {
      expect(SEARCHABLE_CATEGORY_CODES.has(cat.code)).toBe(true);
    }
  });

  it('still rejects codes that are neither leaf nor archive', () => {
    expect(SEARCHABLE_CATEGORY_CODES.has('cs.INVALID')).toBe(false);
    expect(SEARCHABLE_CATEGORY_CODES.has('astro')).toBe(false);
    expect(SEARCHABLE_CATEGORY_CODES.has('')).toBe(false);
  });

  it('adds exactly the eleven subdivided archives to the taxonomy set', () => {
    expect(SEARCHABLE_CATEGORY_CODES.size).toBe(VALID_CATEGORY_CODES.size + 11);
  });
});

describe('categorySubtree', () => {
  it('leaves a leaf code alone', () => {
    expect(categorySubtree('cs.LG')).toEqual(['cs.LG']);
  });

  it('leaves a standalone archive alone — it has no subtree', () => {
    expect(categorySubtree('hep-th')).toEqual(['hep-th']);
    expect(categorySubtree('quant-ph')).toEqual(['quant-ph']);
  });

  it('covers the bare archive code alongside its subject classes', () => {
    // The bare code is what legacy flat papers carry — 105,380 of them under
    // astro-ph. Expanding to the dotted children alone loses every one.
    const astro = categorySubtree('astro-ph');
    expect(astro).toContain('astro-ph');
    expect(astro).toContain('astro-ph.CO');
    expect(astro.filter((c) => c.startsWith('astro-ph.')).length).toBe(6);
  });

  it('scopes a group code to its own archive, never a prefix neighbour', () => {
    // math-ph is a physics archive that merely shares math's string prefix.
    const math = categorySubtree('math');
    expect(math).toContain('math');
    expect(math).toContain('math.AG');
    expect(math).not.toContain('math-ph');
  });

  it('reads the subtree wildcards emitted on the live path', () => {
    expect(categorySubtree('astro-ph*')).toEqual(categorySubtree('astro-ph'));
    expect(categorySubtree('math.*')).not.toContain('math-ph');
    // `X*` mirrors arXiv's own wildcard, which does reach a prefix neighbour.
    expect(categorySubtree('math*')).toContain('math-ph');
  });

  it('returns unknown codes verbatim so the caller can decide what to do', () => {
    expect(categorySubtree('zz.UNKNOWN')).toEqual(['zz.UNKNOWN']);
    expect(categorySubtree('')).toEqual([]);
  });
});

describe('categorySearchTerm', () => {
  it('matches a leaf or standalone archive exactly', () => {
    expect(categorySearchTerm('cs.CL')).toBe('cat:cs.CL');
    expect(categorySearchTerm('hep-th')).toBe('cat:hep-th');
  });

  it('wildcards a subdivided archive so the subtree is covered', () => {
    // cat:astro-ph alone is 105,380 legacy flat papers; cat:astro-ph* is 388,854.
    expect(categorySearchTerm('astro-ph')).toBe('cat:astro-ph*');
    expect(categorySearchTerm('cs')).toBe('cat:cs*');
    expect(categorySearchTerm('q-bio')).toBe('cat:q-bio*');
  });

  it('spells out the subtree where a wildcard would leak a prefix neighbour', () => {
    // cat:math* is 722,677 and pulls in math-ph (91,063 standalone). The spelled
    // form keeps math-ph out while leaving room for legacy flat math papers.
    expect(categorySearchTerm('math')).toBe('(cat:math.* OR cat:math)');
  });

  it('leaves every other archive on the plain wildcard', () => {
    for (const code of ['astro-ph', 'cond-mat', 'nlin', 'physics', 'q-bio', 'q-fin']) {
      expect(categorySearchTerm(code)).toBe(`cat:${code}*`);
    }
    for (const code of ['cs', 'econ', 'eess', 'stat']) {
      expect(categorySearchTerm(code)).toBe(`cat:${code}*`);
    }
  });

  it('agrees with categorySubtree on which codes name a subtree', () => {
    // Both sides read the same derived archive set, so live and mirror cannot
    // disagree about whether a code is a leaf or a whole archive.
    for (const code of SEARCHABLE_CATEGORY_CODES) {
      const isSubtree = categorySubtree(code).length > 1;
      expect(categorySearchTerm(code).includes('*')).toBe(isSubtree);
    }
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

  it('ranks prefix-matched suggestions by edit distance (issue #6)', () => {
    // cs.LB is a likely typo of cs.LG; previous behavior returned the first 5
    // cs.* codes alphabetically (cs.AI, cs.AR, cs.CC, ...) regardless of how
    // close they were. Edit-distance ranking surfaces cs.LG and cs.LO ahead of
    // alphabetically-earlier codes.
    const suggestions = suggestCategories('cs.LB', 5);
    expect(suggestions).toContain('cs.LG');
    expect(suggestions).toContain('cs.LO');
    expect(suggestions.indexOf('cs.LG')).toBeLessThan(suggestions.indexOf('cs.AI'));
  });

  it('ranks the longer typo cs.SAA closer to cs.SE / cs.SI / cs.SD than to cs.AI (issue #6)', () => {
    // Even when no cs.* code is a distance-1 match, the prefix branch should
    // still rank by similarity rather than declaration order.
    const suggestions = suggestCategories('cs.SAA', 5);
    // All cs.S* codes are closer to cs.SAA than cs.AI.
    expect(suggestions.indexOf('cs.AI')).toBeGreaterThan(suggestions.indexOf('cs.SE'));
  });

  it('falls back to edit-distance ranking when the prefix is unknown', () => {
    const suggestions = suggestCategories('foo.BAR');
    expect(suggestions.length).toBeGreaterThan(0);
    // Each suggestion must be something the category filter would actually accept
    for (const code of suggestions) {
      expect(SEARCHABLE_CATEGORY_CODES.has(code)).toBe(true);
    }
  });

  it('can suggest a bare archive code now that one is a valid filter', () => {
    expect(suggestCategories('condmat')).toContain('cond-mat');
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
