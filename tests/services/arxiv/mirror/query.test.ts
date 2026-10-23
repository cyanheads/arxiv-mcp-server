/**
 * @fileoverview Tests for the arXiv → FTS5 query translator including
 * field prefixes, boolean operators, phrase quoting, category-subtree
 * expansion via the bundled taxonomy, `submittedDate:` window extraction
 * (issue #27), parenthesis-boundary adjacency (issue #13), `cat:`
 * extraction cleanup inside parens (issue #14), the live-path `cat:` rewrite
 * (issue #36), and the `co:` / `jr:` column routing schema v3 makes possible
 * (issue #37), and arXiv's own grammar — adjacency as `OR`, one right-grouped
 * precedence, case-sensitive operators, and the queries that go live (issue
 * #82) — all verified against a real in-memory FTS5 index, the last also by a
 * randomized differential against an independent evaluator of that grammar.
 * @module services/arxiv/mirror/query.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  categorySearchTerm,
  categorySubtree,
  SEARCHABLE_CATEGORY_CODES,
} from '@/services/arxiv/categories.js';
import {
  expandCategoryOperands,
  type MirrorQuery,
  translateQuery,
} from '@/services/arxiv/mirror/query.js';
import { MirrorStore } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

/**
 * The expansion `all:` emits — one disjunct per indexed FTS column. Spelled out
 * literally once, in the `expands all:` case below; every other assertion uses
 * this so it keeps testing operator/paren structure rather than the column list.
 */
const allCols = (v: string): string =>
  `(title:"${v}" OR authors:"${v}" OR abstract:"${v}" OR comment:"${v}" OR journal_ref:"${v}")`;

/** The mirror's translation of `query`, failing the test when the query goes live instead. */
function mirrored(query: string): MirrorQuery {
  const translated = translateQuery(query);
  if (translated.route === 'live') {
    throw new Error(`${query} routes live (${translated.reason}), expected the mirror`);
  }
  return translated;
}

