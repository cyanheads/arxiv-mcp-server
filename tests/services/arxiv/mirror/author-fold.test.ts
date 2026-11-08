/**
 * @fileoverview Tests for the author-name fold (issue #100): every letter of
 * the table, written out here independently of the module, against
 * `foldAuthorText` and against the SQL `foldAuthorsSql` builds, evaluated by
 * the SQLite driver the runtime uses (`bun:sqlite` on Bun, `better-sqlite3` on
 * Node); each letter end to end through `translateQuery` and a mirror store;
 * and the fold's cost on caller-sized text. Runs on both test lanes.
 * @module services/arxiv/mirror/author-fold.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldAuthorsSql, foldAuthorText } from '@/services/arxiv/mirror/author-fold.js';
import { translateQuery } from '@/services/arxiv/mirror/query.js';
import { MirrorStore } from '@/services/arxiv/mirror/store.js';

/** Each letter the fold maps and its ASCII spelling, lower and upper case. */
const FOLDS: readonly (readonly [letter: string, ascii: string])[] = [
  ['ł', 'l'],
  ['Ł', 'L'],
  ['ı', 'i'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'Th'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['ŋ', 'n'],
  ['Ŋ', 'N'],
  ['ə', 'a'],
  ['Ə', 'A'],
  ['æ', 'ae'],
  ['Æ', 'Ae'],
  ['œ', 'oe'],
  ['Œ', 'Oe'],
  ['ß', 'ss'],
  ['ẞ', 'Ss'],
];

/**
 * Characters the fold leaves as written: letters that decompose into a base
 * and a mark (the tokenizer strips those), letters near the table that are not
 * in it (ligatures, `ſ`, `ŀ`, the dotted `İ`), a combining mark, digits,
 * punctuation, CJK, and characters outside the BMP.
 */
const UNTOUCHED =
  'Sánchez Müller Ağaoğlu Šimon İnan Çelik Ñúñez Ōkubo ĳ Ĳ ſ ŀ Ŀ ǆ ﬁ é 0-9 “x” 日本語 😀 𝔄';

/** An in-memory database of the driver the runtime uses, answering one `SELECT … AS v`. */
async function openScalar(): Promise<{
  close(): void;
  value(sql: string, ...params: string[]): string;
}> {
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    return {
      value: (sql, ...params) => (db.query(sql).get(...params) as { v: string }).v,
      close: () => db.close(),
    };
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  return {
    value: (sql, ...params) => (db.prepare(sql).get(...params) as { v: string }).v,
    close: () => db.close(),
  };
}

describe('the author fold, letter by letter (#100)', () => {
  let sql: Awaited<ReturnType<typeof openScalar>>;

  beforeAll(async () => {
    sql = await openScalar();
  });

  afterAll(() => {
    sql.close();
  });

  const sqlFold = (value: string) => sql.value(`SELECT ${foldAuthorsSql('?')} AS v`, value);

  it.each(FOLDS)('spells %s as %s in the string fold and the SQL fold', (letter, ascii) => {
    expect(foldAuthorText(letter)).toBe(ascii);
    expect(sqlFold(letter)).toBe(ascii);
    expect(foldAuthorText(`Ka${letter}mo ${letter}`)).toBe(`Ka${ascii}mo ${ascii}`);
    expect(sqlFold(`Ka${letter}mo ${letter}`)).toBe(`Ka${ascii}mo ${ascii}`);
  });

  it('folds every letter of a name that holds them all, the two folds alike', () => {
    const name = FOLDS.map(([letter], i) => `${letter}${i}`).join('');
    const expected = FOLDS.map(([, ascii], i) => `${ascii}${i}`).join('');
    expect(foldAuthorText(name)).toBe(expected);
    expect(sqlFold(name)).toBe(expected);
  });

  it('leaves every other character as written', () => {
    expect(foldAuthorText(UNTOUCHED)).toBe(UNTOUCHED);
    expect(sqlFold(UNTOUCHED)).toBe(UNTOUCHED);
    expect(foldAuthorText(`${UNTOUCHED} Tworzydło`)).toBe(`${UNTOUCHED} Tworzydlo`);
    expect(sqlFold(`${UNTOUCHED} Tworzydło`)).toBe(`${UNTOUCHED} Tworzydlo`);
    expect(foldAuthorText('')).toBe('');
  });
});

/**
 * One paper per table letter, its authors, title, and abstract each holding the
 * letter in a word of their own (`Ka<letter>m<tag>`, `Ti<letter>t<tag>`,
 * `Ab<letter>s<tag>`), the tag a letter `a`–`w` that keeps the ASCII spellings
 * of `đ` and `ð` apart.
 */
describe('each table letter through the translator and a mirror store (#100)', () => {
  let dir: string;
  let store: MirrorStore;
  const tagOf = (i: number) => String.fromCharCode(97 + i);
  const idOf = (i: number) => `2605.${String(22_700 + i)}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-author-fold-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
    store.applyBatch(
      FOLDS.map(([letter], i) => ({
        paper_id: idOf(i),
        identifier: `oai:arXiv.org:${idOf(i)}`,
        datestamp: '2026-05-01',
        title: `Ti${letter}t${tagOf(i)} transport`,
        authors: `A. Ka${letter}m${tagOf(i)}, B. Other`,
        abstract: `Ab${letter}s${tagOf(i)} measured.`,
        categories: 'cond-mat.mes-hall',
        versions: [{ version: 'v1', date: '2026-05-01T00:00:00Z' }],
      })),
      [],
    );
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The ids `query` returns through the translator, sorted; fails the test when it goes live. */
  const idsFor = (query: string): string[] => {
    const translated = translateQuery(query);
    if (translated.route === 'live') throw new Error(`${query} routes live (${translated.reason})`);
    return store
      .search({
        ...(translated.matchExpr !== undefined && { matchExpr: translated.matchExpr }),
        categoryGroups: translated.categoryGroups,
        limit: 50,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      })
      .papers.map((p) => p.id)
      .sort();
  };

  it.each(FOLDS.map(([letter, ascii], i) => [letter, ascii, i] as const))(
    '%s matches %s under au:, all:, and an unprefixed term, and as written under ti: and abs:',
    (letter, ascii, i) => {
      const tag = tagOf(i);
      const paper = [idOf(i)];
      for (const spelling of [letter, ascii]) {
        expect(idsFor(`au:Ka${spelling}m${tag}`), `au:Ka${spelling}m${tag}`).toEqual(paper);
        expect(idsFor(`all:Ka${spelling}m${tag}`), `all:Ka${spelling}m${tag}`).toEqual(paper);
        expect(idsFor(`Ka${spelling}m${tag}`), `Ka${spelling}m${tag}`).toEqual(paper);
      }
      expect(idsFor(`ti:Ti${letter}t${tag}`)).toEqual(paper);
      expect(idsFor(`abs:Ab${letter}s${tag}`)).toEqual(paper);
      // Titles and abstracts keep the letter, as arXiv's title and abstract search does.
      expect(idsFor(`ti:Ti${ascii}t${tag}`), `ti:Ti${ascii}t${tag}`).toEqual([]);
      expect(idsFor(`abs:Ab${ascii}s${tag}`), `abs:Ab${ascii}s${tag}`).toEqual([]);
    },
  );
});

/**
 * Per-call thread CPU of `fn`, in ms: the least of five samples, each repeating
 * `fn` until it has used ~20 ms of CPU.
 */
function cpuMs(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    do {
      fn();
      calls++;
      const used = process.threadCpuUsage(start);
      usedMs = (used.user + used.system) / 1000;
    } while (usedMs < 20);
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

// The bound is thread CPU; the wall-clock timeout only has to outlast a loaded machine.
describe('foldAuthorText cost on caller-sized text (#100)', { timeout: 60_000 }, () => {
  it.each([
    ['every character a two-letter fold', (n: number) => 'ß'.repeat(n)],
    ['every character a one-letter fold', (n: number) => 'ł'.repeat(n)],
    ['fold letters between plain ones', (n: number) => 'aæ'.repeat(n / 2)],
    ['a long digit run with no fold letter', (n: number) => '7'.repeat(n)],
    ['a long line ending in a break', (n: number) => `${'§1 ł'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('stays linear for %s from 5k to 320k characters', (_shape, build) => {
    const times: number[] = [];
    for (let size = 5_000; size <= 320_000; size *= 2) {
      const input = build(size);
      const ms = cpuMs(() => foldAuthorText(input));
      // 320k characters of any shape inside 66 ms of CPU, each size before the next runs.
      expect(ms, `${size} characters took ${ms.toFixed(3)} ms`).toBeLessThan(2 + size / 5_000);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1), JSON.stringify(times)).toBeLessThan(256);
  });
});
