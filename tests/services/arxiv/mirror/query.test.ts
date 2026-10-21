/**
 * @fileoverview Tests for the arXiv → FTS5 query translator including
 * field prefixes, boolean operators, phrase quoting, category-subtree
 * expansion via the bundled taxonomy, `submittedDate:` window extraction
 * (issue #27), parenthesis-boundary adjacency (issue #13), `cat:`
 * extraction cleanup inside parens (issue #14), the live-path `cat:` rewrite
 * (issue #36), and the `co:` / `jr:` column routing schema v3 makes possible
 * (issue #37) — all verified against a real in-memory FTS5 index.
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
    expect(mirrored('rn:report-42').matchExpr).toBe('"rn:report-42"');
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

  it('emits no matchExpr when the query is empty', () => {
    const { matchExpr, categoryGroups } = mirrored('');
    expect(matchExpr).toBeUndefined();
    expect(categoryGroups).toEqual([]);
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

describe('translateQuery — parenthesis-boundary adjacency (issue #13)', () => {
  it('inserts AND between a bare term and an all: expansion', () => {
    expect(mirrored('language all:automated').matchExpr).toBe(
      `"language" AND ${allCols('automated')}`,
    );
  });

  it('inserts AND between an all: expansion and a trailing bare term', () => {
    expect(mirrored('all:dark matter').matchExpr).toBe(`${allCols('dark')} AND "matter"`);
  });

  it('inserts AND between consecutive all: expansions sandwiching a phrase', () => {
    expect(mirrored('all:language "language" all:automated').matchExpr).toBe(
      `${allCols('language')} AND "language" AND ${allCols('automated')}`,
    );
  });

  it('inserts AND between two user-parenthesized groups', () => {
    expect(mirrored('(foo) (bar)').matchExpr).toBe('("foo") AND ("bar")');
  });

  it('inserts AND between a bare term and a user-parenthesized all: group', () => {
    expect(mirrored('bar (all:foo)').matchExpr).toBe(`"bar" AND (${allCols('foo')})`);
  });

  it('does NOT insert AND between bare phrases (implicit-AND is valid for phrases)', () => {
    expect(mirrored('foo bar').matchExpr).toBe('"foo" "bar"');
  });

  it('does NOT insert AND between bare column qualifiers and phrases', () => {
    expect(mirrored('ti:foo bar').matchExpr).toBe('title:"foo" "bar"');
    expect(mirrored('foo ti:bar').matchExpr).toBe('"foo" title:"bar"');
  });

  it('preserves explicit operators without doubling them up', () => {
    expect(mirrored('a AND (b OR c)').matchExpr).toBe('"a" AND ("b" OR "c")');
    expect(mirrored('(a OR b) AND c').matchExpr).toBe('("a" OR "b") AND "c"');
    expect(mirrored('a ANDNOT (b OR c)').matchExpr).toBe('"a" NOT ("b" OR "c")');
  });

  it('inserts AND between consecutive all: expansions', () => {
    expect(mirrored('all:foo all:bar').matchExpr).toBe(`${allCols('foo')} AND ${allCols('bar')}`);
  });

  it('inserts AND across literal-paren ↔ all: boundaries in both directions', () => {
    expect(mirrored('(a) all:b').matchExpr).toBe(`("a") AND ${allCols('b')}`);
    expect(mirrored('all:b (a)').matchExpr).toBe(`${allCols('b')} AND ("a")`);
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
    // Implicit AND binds the same way.
    expect(mirrored('cat:cs.LG cat:math.AG').categoryGroups).toEqual([['cs.LG'], ['math.AG']]);
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

  it('groups a conjunction on the right of an ANDNOT, which FTS5 would split', () => {
    // FTS5 binds NOT tighter than AND, so `"a" NOT "b" AND "c"` means (a ∧ ¬b) ∧ c.
    expect(mirrored('a ANDNOT b AND c').matchExpr).toBe('"a" NOT ("b" AND "c")');
    expect(mirrored('a ANDNOT b c').matchExpr).toBe('"a" NOT ("b" "c")');
    expect(mirrored('a ANDNOT b AND (c OR d)').matchExpr).toBe('"a" NOT ("b" AND ("c" OR "d"))');
    expect(mirrored('a OR b ANDNOT c AND d').matchExpr).toBe('"a" OR "b" NOT ("c" AND "d")');
  });

  it('leaves an ANDNOT chain with no conjunction on its right as written', () => {
    expect(mirrored('a ANDNOT b ANDNOT c').matchExpr).toBe('"a" NOT "b" NOT "c"');
    expect(mirrored('a AND b ANDNOT c').matchExpr).toBe('"a" AND "b" NOT "c"');
  });

  it('keeps the explicit AND a lifted operand sat between', () => {
    expect(mirrored('a cat:cs.LG AND b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('a cat:cs.LG b').matchExpr).toBe('"a" "b"');
  });

  it('reads stray operators and empty groups as it always has', () => {
    expect(mirrored('AND a OR').matchExpr).toBe('"a"');
    expect(mirrored('a AND OR b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('a OR AND b').matchExpr).toBe('"a" OR "b"');
    expect(mirrored('a AND () OR b').matchExpr).toBe('"a" AND "b"');
    expect(mirrored('(OR a ANDNOT)').matchExpr).toBe('("a")');
    expect(mirrored('()').matchExpr).toBeUndefined();
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
    'a cat:cs.LG b',
    'a cat:cs.LG AND (b)',
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

  it('leaves a malformed range as ordinary terms rather than guessing a window', () => {
    const { published } = mirrored('submittedDate:[2020 TO yesterday]');
    expect(published.from).toBeUndefined();
    expect(published.to).toBeUndefined();
  });

  it('reports no window when the query has none', () => {
    expect(mirrored('all:transformer').published).toEqual({});
  });
});