describe('translateQuery', () => {
  it('passes bare words straight through as a quoted FTS term', () => {
    const { matchExpr, categoryGroups } = mirrored('hello');
    expect(matchExpr).toBe('"hello"');
    expect(categoryGroups).toEqual([]);
  });

  it('maps field prefixes to FTS columns', () => {
    expect(mirrored('ti:transformer').matchExpr).toBe('title:"transformer"');
    expect(mirrored('au:knuth').matchExpr).toBe('authors:"knuth"');
    expect(mirrored('abs:dynamics').matchExpr).toBe('abstract:"dynamics"');
    // co: and jr: are documented prefixes that used to fall through to bare-token
    // handling and match nothing (#37).
    expect(mirrored('co:ICML').matchExpr).toBe('comment:"ICML"');
    expect(mirrored('jr:Nature').matchExpr).toBe('journal_ref:"Nature"');
  });

  it('keeps a quoted co:/jr: value one phrase instead of splintering it', () => {
    // The old bare-token path produced `"co:""12" "pages"""` — three tokens,
    // none of them the phrase the caller asked for.
    expect(mirrored('co:"12 pages"').matchExpr).toBe('comment:"12 pages"');
    expect(mirrored('jr:"Nature Physics 17"').matchExpr).toBe('journal_ref:"Nature Physics 17"');
  });

  it('leaves an unrecognized prefix as a bare term rather than inventing a column', () => {
    // Unknown prefixes still reach FTS as literal text, so adding co:/jr: to the
    // field map cannot have changed the meaning of any other `word:value` input.
    expect(mirrored('doi:10.1000/xyz').matchExpr).toBe('"doi:10.1000/xyz"');
    // A prefix named like an Object.prototype member is no field either.
    expect(mirrored('constructor:x').matchExpr).toBe('"constructor:x"');
    expect(mirrored('ti:a AND Constructor:x').matchExpr).toBe('title:"a" AND "Constructor:x"');
  });

  it('expands all: across every indexed FTS column', () => {
    // co:/jr: are documented prefixes, so `all:` has to reach comment and
    // journal_ref too or the mirror answers a narrower question than the live
    // API does for the same input (#37).
    const { matchExpr } = mirrored('all:dark');
    expect(matchExpr).toBe(
      '(title:"dark" OR authors:"dark" OR abstract:"dark" OR comment:"dark" OR journal_ref:"dark")',
    );
  });

  it('translates boolean operators including ANDNOT → NOT', () => {
    expect(mirrored('a AND b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('a OR b').matchExpr).toBe('"a" OR "b"');
    expect(mirrored('a ANDNOT b').matchExpr).toBe('"a" NOT "b"');
  });

  it('preserves quoted phrases as single FTS tokens', () => {
    const { matchExpr } = mirrored('ti:"deep learning"');
    expect(matchExpr).toBe('title:"deep learning"');
  });

  it('extracts cat: operands as structured filters and removes them from the FTS expression', () => {
    const { matchExpr, categoryGroups } = mirrored('transformer AND cat:cs.LG');
    expect(matchExpr).toBe('"transformer"');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('expands archive-level cat:cs to the bare code plus every cs.* code', () => {
    const { matchExpr, categoryGroups } = mirrored('attention AND cat:cs');
    expect(matchExpr).toBe('"attention"');
    expect(categoryGroups).toHaveLength(1);
    const [codes = []] = categoryGroups;
    expect(codes.length).toBeGreaterThan(10);
    expect(codes).toContain('cs.LG');
    expect(codes).toContain('cs.AI');
    // The bare archive code carries legacy flat papers filed before the archive
    // was subdivided; dropping it makes the mirror narrower than live (#32).
    expect(codes).toContain('cs');
    expect(codes.every((c) => c === 'cs' || c.startsWith('cs.'))).toBe(true);
  });

  it('drops dangling boolean operators when cat: is the sole non-operator term', () => {
    const { matchExpr, categoryGroups } = mirrored('cat:cs.LG');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('routes an empty query live rather than matching every paper (#82)', () => {
    expect(translateQuery('')).toEqual({ route: 'live', reason: 'empty_query' });
  });

  it('escapes embedded quotes by doubling them', () => {
    const { matchExpr } = mirrored('ti:foo"bar');
    expect(matchExpr).toBe('title:"foo""bar"');
  });

  it('honors parentheses for grouping', () => {
    const { matchExpr } = mirrored('(a OR b) AND c');
    expect(matchExpr).toBe('("a" OR "b") AND "c"');
  });
});

describe('translateQuery — adjacency joins with OR, never an implicit FTS5 join (issues #13, #82)', () => {
  // arXiv joins operands with no operator between them with OR (it echoes
  // `ti:quantum ti:graph` as `ti:quantum OR ti:graph`). The emitted expression
  // spells every join out, so FTS5's implicit AND — valid only between bare
  // phrases (#13) — never reaches it.
  it('joins a bare term and an all: expansion with OR', () => {
    expect(mirrored('language all:automated').matchExpr).toBe(
      `"language" OR ${allCols('automated')}`,
    );
  });

  it('joins an all: expansion and a trailing bare term with OR', () => {
    expect(mirrored('all:dark matter').matchExpr).toBe(`${allCols('dark')} OR "matter"`);
  });

  it('groups a run of adjacent operands to the right', () => {
    expect(mirrored('all:language "language" all:automated').matchExpr).toBe(
      `${allCols('language')} OR ("language" OR ${allCols('automated')})`,
    );
  });

  it('joins two user-parenthesized groups with OR', () => {
    expect(mirrored('(foo) (bar)').matchExpr).toBe('("foo") OR ("bar")');
  });

  it('joins a bare term and a user-parenthesized all: group with OR', () => {
    expect(mirrored('bar (all:foo)').matchExpr).toBe(`"bar" OR (${allCols('foo')})`);
  });

  it('joins bare phrases with OR', () => {
    expect(mirrored('foo bar').matchExpr).toBe('"foo" OR "bar"');
  });

  it('joins column qualifiers and phrases with OR', () => {
    expect(mirrored('ti:foo bar').matchExpr).toBe('title:"foo" OR "bar"');
    expect(mirrored('foo ti:bar').matchExpr).toBe('"foo" OR title:"bar"');
  });

  it('preserves explicit operators without doubling them up', () => {
    expect(mirrored('a AND (b OR c)').matchExpr).toBe('"a" AND ("b" OR "c")');
    expect(mirrored('(a OR b) AND c').matchExpr).toBe('("a" OR "b") AND "c"');
    expect(mirrored('a ANDNOT (b OR c)').matchExpr).toBe('"a" NOT ("b" OR "c")');
  });

  it('joins consecutive all: expansions with OR', () => {
    expect(mirrored('all:foo all:bar').matchExpr).toBe(`${allCols('foo')} OR ${allCols('bar')}`);
  });

  it('joins across literal-paren ↔ all: boundaries in both directions with OR', () => {
    expect(mirrored('(a) all:b').matchExpr).toBe(`("a") OR ${allCols('b')}`);
    expect(mirrored('all:b (a)').matchExpr).toBe(`${allCols('b')} OR ("a")`);
  });

  it('does NOT insert AND when an explicit operator already bridges a paren boundary', () => {
    expect(mirrored('attention OR all:transformer').matchExpr).toBe(
      `"attention" OR ${allCols('transformer')}`,
    );
    expect(mirrored('a ANDNOT all:b').matchExpr).toBe(`"a" NOT ${allCols('b')}`);
  });
});

describe('translateQuery — cat: extraction cleanup (issue #14)', () => {
  // -------------------------------------------------------------------------
  // The six failing shapes from the issue's table.
  // -------------------------------------------------------------------------

  it('routes (cat OR term) live: the OR cannot become a filter beside the match (#65)', () => {
    expect(translateQuery('(cat:cs.LG OR term)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('routes (term OR cat) live: the OR cannot become a filter beside the match (#65)', () => {
    expect(translateQuery('(term OR cat:cs.LG)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('drops dangling AND when cat: opens a parenthesized group', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG AND term)');
    expect(matchExpr).toBe('("term")');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('collapses an empty group to no matchExpr when cat: was the sole operand', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG)');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('collapses to no matchExpr when every operand in a group is cat:', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG OR cat:cs.AI)');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups.map((group) => group.sort())).toEqual([['cs.AI', 'cs.LG']]);
  });

  it('routes (cat OR cat OR term) live: the term is OR-ed with the categories (#65)', () => {
    expect(translateQuery('(cat:cs.LG OR cat:cs.AI OR term)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  // -------------------------------------------------------------------------
  // Broader cleanup scenarios — cleanup must handle every operator/paren
  // boundary, not just the shapes in the issue table.
  // -------------------------------------------------------------------------

  it('joins surviving operands when cat: sits between two terms at top level', () => {
    expect(mirrored('a AND cat:cs.LG AND b').matchExpr).toBe('"a" AND "b"');
  });

  it('drops a leading operator when cat: was the first token at top level', () => {
    const { matchExpr, categoryGroups } = mirrored('cat:cs.LG AND a');
    expect(matchExpr).toBe('"a"');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('drops a trailing operator when cat: was the last token at top level', () => {
    const { matchExpr, categoryGroups } = mirrored('a AND cat:cs.LG');
    expect(matchExpr).toBe('"a"');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('removes an emptied group from the middle of a larger expression', () => {
    expect(mirrored('term AND (cat:cs.LG)').matchExpr).toBe('"term"');
    expect(mirrored('(cat:cs.LG) AND term').matchExpr).toBe('"term"');
  });

  it('handles nested groups where the inner group empties out', () => {
    expect(mirrored('(a AND (cat:cs.LG))').matchExpr).toBe('("a")');
  });

  it('routes a AND cat OR b live: the cat: sits under the OR (#65)', () => {
    // arXiv reads it as (a AND cat:cs.LG) OR b; no category filter expresses that.
    expect(translateQuery('a AND cat:cs.LG OR b')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('routes (a OR cat OR b) live: the cat: is one disjunct among terms (#65)', () => {
    expect(translateQuery('(a OR cat:cs.LG OR b)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('keeps two AND-ed cat: operands as two groups, intersected, when matchExpr collapses (#65)', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG AND cat:cs.AI)');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toEqual([['cs.LG'], ['cs.AI']]);
  });

  it('routes (term OR cat:cs) live: an archive subtree OR-ed with a term (#65)', () => {
    expect(translateQuery('(term OR cat:cs)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('does not regress non-cat parenthesized queries', () => {
    expect(mirrored('(a OR b)').matchExpr).toBe('("a" OR "b")');
    expect(mirrored('(a AND b) OR c').matchExpr).toBe('("a" AND "b") OR "c"');
  });

  it('does not insert AND across a cleanup-emptied paren boundary', () => {
    // After cleanup the trailing `()` is gone — issue #13's adjacency
    // pass must not re-inject an AND between `"term"` and nothing.
    expect(mirrored('term AND (cat:cs.LG)').matchExpr).toBe('"term"');
  });

  it('routes cat: OR-ed with an all: expansion inside parens live (#65)', () => {
    expect(translateQuery('(all:dark OR cat:cs.LG)')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('handles cat: as the sole operand alongside an all: expansion', () => {
    const { matchExpr, categoryGroups } = mirrored('all:dark AND cat:cs.LG');
    expect(matchExpr).toBe(allCols('dark'));
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('routes cat: OR-ed with a phrase inside parens live (#65)', () => {
    expect(translateQuery('(cat:cs.LG OR "deep learning")')).toEqual({
      route: 'live',
      reason: 'filter_not_conjunct',
    });
  });

  it('handles a single cat: at top level with no other tokens', () => {
    const { matchExpr, categoryGroups } = mirrored('cat:cs.LG');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('handles multiple consecutive cat: at top level with no other tokens', () => {
    const { matchExpr, categoryGroups } = mirrored('cat:cs.LG OR cat:cs.AI OR cat:cs.CL');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups.map((group) => group.sort())).toEqual([['cs.AI', 'cs.CL', 'cs.LG']]);
  });
});

describe('translateQuery — operators around cat: and submittedDate: operands (issue #65)', () => {
  const live = (reason: string) => ({ route: 'live', reason });
  const window2020 = 'submittedDate:[202001010000 TO 202101010000]';
  const window2022 = 'submittedDate:[202201010000 TO 202301010000]';

  it('gives each lifted cat: conjunct its own group, so the codes intersect', () => {
    expect(mirrored('cat:cs.LG AND cat:math.AG').categoryGroups).toEqual([['cs.LG'], ['math.AG']]);
    // Adjacency is OR (#82): one group, so the codes unite.
    expect(mirrored('cat:cs.LG cat:math.AG').categoryGroups).toEqual([['cs.LG', 'math.AG']]);
  });

  it('lifts an OR-ed set of cat: operands beside a term as one category group', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG OR cat:cs.AI) AND transformer');
    expect(matchExpr).toBe('"transformer"');
    expect(categoryGroups).toEqual([['cs.LG', 'cs.AI']]);
  });

  it('reads the echoed form of a query cat: beside the category parameter as two groups', () => {
    const { matchExpr, categoryGroups } = mirrored(
      '(cat:cs.LG OR cat:cs.AI) AND (cat:math.* OR cat:math)',
    );
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toHaveLength(2);
    expect(categoryGroups[0]).toEqual(['cs.LG', 'cs.AI']);
    expect([...(categoryGroups[1] ?? [])].sort()).toEqual([...categorySubtree('math')].sort());
  });

  it('unions nested OR-ed cat: groups into one category group', () => {
    expect(mirrored('cat:cs.LG OR (cat:cs.AI OR (cat:math.AG))').categoryGroups).toEqual([
      ['cs.LG', 'cs.AI', 'math.AG'],
    ]);
  });

  it('keeps a cat: on the left of an ANDNOT a conjunct, and the ANDNOT in the match', () => {
    const { matchExpr, categoryGroups } = mirrored('au:"hinton g" AND cat:cs.LG ANDNOT ti:survey');
    expect(matchExpr).toBe('authors:"hinton g" NOT title:"survey"');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('lifts a conjunct from inside a group that is itself a conjunct', () => {
    const { matchExpr, categoryGroups } = mirrored('(cat:cs.LG AND (a ANDNOT b)) AND c');
    expect(matchExpr).toBe('(("a" NOT "b")) AND "c"');
    expect(categoryGroups).toEqual([['cs.LG']]);
  });

  it('lifts a submittedDate: conjunct into the published bounds', () => {
    expect(mirrored(`transformer AND ${window2020}`)).toEqual({
      route: 'mirror',
      matchExpr: '"transformer"',
      categoryGroups: [],
      published: { from: '2020-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z' },
    });
  });

  it.each([
    'transformer ANDNOT cat:cs.AI',
    'transformer OR cat:cs.AI',
    'cat:cs.LG ANDNOT cat:cs.AI',
    'ti:a ANDNOT ti:b AND cat:cs.LG',
    'a AND cat:cs.LG OR b',
    '(cat:cs.LG AND cat:cs.AI) OR cat:math.AG',
    '(cat:cs.LG OR cat:cs.AI) OR transformer',
    'transformer ANDNOT (cat:cs.LG OR cat:cs.AI)',
    '(transformer ANDNOT cat:cs.AI) AND cat:cs.LG',
    `transformer ANDNOT ${window2020}`,
    `transformer OR ${window2020}`,
    `${window2020} OR ${window2022}`,
    `cat:cs.LG OR ${window2020}`,
  ])('routes %s live: a filter that is not a conjunct of the whole query', (query) => {
    expect(translateQuery(query)).toEqual(live('filter_not_conjunct'));
  });

  it.each([
    'cat:cs.AI ANDNOT transformer',
    'cat:cs.AI AND cat:cs.LG ANDNOT transformer',
    '(cat:cs.LG OR cat:cs.AI) ANDNOT transformer',
    `${window2020} ANDNOT transformer`,
    // A conjunct group whose residual is negated alone.
    '(cat:cs.LG ANDNOT a) AND b',
  ])('routes %s live: once the filters are lifted, no positive term is left', (query) => {
    expect(translateQuery(query)).toEqual(live('no_positive_term'));
  });

  it.each(['(a', 'a)', '(cat:cs.LG AND a', 'cat:cs.LG) AND (a'])(
    'routes %s live: its grouping has no single reading',
    (query) => {
      expect(translateQuery(query)).toEqual(live('unbalanced_parens'));
    },
  );

  it('groups everything right of an operator, which FTS5 would split by its own precedence', () => {
    // FTS5 binds NOT tighter than AND, so `"a" NOT "b" AND "c"` means (a ∧ ¬b) ∧ c.
    expect(mirrored('a ANDNOT b AND c').matchExpr).toBe('"a" NOT ("b" AND "c")');
    expect(mirrored('a ANDNOT b c').matchExpr).toBe('"a" NOT ("b" OR "c")');
    expect(mirrored('a ANDNOT b AND (c OR d)').matchExpr).toBe('"a" NOT ("b" AND ("c" OR "d"))');
    expect(mirrored('a OR b ANDNOT c AND d').matchExpr).toBe('"a" OR ("b" NOT ("c" AND "d"))');
  });

  it('groups an ANDNOT chain to the right (#82)', () => {
    // arXiv echoes `a ANDNOT b ANDNOT c` as `a ANDNOT (b ANDNOT c)`.
    expect(mirrored('a ANDNOT b ANDNOT c').matchExpr).toBe('"a" NOT ("b" NOT "c")');
    expect(mirrored('a AND b ANDNOT c').matchExpr).toBe('"a" AND ("b" NOT "c")');
  });

  it('routes a cat: joined to a term by adjacency live: adjacency is OR (#82)', () => {
    expect(translateQuery('a cat:cs.LG AND b')).toEqual(live('filter_not_conjunct'));
    expect(translateQuery('a cat:cs.LG b')).toEqual(live('filter_not_conjunct'));
  });

  it('reads stray operators and empty groups as it always has', () => {
    expect(mirrored('AND a OR').matchExpr).toBe('"a"');
    expect(mirrored('a AND OR b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('a OR AND b').matchExpr).toBe('"a" OR "b"');
    expect(mirrored('a AND () OR b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('(OR a ANDNOT)').matchExpr).toBe('("a")');
    // Nothing is left to match, which the mirror would answer with every paper (#82).
    expect(translateQuery('()')).toEqual(live('empty_query'));
  });
});

describe('translateQuery — arXiv’s query grammar (issue #82)', () => {
  const live = (reason: string) => ({ route: 'live', reason });

  // Each expected expression spells out the parse arXiv echoes for the query in
  // its feed's <link href> (probed 2026-10-23), e.g. `ti:quantum and ti:graph`
  // → `ti:quantum OR (all:and OR ti:graph)`.
  it.each([
    ['ti:quantum ti:graph', 'title:"quantum" OR title:"graph"'],
    ['quantum computing', '"quantum" OR "computing"'],
    [
      'ti:quantum AND ti:graph OR ti:neural',
      'title:"quantum" AND (title:"graph" OR title:"neural")',
    ],
    [
      'ti:quantum ANDNOT ti:graph OR ti:neural',
      'title:"quantum" NOT (title:"graph" OR title:"neural")',
    ],
    [
      'ti:quantum ANDNOT ti:graph ANDNOT ti:neural',
      'title:"quantum" NOT (title:"graph" NOT title:"neural")',
    ],
    [
      'ti:quantum OR ti:graph ANDNOT ti:neural',
      'title:"quantum" OR (title:"graph" NOT title:"neural")',
    ],
    [
      'ti:quantum ANDNOT ti:graph OR ti:neural ANDNOT ti:network',
      'title:"quantum" NOT (title:"graph" OR (title:"neural" NOT title:"network"))',
    ],
    ['ti:quantum andnot ti:graph', 'title:"quantum" OR ("andnot" OR title:"graph")'],
    ['ti:quantum AND NOT ti:graph', 'title:"quantum" NOT title:"graph"'],
  ])('reads %s as arXiv does', (query, expected) => {
    expect(mirrored(query).matchExpr).toBe(expected);
  });

  it('treats only the uppercase words as operators', () => {
    // A non-uppercase operator word is a term, and `and` / `or` / `not` are words
    // arXiv's index drops, so the query goes live.
    expect(translateQuery('a And b')).toEqual(live('stopword_term'));
    expect(translateQuery('a Or b')).toEqual(live('stopword_term'));
    expect(mirrored('a AndNot b').matchExpr).toBe('"a" OR ("AndNot" OR "b")');
    // NOT is an operator word only straight after AND.
    expect(translateQuery('a NOT b')).toEqual(live('stopword_term'));
    expect(translateQuery('a AND not b')).toEqual(live('stopword_term'));
    expect(translateQuery('a and NOT b')).toEqual(live('stopword_term'));
    // A quoted operator word is a phrase, and a one-word phrase of a dropped word goes live.
    expect(translateQuery('a "AND" b')).toEqual(live('stopword_term'));
    expect(mirrored('a "ANDNOT" b').matchExpr).toBe('"a" OR ("ANDNOT" OR "b")');
  });

  it('reads AND NOT as ANDNOT across any whitespace and before a group', () => {
    expect(mirrored('a AND\n\tNOT b').matchExpr).toBe('"a" NOT "b"');
    expect(mirrored('a AND NOT(b OR c)').matchExpr).toBe('"a" NOT ("b" OR "c")');
    expect(mirrored('a AND NOT b AND NOT c').matchExpr).toBe('"a" NOT ("b" NOT "c")');
    // A NOT that is part of a longer word is a term.
    expect(mirrored('a AND NOTE').matchExpr).toBe('"a" AND "NOTE"');
  });

  it.each(
    ['ti', 'au', 'abs', 'co', 'jr', 'all', 'cat'].flatMap((prefix) =>
      [
        `${prefix}: x`,
        `${prefix}:\tx`,
        `${prefix}:\nx`,
        `${prefix}:`,
        `x AND ${prefix}:`,
        `x OR ${prefix}:`,
        `x ${prefix}:`,
        `(${prefix}:)`,
        `x AND (${prefix}:)`,
        `${prefix}:(x)`,
        `${prefix}:""`,
        `${prefix}:"  "`,
        `${prefix}:"`,
        `${prefix.toUpperCase()}: x`,
      ].map((query) => [query]),
    ),
  )('routes %j live: a field prefix with no value', (query) => {
    expect(translateQuery(query)).toEqual(live('empty_field_value'));
  });

  it.each(['""', '"  "', '"\t"', 'x AND ""', 'x ""', '("")', '"'])(
    'routes %j live: a quoted phrase with no words',
    (query) => {
      expect(translateQuery(query)).toEqual(live('empty_phrase'));
    },
  );

  it.each(['', '   ', '()', '(())', '( )', 'AND', 'AND OR ANDNOT', '(AND)', 'AND NOT'])(
    'routes %j live: nothing is left to match',
    (query) => {
      expect(translateQuery(query)).toEqual(live('empty_query'));
    },
  );

  it.each([
    'rn:CERN',
    'id:2401.12345',
    'ti:quantum AND rn:CERN',
    'x OR id:2401.12345',
    '(id:2401.12345)',
    'RN:cern',
    'rn:"CERN TH"',
    'rn:',
    // A date filter the mirror has no column for, and a submittedDate: that is no
    // whole `[YYYYMMDDHHMM TO YYYYMMDDHHMM]` range.
    'lastUpdatedDate:[202410010000 TO 202410012359]',
    'ti:graphene AND (lastUpdatedDate:[202410010000 TO 202410012359])',
    'LASTUPDATEDDATE:[202410010000 TO 202410012359]',
    'submittedDate:[20240101 TO 20240131] AND ti:graphene',
    'ti:graphene AND submittedDate:[2024',
  ])('routes %j live: a field the mirror does not index', (query) => {
    expect(translateQuery(query)).toEqual(live('field_not_in_mirror'));
  });

  it('keeps a whole submittedDate: range on the mirror as a window', () => {
    expect(mirrored('submittedDate:[202401010000 TO 202412312359] AND ti:diffusion')).toEqual({
      route: 'mirror',
      matchExpr: 'title:"diffusion"',
      categoryGroups: [],
      published: { from: '2024-01-01T00:00:00.000Z', to: '2024-12-31T23:59:00.000Z' },
    });
  });

  it.each([
    '(mixture of experts) AND ti:routing',
    'ti:quantum or ti:graph',
    'ti:quantum and ti:graph',
    'ti:transformer AND (agents for the web)',
    'all:of',
    'ti:"The"',
    'au:with',
    'x AND NOT not',
    'graph neural networks AND cat:cs.LG ANDNOT survey of methods',
    ...[
      'of',
      'and',
      'or',
      'to',
      'the',
      'for',
      'in',
      'on',
      'with',
      'not',
      'by',
      'is',
      'as',
      'an',
    ].map((word) => `quantum ${word} computing`),
  ])('routes %j live: a word arXiv’s index drops', (query) => {
    // arXiv matches 213 papers for all:of and 634 for all:and, against 2,685,496 for
    // all:we; the mirror's index keeps both words (over 3 million papers each), so
    // beside OR they would widen the answer to nearly every paper.
    expect(translateQuery(query)).toEqual(live('stopword_term'));
  });

  it('keeps a dropped word inside a longer phrase, and a word arXiv indexes, on the mirror', () => {
    expect(mirrored('"mixture of experts" AND ti:routing').matchExpr).toBe(
      '"mixture of experts" AND title:"routing"',
    );
    expect(mirrored('ti:quantum andnot ti:graph').matchExpr).toBe(
      'title:"quantum" OR ("andnot" OR title:"graph")',
    );
    // arXiv's all:a matches 1,027,834 papers (author initials): a is indexed.
    expect(mirrored('au:a').matchExpr).toBe('authors:"a"');
  });

  it('keeps rn: and id: inside a quoted phrase as text', () => {
    expect(mirrored('ti:"rn:CERN"').matchExpr).toBe('title:"rn:CERN"');
  });

  it.each([
    'cat:zzz.*',
    'cat:zzz*',
    'quantum AND cat:zzz*',
    'cat:zzz.* OR cat:yyy*',
    'cat:zzz.* cat:yyy*',
    '(cat:zzz.*) AND quantum',
    'cat:cs.LG AND cat:zzz.*',
    'quantum AND (cat:cs.LG AND (cat:zzz.* OR cat:yyy.*))',
  ])('routes %s live: a lifted category filter names no code', (query) => {
    // An empty group would be dropped downstream, widening the search to papers
    // in every category; the mirror never drops a filter the caller wrote.
    expect(translateQuery(query)).toEqual(live('empty_category'));
  });

  it('keeps an OR-ed set of cat: operands whose union names a code', () => {
    // A wildcard naming no code adds nothing to a union that still has one.
    expect(mirrored('quantum AND (cat:zzz.* OR cat:cs.LG)')).toEqual({
      route: 'mirror',
      matchExpr: '"quantum"',
      categoryGroups: [['cs.LG']],
      published: {},
    });
  });

  it.each([
    ['cat:cs.LG AND (a OR b)', '("a" OR "b")', [['cs.LG']]],
    ['transformer AND cat:cs.AI', '"transformer"', [['cs.AI']]],
    // The echoed form of a query beside the category parameter.
    ['(quantum computing) AND cat:cs.LG', '("quantum" OR "computing")', [['cs.LG']]],
    [
      'au:"hinton g" AND cat:cs.LG ANDNOT ti:survey',
      'authors:"hinton g" NOT title:"survey"',
      [['cs.LG']],
    ],
    // A cat:-only OR set on the right of an AND is one group, adjacency included.
    ['transformer AND cat:cs.LG OR cat:cs.AI', '"transformer"', [['cs.LG', 'cs.AI']]],
    ['transformer AND cat:cs.LG cat:cs.AI', '"transformer"', [['cs.LG', 'cs.AI']]],
    // A negation whose left operand is lifted folds into the conjunct before it.
    ['a AND cat:cs.LG AND cat:cs.AI ANDNOT c', '"a" NOT "c"', [['cs.LG'], ['cs.AI']]],
    ['a AND cat:cs.LG ANDNOT b OR c', '"a" NOT ("b" OR "c")', [['cs.LG']]],
  ])('lifts the cat: in %s and keeps it on the mirror', (query, matchExpr, categoryGroups) => {
    expect(mirrored(query)).toEqual({ route: 'mirror', matchExpr, categoryGroups, published: {} });
  });

  it('folds a negation beside a lifted window into the conjunct before it', () => {
    expect(
      mirrored('transformer AND submittedDate:[202001010000 TO 202101010000] ANDNOT survey'),
    ).toEqual({
      route: 'mirror',
      matchExpr: '"transformer" NOT "survey"',
      categoryGroups: [],
      published: { from: '2020-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z' },
    });
  });

  it.each([
    'quantum cat:cs.LG',
    'cat:cs.LG quantum',
    'quantum OR graph AND cat:cs.LG',
    'quantum ANDNOT cat:cs.LG AND graph',
    'submittedDate:[202001010000 TO 202101010000] quantum',
  ])('routes %s live: arXiv reads the filter as a disjunct', (query) => {
    expect(translateQuery(query)).toEqual(live('filter_not_conjunct'));
  });

  it.each([
    'cat:cs.LG ANDNOT a OR b',
    'cat:cs.LG AND cat:cs.AI ANDNOT a',
    // A parenthesized group whose residual is negated alone still goes live.
    'x AND (cat:cs.LG ANDNOT y)',
  ])('routes %s live: no positive term is left', (query) => {
    expect(translateQuery(query)).toEqual(live('no_positive_term'));
  });
});

describe('translateQuery — linear on caller-sized input (issue #65)', () => {
  /** Thread CPU microseconds spent translating `input` once. */
  const cpuOf = (input: string): number => {
    const before = process.threadCpuUsage();
    translateQuery(input);
    const spent = process.threadCpuUsage(before);
    return spent.user + spent.system;
  };

  it.each([
    ['an opener with no closer', (n: number) => '('.repeat(n)],
    ['nested openers around a term', (n: number) => `${'('.repeat(n / 2)}a${')'.repeat(n / 2)}`],
    [
      'nested openers around a cat:',
      (n: number) => `${'('.repeat(n / 8)}cat:cs.LG${')'.repeat(n / 8)}`,
    ],
    ['a long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['overlapping field prefixes', (n: number) => 'cat:ti:'.repeat(n / 7)],
    ['conjunct cat: operands', (n: number) => `${'cat:cs.LG AND '.repeat(n / 14)}x`],
    [
      'OR-ed cat: operands in nested groups',
      (n: number) => `${'(cat:cs.LG OR '.repeat(n / 15)}cat:cs.AI${')'.repeat(n / 15)}`,
    ],
    ['operators with no operands', (n: number) => 'AND OR ANDNOT '.repeat(n / 14)],
    ['an unclosed quote', (n: number) => `"${'a '.repeat(n / 2)}`],
    // Issue #82 — the right-grouped tree, the AND NOT lookahead, and the residual pass.
    ['a long run of AND NOT', (n: number) => `${'x AND NOT '.repeat(n / 10)}y`],
    ['AND before a gap of whitespace', (n: number) => `x AND${' '.repeat(n)}y`],
    ['a long operator chain', (n: number) => `${'x ANDNOT y OR z AND '.repeat(n / 20)}w`],
    ['adjacent operands', (n: number) => 'x '.repeat(n / 2)],
    ['lowercase operator words', (n: number) => 'a andnot b AndNot c '.repeat(n / 20)],
    ['a dropped word at the end', (n: number) => `${'x AND '.repeat(n / 6)}of`],
    [
      'a negation folded through a long conjunct chain',
      (n: number) => `${'x AND '.repeat(n / 6)}cat:cs.LG ANDNOT y`,
    ],
    ['groups emptied by a lift', (n: number) => `${'(cat:cs.LG AND x) AND '.repeat(n / 22)}y`],
    [
      'nested groups of AND NOT',
      (n: number) => `${'(a AND NOT '.repeat(n / 11)}b${')'.repeat(n / 11)}`,
    ],
  ])('stays linear for %s from 5k to 320k characters', (_shape, build) => {
    // Warm the JIT so the first size is not charged for compilation.
    for (let i = 0; i < 3; i++) translateQuery(build(5_000));
    const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    const spent: number[] = [];
    for (const size of sizes) {
      const input = build(size);
      const cpu = Math.min(cpuOf(input), cpuOf(input));
      // 320k characters of any shape inside half a second of CPU.
      expect(cpu, `${size} characters`).toBeLessThan(500_000);
      spent.push(Math.max(cpu, 1));
    }
    const ratio = (spent.at(-1) ?? 1) / (spent[0] ?? 1);
    expect(ratio, JSON.stringify(spent)).toBeLessThan(256);
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
    // The issue #14 shapes the mirror still answers — cat: extraction inside
    // parens. Those that OR a cat: with a term route live (#65, above).
    '(cat:cs.LG AND term)',
    '(cat:cs.LG)',
    '(cat:cs.LG OR cat:cs.AI)',
    // Broader #14 cleanup combinations beyond the issue's table.
    'cat:cs.LG AND a',
    'a AND cat:cs.LG',
    'cat:cs.LG',
    'cat:cs.LG OR cat:cs.AI OR cat:cs.CL',
    'a AND cat:cs.LG AND b',
    'term AND (cat:cs.LG)',
    '(cat:cs.LG) AND term',
    '(a AND (cat:cs.LG))',
    '(cat:cs.LG AND cat:cs.AI)',
    'all:dark AND cat:cs.LG',
    // Issue #37 — co:/jr: route to FTS columns that only exist from schema v3.
    'co:ICML',
    'jr:Nature',
    'co:"12 pages"',
    'co:accepted AND jr:Nature',
    '(co:ICML OR jr:Nature) AND cat:cs.LG',
    'all:dark',
    // Issue #65 — the grouping an ANDNOT's right operand needs, and the joins a
    // lifted conjunct leaves behind.
    'a ANDNOT b AND c',
    'a ANDNOT b c',
    'a ANDNOT b AND (c OR d)',
    'a OR b ANDNOT c AND d',
    'a ANDNOT all:b AND all:c',
    'au:"hinton g" AND cat:cs.LG ANDNOT ti:survey',
    '(cat:cs.LG AND (a ANDNOT b)) AND c',
    // Issue #82 — arXiv's grammar: adjacency as OR, one precedence grouped right,
    // operator words only in uppercase, a negation folded into its conjunct.
    'a b c',
    'a AND b OR c ANDNOT d',
    'a ANDNOT b ANDNOT c ANDNOT d',
    'a OR b AND c andnot d',
    'a AND NOT b',
    'a AND cat:cs.LG AND cat:cs.AI ANDNOT c',
    'all:a (b) all:c',
  ];

  it.each(cases)('emitted FTS5 expression parses for %s', (q) => {
    const { matchExpr } = mirrored(q);
    if (matchExpr === undefined) return;
    expect(() =>
      store.search({
        matchExpr,
        categoryGroups: [],
        limit: 1,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// An independent reading of arXiv's classic-API grammar (issue #82), written
// without the translator's lexer or parser: a recursive-descent parse of a
// well-formed query, evaluated over plain word lists. Adjacency is OR, AND / OR
// / ANDNOT share one precedence grouped right, `AND NOT` is ANDNOT, and only
// uppercase words are operators.
// ---------------------------------------------------------------------------

type RefExpr =
  | { op: 'AND' | 'OR' | 'ANDNOT'; left: RefExpr; right: RefExpr }
  | { field: 'ti' | 'au' | 'abs' | 'co' | 'jr' | 'all'; words: string[] }
  | { field: 'cat'; code: string }
  | { field: 'date'; fromMs: number; toMs: number };

interface RefPaper {
  cats: string[];
  fields: Record<'ti' | 'au' | 'abs' | 'co' | 'jr', string[]>;
  id: string;
  publishedMs: number;
}

const REF_TOKEN = /\(|\)|submittedDate:\[\d{12} TO \d{12}\]|(?:[a-z]+:)?"[^"]*"|[^\s()]+/g;
const REF_OPERATORS = new Set(['AND', 'OR', 'ANDNOT']);
const REF_FIELDS = new Set(['ti', 'au', 'abs', 'co', 'jr', 'all', 'cat']);

const stampMs = (stamp: string): number =>
  Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
  );

/** arXiv's parse of a well-formed query, or undefined for one it has no grouping for. */
function refParse(query: string): RefExpr | undefined {
  const tokens: string[] = [];
  for (const t of query.match(REF_TOKEN) ?? []) {
    if (t === 'NOT' && tokens.at(-1) === 'AND') tokens[tokens.length - 1] = 'ANDNOT';
    else tokens.push(t);
  }
  let i = 0;
  const leaf = (t: string): RefExpr => {
    const date = /^submittedDate:\[(\d{12}) TO (\d{12})\]$/.exec(t);
    if (date)
      return { field: 'date', fromMs: stampMs(date[1] ?? ''), toMs: stampMs(date[2] ?? '') };
    const prefixed = /^([a-z]+):(.*)$/s.exec(t);
    const field = prefixed && REF_FIELDS.has(prefixed[1] ?? '') ? (prefixed[1] as string) : 'all';
    const value = (prefixed && field === prefixed[1] ? (prefixed[2] ?? '') : t).replace(
      /^"|"$/g,
      '',
    );
    if (field === 'cat') return { field: 'cat', code: value };
    return {
      field: field as 'ti' | 'au' | 'abs' | 'co' | 'jr' | 'all',
      words: value.toLowerCase().split(/\s+/).filter(Boolean),
    };
  };
  const primary = (): RefExpr | undefined => {
    const t = tokens[i++];
    if (t === undefined || t === ')' || REF_OPERATORS.has(t)) return;
    if (t !== '(') return leaf(t);
    const inner = expr();
    return tokens[i++] === ')' ? inner : undefined;
  };
  const expr = (): RefExpr | undefined => {
    const left = primary();
    if (!left || tokens[i] === undefined || tokens[i] === ')') return left;
    let op: 'AND' | 'OR' | 'ANDNOT' = 'OR';
    if (REF_OPERATORS.has(tokens[i] as string)) op = tokens[i++] as typeof op;
    const right = expr();
    return right && { op, left, right };
  };
  const parsed = expr();
  return i === tokens.length ? parsed : undefined;
}

/** The ids of the papers arXiv's parse selects. */
function refEval(expr: RefExpr, papers: readonly RefPaper[]): Set<string> {
  if ('op' in expr) {
    const left = refEval(expr.left, papers);
    const right = refEval(expr.right, papers);
    if (expr.op === 'OR') return new Set([...left, ...right]);
    return new Set([...left].filter((id) => right.has(id) === (expr.op === 'AND')));
  }
  const holds = (paper: RefPaper): boolean => {
    switch (expr.field) {
      case 'date':
        return paper.publishedMs >= expr.fromMs && paper.publishedMs <= expr.toMs;
      case 'cat': {
        const code = expr.code;
        return paper.cats.some((c) =>
          code.endsWith('.*')
            ? c.startsWith(code.slice(0, -1))
            : c === code || (!code.includes('.') && c.startsWith(`${code}.`)),
        );
      }
      default: {
        const columns =
          expr.field === 'all' ? Object.values(paper.fields) : [paper.fields[expr.field]];
        const words = expr.words;
        return columns.some((column) =>
          column.some((_, start) => words.every((w, k) => column[start + k] === w)),
        );
      }
    }
  };
  return new Set(papers.filter(holds).map((p) => p.id));
}

/** A small seeded PRNG, so every run draws the same queries. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Words arXiv indexes. Its dropped words (`or`, `and`, `not`, …) route live on
 * their own and are pinned by the stopword cases above, so the differential
 * keeps measuring the grammar; `andnot` still covers case-sensitive operators.
 */
const FUZZ_WORDS = ['quantum', 'graph', 'neural', 'andnot'];
/** How a word may be spelled in a query: never as an uppercase operator word. */
const FUZZ_SPELLINGS: Record<string, string[]> = {
  quantum: ['quantum', 'Quantum', 'QUANTUM'],
  graph: ['graph'],
  neural: ['neural', 'Neural'],
  andnot: ['andnot', 'AndNot', 'andNOT'],
};
const FUZZ_PAPER_CATS = ['cs.LG', 'cs.AI', 'math.AG', 'math.CO', 'quant-ph', 'math', 'cs'];
/** `zzz.*` names no code, so it reaches the mirror only beside a code that does. */
const FUZZ_QUERY_CATS = ['cs.LG', 'cs.AI', 'math.AG', 'quant-ph', 'cs', 'math', 'math.*', 'zzz.*'];
const FUZZ_PREFIXES = ['', '', '', 'ti:', 'au:', 'abs:', 'co:', 'jr:', 'all:'];
const FUZZ_JOINS = ['AND', 'OR', 'ANDNOT', 'AND NOT', '', ''];
const FUZZ_SPACES = [' ', ' ', ' ', '  ', '\t', '\n'];

/** A random well-formed query over the fuzz vocabulary, every operator, case, paren, and prefix shape included. */
function fuzzQuery(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const word = () => pick(FUZZ_SPELLINGS[pick(FUZZ_WORDS)] ?? []);
  const year = () => 2019 + Math.floor(rand() * 5);
  const operand = (depth: number): string => {
    const roll = rand();
    if (depth < 2 && roll < 0.2) return `(${pick(['', ' '])}${expr(depth + 1)}${pick(['', ' '])})`;
    if (roll < 0.32) return `cat:${pick(FUZZ_QUERY_CATS)}`;
    if (roll < 0.38) {
      const from = year();
      return `submittedDate:[${from}01010000 TO ${from + Math.floor(rand() * 3)}06300000]`;
    }
    const prefix = pick(FUZZ_PREFIXES);
    if (rand() < 0.25) return `${prefix}"${word()}${rand() < 0.5 ? ` ${word()}` : ''}"`;
    return `${prefix}${word()}`;
  };
  const expr = (depth: number): string => {
    let out = operand(depth);
    const extra = Math.floor(rand() * 4);
    for (let k = 0; k < extra; k++) {
      const joinWord = pick(FUZZ_JOINS);
      out += joinWord ? `${pick(FUZZ_SPACES)}${joinWord}${pick(FUZZ_SPACES)}` : pick(FUZZ_SPACES);
      out += operand(depth);
    }
    return out;
  };
  return expr(0);
}

/** `count` random papers over the fuzz vocabulary. */
function fuzzPapers(
  rand: () => number,
  count: number,
): { records: ArxivRawRecord[]; papers: RefPaper[] } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const text = (max: number) =>
    Array.from({ length: 1 + Math.floor(rand() * max) }, () => pick(FUZZ_WORDS));
  const records: ArxivRawRecord[] = [];
  const papers: RefPaper[] = [];
  for (let i = 0; i < count; i++) {
    const id = `2409.${String(i + 1).padStart(5, '0')}`;
    const fields = {
      ti: text(4),
      au: text(2),
      abs: text(5),
      co: rand() < 0.5 ? text(2) : [],
      jr: rand() < 0.3 ? text(2) : [],
    };
    const cats = [
      ...new Set([pick(FUZZ_PAPER_CATS), ...(rand() < 0.4 ? [pick(FUZZ_PAPER_CATS)] : [])]),
    ];
    const date = new Date(
      Date.UTC(2019 + Math.floor(rand() * 5), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)),
    );
    records.push({
      paper_id: id,
      identifier: `oai:arXiv.org:${id}`,
      datestamp: date.toISOString().slice(0, 10),
      title: fields.ti.join(' '),
      authors: fields.au.join(' '),
      abstract: fields.abs.join(' '),
      ...(fields.co.length > 0 && { comments: fields.co.join(' ') }),
      ...(fields.jr.length > 0 && { journal_ref: fields.jr.join(' ') }),
      categories: cats.join(' '),
      versions: [{ version: 'v1', date: date.toISOString() }],
    });
    papers.push({ id, fields, cats, publishedMs: date.getTime() });
  }
  return { records, papers };
}

/** The ids the store returns for a translation the mirror answers. */
function mirrorIds(store: MirrorStore, query: MirrorQuery): string[] {
  const { papers } = store.search({
    ...(query.matchExpr !== undefined && { matchExpr: query.matchExpr }),
    categoryGroups: query.categoryGroups.filter((group) => group.length > 0),
    ...(query.published.from !== undefined && { publishedFrom: query.published.from }),
    ...(query.published.to !== undefined && { publishedTo: query.published.to }),
    limit: 1_000,
    offset: 0,
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  return papers.map((p) => p.id).sort();
}

describe('translateQuery on a seeded mirror returns the set of arXiv’s parse (issue #82)', () => {
  let dir: string;
  let store: MirrorStore;
  const TITLES = [
    'quantum',
    'graph',
    'neural',
    'quantum neural',
    'graph neural',
    'quantum graph',
    'quantum graph neural',
    'unrelated',
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-query-grammar-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
    const record = (id: string, title: string, abstract: string): ArxivRawRecord => ({
      paper_id: id,
      identifier: `oai:arXiv.org:${id}`,
      datestamp: '2024-01-22',
      title,
      authors: 'Ada Lovelace',
      abstract,
      categories: 'cs.LG',
      versions: [{ version: 'v1', date: '2024-01-22T00:00:00Z' }],
    });
    store.applyBatch(
      [
        ...TITLES.map((title, i) => record(`2410.0000${i + 1}`, title, 'abstract text')),
        // Unmatched filler, so each title word is rare enough for BM25 to weigh.
        ...Array.from({ length: 12 }, (_, i) =>
          record(`2410.100${String(i).padStart(2, '0')}`, 'filler paper', 'abstract text'),
        ),
      ],
      [],
    );
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Each titled paper's id; a filler paper reads back as its own id, never a title. */
  const titleOf = new Map(TITLES.map((title, i) => [`2410.0000${i + 1}`, title]));
  const titlesFor = (query: string): string[] =>
    mirrorIds(store, mirrored(query)).map((id) => titleOf.get(id) ?? id);

  it.each([
    [
      'ti:quantum ti:graph',
      [
        'quantum',
        'graph',
        'quantum neural',
        'graph neural',
        'quantum graph',
        'quantum graph neural',
      ],
    ],
    [
      'ti:quantum AND ti:graph OR ti:neural',
      ['quantum neural', 'quantum graph', 'quantum graph neural'],
    ],
    ['ti:quantum ANDNOT ti:graph OR ti:neural', ['quantum']],
    [
      'ti:quantum ANDNOT ti:graph ANDNOT ti:neural',
      ['quantum', 'quantum neural', 'quantum graph neural'],
    ],
    // Already agreed before arXiv's grammar was adopted, and still does.
    [
      'ti:quantum OR ti:graph ANDNOT ti:neural',
      ['quantum', 'graph', 'quantum neural', 'quantum graph', 'quantum graph neural'],
    ],
  ])('answers %s with the papers arXiv’s echoed parse selects', (query, expected) => {
    expect(titlesFor(query)).toEqual(expected);
  });

  it('ranks papers holding every adjacent term first by relevance', () => {
    const { papers, total } = store.search({
      matchExpr: mirrored('quantum graph').matchExpr as string,
      limit: 10,
      offset: 0,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });
    expect(total).toBe(6);
    expect(
      papers
        .slice(0, 2)
        .map((p) => p.title)
        .sort(),
    ).toEqual(['quantum graph', 'quantum graph neural']);
  });
});

describe('translateQuery against an independent evaluator of arXiv’s grammar (issue #82)', () => {
  let dir: string;
  let store: MirrorStore;
  let papers: RefPaper[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-query-differential-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
    const seeded = fuzzPapers(mulberry32(1), 60);
    papers = seeded.papers;
    store.applyBatch(seeded.records, []);
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers every random query it keeps on the mirror with the set arXiv’s parse selects', () => {
    const rand = mulberry32(82);
    const trials = 3_000;
    const mismatches: { expected: string[]; got: string[]; query: string }[] = [];
    const routes = new Map<string, number>();
    /** Mirror answers compared against the reference, and those that select some papers but not all. */
    let compared = 0;
    let partial = 0;
    for (let trial = 0; trial < trials; trial++) {
      const query = fuzzQuery(rand);
      const translated = translateQuery(query);
      const route = translated.route === 'live' ? translated.reason : 'mirror';
      routes.set(route, (routes.get(route) ?? 0) + 1);
      const parsed = refParse(query);
      if (!parsed || translated.route === 'live') continue;
      const expected = [...refEval(parsed, papers)].sort();
      const got = mirrorIds(store, translated);
      compared++;
      if (expected.length > 0 && expected.length < papers.length) partial++;
      if (got.join() !== expected.join()) mismatches.push({ query, expected, got });
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // Only filters arXiv reads as disjuncts or negated, negations left alone, and
    // category filters naming no code go live.
    expect([...routes.keys()].sort()).toEqual([
      'empty_category',
      'filter_not_conjunct',
      'mirror',
      'no_positive_term',
    ]);
    // The differential is not vacuous: a large share of random queries stays on the
    // mirror, the reference parses every one of them, and most of the answers
    // compared select some papers but not all.
    expect(routes.get('mirror')).toBeGreaterThan(trials * 0.45);
    expect(compared).toBe(routes.get('mirror'));
    expect(partial, JSON.stringify({ compared, partial })).toBeGreaterThan(compared * 0.5);
  });

  it('emits an expression FTS5 parses for any character soup it keeps on the mirror', () => {
    const rand = mulberry32(13);
    const alphabet = [
      'a',
      'b',
      'ti:',
      'cat:cs',
      'rn',
      ':',
      '(',
      ')',
      '"',
      ' ',
      ' ',
      '\n',
      'AND',
      'OR',
      'ANDNOT',
      'NOT',
      'and',
      'or',
      '*',
      '.',
      '-',
      'submittedDate:[202001010000 TO 202101010000]',
    ];
    const trials = 4_000;
    let kept = 0;
    for (let trial = 0; trial < trials; trial++) {
      const query = Array.from(
        { length: Math.floor(rand() * 16) },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join('');
      const translated = translateQuery(query);
      if (translated.route === 'live') continue;
      kept++;
      expect(() => mirrorIds(store, translated), query).not.toThrow();
    }
    // Not vacuous: a share of the soup reaches FTS5.
    expect(kept).toBeGreaterThan(trials * 0.1);
  });
});

describe('cat: operand expansion', () => {
  it('expands a cat: operand through the shared taxonomy subtree', () => {
    expect(mirrored('cat:cs.LG').categoryGroups).toEqual([categorySubtree('cs.LG')]);
    expect(mirrored('cat:astro-ph').categoryGroups).toEqual([categorySubtree('astro-ph')]);
  });

  it('understands the subtree wildcards this server emits on the live path', () => {
    // `categorySearchTerm` can produce `cat:math.*` / `cat:astro-ph*`. Replaying an
    // echoed query through the mirror only works if the translator reads them too.
    expect(mirrored('cat:astro-ph*').categoryGroups.flat()).toContain('astro-ph.CO');
    expect(mirrored('cat:astro-ph*').categoryGroups.flat()).toContain('astro-ph');
    expect(mirrored('cat:math.*').categoryGroups.flat()).toContain('math.AG');
    expect(mirrored('cat:math.*').categoryGroups.flat()).not.toContain('math-ph');
  });
});

describe('expandCategoryOperands — cat: in query text on the live path (issue #36)', () => {
  it('expands a bare archive code to the subtree operand the category parameter emits', () => {
    // arXiv matches `cat:cs` literally and never assigns the bare group name, so
    // the unexpanded operand reaches nothing at all upstream.
    expect(expandCategoryOperands('cat:cs')).toBe(categorySearchTerm('cs'));
    expect(expandCategoryOperands('cat:cs')).toBe('cat:cs*');
    expect(expandCategoryOperands('cat:astro-ph')).toBe('cat:astro-ph*');
  });

  it('spells out an archive whose wildcard would leak a neighbouring archive', () => {
    // `cat:math*` would also match math-ph, a physics archive.
    expect(expandCategoryOperands('cat:math')).toBe('(cat:math.* OR cat:math)');
  });

  it('leaves a leaf code and a standalone archive exactly as written', () => {
    expect(expandCategoryOperands('cat:cs.LG')).toBe('cat:cs.LG');
    expect(expandCategoryOperands('cat:hep-th')).toBe('cat:hep-th');
  });

  it('leaves an already-wildcarded operand alone', () => {
    expect(expandCategoryOperands('cat:astro-ph*')).toBe('cat:astro-ph*');
    expect(expandCategoryOperands('cat:math.*')).toBe('cat:math.*');
  });

  it('rewrites only the cat: operand, leaving the rest of the query byte-identical', () => {
    expect(expandCategoryOperands('ti:"deep learning" AND cat:cs ANDNOT au:hinton')).toBe(
      'ti:"deep learning" AND cat:cs* ANDNOT au:hinton',
    );
    expect(expandCategoryOperands('(cat:cs OR cat:math.AG)  AND   spacing')).toBe(
      '(cat:cs* OR cat:math.AG)  AND   spacing',
    );
  });

  it('returns a query with no cat: operand unchanged', () => {
    for (const q of [
      'all:transformer',
      'co:ICML AND jr:Nature',
      'submittedDate:[202001010000 TO 202002010000]',
      '',
    ]) {
      expect(expandCategoryOperands(q)).toBe(q);
    }
  });

  it('rewrites the same operands whatever the operator words around them', () => {
    // The live path forwards operator words as written; only the cat: operand changes.
    expect(expandCategoryOperands('ti:a and cat:cs AND NOT cat:math or cat:hep-th')).toBe(
      'ti:a and cat:cs* AND NOT (cat:math.* OR cat:math) or cat:hep-th',
    );
    // A prefix with nothing after it rewrites to itself, leaving the next word alone.
    expect(expandCategoryOperands('cat: cs')).toBe('cat: cs');
    expect(expandCategoryOperands('cat:')).toBe('cat:');
  });

  it('does not rewrite cat: inside a quoted phrase', () => {
    expect(expandCategoryOperands('ti:"cat:cs is not an operand"')).toBe(
      'ti:"cat:cs is not an operand"',
    );
  });

  it('agrees with the mirror on which codes a cat: operand covers, for every searchable code', () => {
    // The whole point of the rewrite: one operand, one set, whichever backend
    // answers. Asserted across the entire searchable vocabulary rather than a
    // sample, since the divergence it replaces was code-shape-specific.
    for (const code of SEARCHABLE_CATEGORY_CODES) {
      const viaMirror = mirrored(`cat:${code}`).categoryGroups.flat();
      const viaLive = mirrored(expandCategoryOperands(`cat:${code}`)).categoryGroups.flat();
      expect([...viaLive].sort()).toEqual([...viaMirror].sort());
      expect(viaMirror).toEqual(categorySubtree(code));
    }
  });
});

describe('submittedDate: window extraction (issue #27)', () => {
  it('lifts a submittedDate range out of the FTS expression into published bounds', () => {
    const { matchExpr, published } = mirrored(
      'all:transformer AND submittedDate:[202001010000 TO 202002010000]',
    );
    expect(published.from).toBe('2020-01-01T00:00:00.000Z');
    expect(published.to).toBe('2020-02-01T00:00:00.000Z');
    // The range must not leak into FTS as bare terms.
    expect(matchExpr).not.toContain('submittedDate');
    expect(matchExpr).not.toContain('202001010000');
  });

  it('drops the operator the extracted range leaves behind', () => {
    const { matchExpr } = mirrored('submittedDate:[202001010000 TO 202002010000]');
    expect(matchExpr).toBeUndefined();
  });

  it('narrows to the intersection when a query carries two windows', () => {
    const { published } = mirrored(
      'submittedDate:[202001010000 TO 202004010000] AND submittedDate:[202002010000 TO 202006010000]',
    );
    expect(published.from).toBe('2020-02-01T00:00:00.000Z');
    expect(published.to).toBe('2020-04-01T00:00:00.000Z');
  });

  it('keeps both bounds of two windows that do not overlap, so the mirror matches nothing', () => {
    // A window is never dropped: an empty intersection narrows to no paper
    // instead of widening to every date.
    expect(
      mirrored(
        'submittedDate:[202001010000 TO 202101010000] AND submittedDate:[202201010000 TO 202301010000]',
      ).published,
    ).toEqual({ from: '2022-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z' });
  });

  it('sends a malformed range live rather than guessing a window', () => {
    expect(translateQuery('submittedDate:[2020 TO yesterday]')).toEqual({
      route: 'live',
      reason: 'field_not_in_mirror',
    });
  });

  it('reports no window when the query has none', () => {
    expect(mirrored('all:transformer').published).toEqual({});
  });
});
