/**
 * @fileoverview Tests for arXiv category taxonomy and helpers.
 * @module services/arxiv/categories.test
 */

import { describe, expect, it } from 'vitest';
import {
  ARXIV_CATEGORIES,
  canonicalCategory,
  categorySearchTerm,
  categorySubtree,
  GROUPS,
  getGroup,
  SEARCHABLE_CATEGORY_CODES,
  suggestCategories,
  VALID_CATEGORY_CODES,
} from '@/services/arxiv/categories.js';

/**
 * arxiv-base `arxiv/taxonomy/definitions.py` `CATEGORY_ALIASES`: alias → the
 * canonical code, which is the one the Atom API returns and indexes.
 */
const ALIASES: [alias: string, canonical: string][] = [
  ['math.MP', 'math-ph'],
  ['stat.TH', 'math.ST'],
  ['math.IT', 'cs.IT'],
  ['q-fin.EC', 'econ.GN'],
  ['cs.SY', 'eess.SY'],
  ['cs.NA', 'math.NA'],
];

/** arxiv-base `ARCHIVES_SUBSUMED`: defunct archive → the category that subsumed it. */
const SUBSUMED: [archive: string, successor: string][] = [
  ['cmp-lg', 'cs.CL'],
  ['adap-org', 'nlin.AO'],
  ['comp-gas', 'nlin.CG'],
  ['chao-dyn', 'nlin.CD'],
  ['solv-int', 'nlin.SI'],
  ['patt-sol', 'nlin.PS'],
  ['alg-geom', 'math.AG'],
  ['dg-ga', 'math.DG'],
  ['funct-an', 'math.FA'],
  ['q-alg', 'math.QA'],
  ['mtrl-th', 'cond-mat.mtrl-sci'],
  ['supr-con', 'cond-mat.supr-con'],
  ['acc-phys', 'physics.acc-ph'],
  ['ao-sci', 'physics.ao-ph'],
  ['atom-ph', 'physics.atom-ph'],
  ['bayes-an', 'physics.data-an'],
  ['chem-ph', 'physics.chem-ph'],
  ['plasm-ph', 'physics.plasm-ph'],
];

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

  it('scopes a group code to its own archive, reaching a prefix neighbour only as an alias', () => {
    // math-ph is a physics archive that merely shares math's string prefix. It
    // enters the math subtree once, as the canonical code of math.MP (#99).
    const math = categorySubtree('math');
    expect(math).toContain('math');
    expect(math).toContain('math.AG');
    expect(math.filter((code) => code === 'math-ph')).toEqual(['math-ph']);
    expect(math).not.toContain('math.MP');
  });

  it('reads the subtree wildcards emitted on the live path', () => {
    expect(categorySubtree('astro-ph*')).toEqual(categorySubtree('astro-ph'));
    // `X.*` names the dotted children only, never the bare legacy code.
    expect(categorySubtree('math.*')).not.toContain('math');
    expect(categorySubtree('math.*')).toContain('math.AG');
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
    expect(categorySearchTerm('cs')).toBe('(cat:cs* OR cat:math.NA OR cat:eess.SY)');
    expect(categorySearchTerm('q-bio')).toBe('cat:q-bio*');
  });

  it('spells out the subtree where a wildcard would leak a prefix neighbour', () => {
    // cat:math* is 722,677 and pulls in math-ph (91,063 standalone) by prefix.
    // The spelled form keeps the prefix out while leaving room for legacy flat
    // math papers; math-ph comes back only as math.MP's canonical code (#99).
    expect(categorySearchTerm('math')).toBe('(cat:math.* OR cat:math OR cat:cs.IT OR cat:math-ph)');
    expect(categorySearchTerm('math')).not.toContain('cat:math*');
  });

  it('leaves every archive holding no alias on the plain wildcard', () => {
    for (const code of ['astro-ph', 'cond-mat', 'nlin', 'physics', 'q-bio', 'econ', 'eess']) {
      expect(categorySearchTerm(code)).toBe(`cat:${code}*`);
    }
    expect(categorySearchTerm('astro-ph.*')).toBe('cat:astro-ph.*');
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

// Issue #99: the Atom API returns, and its search indexes, only canonical codes,
// while arXivRaw (the mirror's source) keeps the alias and subsumed codes too.
describe('canonicalCategory', () => {
  it.each(ALIASES)('maps the alias %s to %s', (alias, canonical) => {
    expect(canonicalCategory(alias)).toBe(canonical);
  });

  it.each(SUBSUMED)('maps the subsumed archive %s to %s', (archive, successor) => {
    expect(canonicalCategory(archive)).toBe(successor);
  });

  it('leaves every other taxonomy code, and a code it does not know, as written', () => {
    const aliases = new Set(ALIASES.map(([alias]) => alias));
    for (const { code } of ARXIV_CATEGORIES) {
      if (!aliases.has(code)) expect(canonicalCategory(code)).toBe(code);
    }
    expect(canonicalCategory('astro-ph')).toBe('astro-ph');
    expect(canonicalCategory('zz.UNKNOWN')).toBe('zz.UNKNOWN');
  });

  it('maps every code onto a taxonomy code that maps to itself', () => {
    for (const [, target] of [...ALIASES, ...SUBSUMED]) {
      expect(VALID_CATEGORY_CODES.has(target)).toBe(true);
      expect(canonicalCategory(target)).toBe(target);
    }
  });
});

describe('alias codes in search (#99)', () => {
  it.each(ALIASES)('reads the alias %s as %s on the mirror', (alias, canonical) => {
    // One code, so a term-less mirror search on it counts exactly.
    expect(categorySubtree(alias)).toEqual([canonical]);
  });

  it.each(ALIASES)('sends the alias %s live as cat:%s', (alias, canonical) => {
    // arXiv's search matches no alias code: `cat:cs.NA` totals 0.
    expect(categorySearchTerm(alias)).toBe(`cat:${canonical}`);
  });

  it.each([
    ['cs', ['math.NA', 'eess.SY'], ['cs.NA', 'cs.SY']],
    ['math', ['cs.IT', 'math-ph'], ['math.IT', 'math.MP']],
    ['stat', ['math.ST'], ['stat.TH']],
    ['q-fin', ['econ.GN'], ['q-fin.EC']],
  ])('puts the canonical code in place of each alias in the %s subtree', (archive, added, gone) => {
    const subtree = categorySubtree(archive);
    for (const code of added) expect(subtree).toContain(code);
    for (const code of gone) expect(subtree).not.toContain(code);
    expect(new Set(subtree).size).toBe(subtree.length);
  });

  it.each([
    ['cs', '(cat:cs* OR cat:math.NA OR cat:eess.SY)'],
    ['math', '(cat:math.* OR cat:math OR cat:cs.IT OR cat:math-ph)'],
    ['stat', '(cat:stat* OR cat:math.ST)'],
    ['q-fin', '(cat:q-fin* OR cat:econ.GN)'],
    // A wildcard the caller wrote reaches the canonical codes of the aliases it spans.
    ['cs*', '(cat:cs* OR cat:math.NA OR cat:eess.SY)'],
    ['cs.*', '(cat:cs.* OR cat:math.NA OR cat:eess.SY)'],
    ['cs.N*', '(cat:cs.N* OR cat:math.NA)'],
    ['math.*', '(cat:math.* OR cat:cs.IT OR cat:math-ph)'],
    // `cat:math*` already reaches math-ph by prefix, so only cs.IT is added.
    ['math*', '(cat:math* OR cat:cs.IT)'],
  ])('sends %s live with the canonical codes of its aliases: %s', (code, term) => {
    expect(categorySearchTerm(code)).toBe(term);
  });

  it('leaves a subsumed archive code as written in search', () => {
    // Outside the searchable taxonomy: `category` rejects it, and a `cat:` operand
    // naming one keeps its literal meaning on each path.
    expect(categorySubtree('chao-dyn')).toEqual(['chao-dyn']);
    expect(categorySearchTerm('chao-dyn')).toBe('cat:chao-dyn');
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
