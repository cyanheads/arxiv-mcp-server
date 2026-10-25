/**
 * @fileoverview Tests for the MirrorStore — schema migration, batch upsert
 * idempotency, FTS5 round-trip via `search()`, category filter matching,
 * harvest-state read/write, the server's query-only open (#55), and the
 * better-sqlite3 driver, which the last block runs under Node.
 * @module services/arxiv/mirror/store.test
 */

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, fstatSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { categorySubtree } from '@/services/arxiv/categories.js';
import { translateQuery } from '@/services/arxiv/mirror/query.js';
import { fromWireError, toWireError } from '@/services/arxiv/mirror/reader.js';
import {
  MIRROR_FTS_DROP_STATEMENTS,
  MIRROR_FTS_STATEMENTS,
  MIRROR_PAPER_ID_INDEX,
  MIRROR_PRAGMA_STATEMENTS,
  MIRROR_SCHEMA_STATEMENTS,
  MIRROR_SCHEMA_VERSION,
  MIRROR_V4_STATEMENTS,
  MIRROR_V5_STATEMENTS,
} from '@/services/arxiv/mirror/schema.js';
import {
  isDriverError,
  MIRROR_SEARCH_MATCH_CAP,
  MirrorStore,
  rawToRow,
} from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const mkRecord = (overrides: Partial<ArxivRawRecord> = {}): ArxivRawRecord => ({
  paper_id: '2401.00001',
  identifier: 'oai:arXiv.org:2401.00001',
  datestamp: '2024-01-22',
  title: 'Default title',
  authors: 'Default Author',
  abstract: 'Default abstract.',
  categories: 'cs.LG',
  versions: [{ version: 'v1', date: '2024-01-22T00:00:00Z' }],
  ...overrides,
});

/** The SQLite error code a driver error carries (`SQLITE_BUSY`, `SQLITE_READONLY`, …). */
function sqliteCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return;
}

/** Hold `path`'s write lock from a second connection in this process until `release()`. */
function holdWriteLock(path: string): { release: () => void } {
  const holder = new Database(path);
  holder.run('BEGIN IMMEDIATE');
  return {
    release: () => {
      holder.run('COMMIT');
      holder.close();
    },
  };
}

/**
 * How many of this process's file descriptors are open on `path`'s file. A
 * connection holds one for as long as SQLite keeps the file open, so a
 * connection that was closed but kept alive holds it still.
 */
function fdsOpenOn(path: string): number {
  const { dev, ino } = statSync(path);
  let open = 0;
  for (const entry of readdirSync('/dev/fd')) {
    try {
      const fd = fstatSync(Number(entry));
      if (fd.dev === dev && fd.ino === ino) open += 1;
    } catch {
      // The descriptor the listing itself used is closed by the time it is checked.
    }
  }
  return open;
}

/** Names of the schema objects of `type` that `path` holds, read on a separate connection. */
function schemaNames(path: string, type: 'table' | 'trigger'): string[] {
  const db = new Database(path, { readonly: true });
  const rows = db.query(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as {
    name: string;
  }[];
  db.close();
  return rows.map((r) => r.name).sort();
}
const tableNames = (path: string) => schemaNames(path, 'table');
const triggerNames = (path: string) => schemaNames(path, 'trigger');

/** The SQL of every statement `fn` prepares through `bun:sqlite`, in order. */
function preparedBy(fn: () => unknown): string[] {
  const prepared = vi.spyOn(Database.prototype, 'prepare');
  try {
    fn();
    return prepared.mock.calls.map(([sql]) => String(sql));
  } finally {
    prepared.mockRestore();
  }
}

/** Every statement `fn` runs through `bun:sqlite`, with the values bound to it, in order. */
function boundBy(fn: () => unknown): { params: unknown[]; sql: string }[] {
  const runs: { params: unknown[]; sql: string }[] = [];
  const prepare = Database.prototype.prepare;
  const prepared = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get', 'run'] as const) {
      const call = statement[method].bind(statement) as (...params: unknown[]) => unknown;
      Object.assign(statement, {
        [method]: (...params: unknown[]) => {
          runs.push({ params, sql });
          return call(...params);
        },
      });
    }
    return statement;
  } as typeof prepare);
  try {
    fn();
    return runs;
  } finally {
    prepared.mockRestore();
  }
}

/** `EXPLAIN QUERY PLAN` of `sql` against `path`, read on a separate connection. */
function planOf(path: string, sql: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
      (r) => r.detail,
    );
  } finally {
    db.close();
  }
}

/** The page fetch: `papers` columns for rows already chosen, read by key. */
const isPageFetch = (sql: string) => /FROM papers\s+WHERE (papers\.rowid|id) IN \(/.test(sql);

describe('MirrorStore', () => {
  let dir: string;
  let dbPath: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-test-'));
    dbPath = join(dir, 'mirror.db');
    store = await MirrorStore.open(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with an empty papers table and pending harvest state', () => {
    expect(store.countPapers()).toBe(0);
    expect(store.readHarvestState().status).toBe('pending');
  });

  it('upserts records and indexes them in FTS5', () => {
    const records = [
      mkRecord({
        paper_id: '2401.10001',
        title: 'Transformers for protein folding',
        abstract: 'A novel architecture for predicting protein structure.',
        categories: 'cs.LG q-bio.BM',
      }),
      mkRecord({
        paper_id: '2401.10002',
        title: 'A study of cosmic microwave background',
        abstract: 'Observations from a new telescope array.',
        categories: 'astro-ph.CO',
      }),
    ];
    store.applyBatch(records, []);
    expect(store.countPapers()).toBe(2);

    const result = store.search({
      matchExpr: '"protein"',
      categoryGroups: [],
      limit: 10,
      offset: 0,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(1);
    expect(result.papers[0]?.id).toBe('2401.10001');
  });

  it('treats repeat upserts as idempotent (same id replaces in place)', () => {
    const r = mkRecord({ paper_id: '2401.20001' });
    store.applyBatch([r], []);
    store.applyBatch([{ ...r, title: 'Revised title' }], []);
    expect(store.countPapers()).toBe(1);
    const [row] = store.getPapersByIds(['2401.20001']);
    expect(row?.title).toBe('Revised title');
  });

  it('removes tombstoned papers from the index', () => {
    store.applyBatch([mkRecord({ paper_id: '9912.30001' })], []);
    expect(store.countPapers()).toBe(1);
    store.applyBatch([], [{ paper_id: '9912.30001' }]);
    expect(store.countPapers()).toBe(0);
    expect(store.getPapersByIds(['9912.30001'])).toEqual([]);
  });

  // Issue #37 — comment and journal_ref joined the FTS index in schema v3, so
  // the documented co: / jr: prefixes have a column to route at.
  describe('comment and journal_ref in the FTS index (#37)', () => {
    const seedAnnotated = () =>
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'annotated',
            title: 'A paper with publication metadata',
            comments: 'Accepted at ICML 2021, 12 pages',
            journal_ref: 'Nature Physics 17 (2021) 123',
          }),
          mkRecord({ paper_id: 'bare', title: 'A paper with no publication metadata' }),
        ],
        [],
      );

    const idsFor = (matchExpr: string): string[] =>
      store
        .search({ matchExpr, limit: 10, offset: 0, sortBy: 'relevance', sortOrder: 'descending' })
        .papers.map((p) => p.id);

    it('matches a comment term through the comment column', () => {
      seedAnnotated();
      expect(idsFor('comment:"ICML"')).toEqual(['annotated']);
      expect(idsFor('comment:"12 pages"')).toEqual(['annotated']);
    });

    it('matches a journal reference through the journal_ref column', () => {
      seedAnnotated();
      expect(idsFor('journal_ref:"Nature"')).toEqual(['annotated']);
    });

    it('keeps the columns distinct rather than pooling every field', () => {
      seedAnnotated();
      expect(idsFor('comment:"Nature"')).toEqual([]);
      expect(idsFor('journal_ref:"ICML"')).toEqual([]);
    });

    it('reaches the new columns from an unqualified term, as arXiv does', () => {
      seedAnnotated();
      expect(idsFor('"ICML"')).toEqual(['annotated']);
    });

    it('leaves the columns empty for a paper with no comment or journal ref', () => {
      seedAnnotated();
      // No match, and no error — a NULL column is indexed as empty text.
      expect(idsFor('comment:"anything"')).toEqual([]);
    });

    // The sync triggers enumerate their columns, so a trigger that missed the
    // two new ones would leave the index frozen at the first-inserted values.
    it('keeps the index in sync when a comment changes', () => {
      seedAnnotated();
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'annotated',
            title: 'A paper with publication metadata',
            comments: 'Withdrawn by the authors',
            journal_ref: 'Nature Physics 17 (2021) 123',
          }),
        ],
        [],
      );
      expect(idsFor('comment:"ICML"')).toEqual([]);
      expect(idsFor('comment:"Withdrawn"')).toEqual(['annotated']);
      expect(idsFor('journal_ref:"Nature"')).toEqual(['annotated']);
    });

    it('drops the indexed comment when the paper is tombstoned', () => {
      seedAnnotated();
      store.applyBatch([], [{ paper_id: 'annotated' }]);
      expect(idsFor('comment:"ICML"')).toEqual([]);
      expect(idsFor('journal_ref:"Nature"')).toEqual([]);
    });
  });

  // Issue #36 — a `cat:` operand in the query text and the `category` parameter
  // are independent filters that the live path AND-s together. Merging them into
  // one OR-ed set would make the same inputs widen the result set here.
  describe('category groups are AND-ed (#36)', () => {
    beforeEach(() => {
      store.applyBatch(
        [
          mkRecord({ paper_id: 'both', categories: 'cs.LG stat.ML' }),
          mkRecord({ paper_id: 'lg-only', categories: 'cs.LG' }),
          mkRecord({ paper_id: 'ml-only', categories: 'stat.ML' }),
        ],
        [],
      );
    });

    const search = (categoryGroups: string[][]) =>
      store
        .search({
          categoryGroups,
          limit: 10,
          offset: 0,
          sortBy: 'updated',
          sortOrder: 'descending',
        })
        .papers.map((p) => p.id)
        .sort();

    it('intersects two groups instead of unioning them', () => {
      expect(search([['cs.LG'], ['stat.ML']])).toEqual(['both']);
    });

    it('still ORs codes within one group', () => {
      expect(search([['cs.LG', 'stat.ML']])).toEqual(['both', 'lg-only', 'ml-only']);
    });

    it('counts the intersection, not the union', () => {
      const result = store.search({
        categoryGroups: [['cs.LG'], ['stat.ML']],
        limit: 10,
        offset: 0,
        sortBy: 'updated',
        sortOrder: 'descending',
      });
      expect(result.total).toBe(1);
    });

    it('returns nothing when the groups cannot both be satisfied', () => {
      expect(search([['cs.LG'], ['astro-ph.CO']])).toEqual([]);
    });

    it('ignores an empty group rather than filtering everything out', () => {
      expect(search([['cs.LG'], []])).toEqual(['both', 'lg-only']);
    });
  });

  it('matches category filters against primary or secondary tokens', () => {
    store.applyBatch(
      [
        mkRecord({ paper_id: '1', categories: 'cs.LG stat.ML' }),
        mkRecord({ paper_id: '2', categories: 'stat.ML cs.LG' }),
        mkRecord({ paper_id: '3', categories: 'physics.flu-dyn' }),
      ],
      [],
    );
    const result = store.search({
      categoryGroups: [['stat.ML']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(2);
    expect(result.papers.map((p) => p.id).sort()).toEqual(['1', '2']);
  });

  // Issue #27 — `published` bounds. The category-browse fast path pages straight
  // off the junction index and never touches the generic WHERE clause, so a date
  // window has to force the generic path or the filter silently does nothing.
  describe('published date bounds', () => {
    beforeEach(() => {
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'early',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-09T23:59:59Z' }],
          }),
          mkRecord({
            paper_id: 'inside',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-10T12:00:00Z' }],
          }),
          mkRecord({
            paper_id: 'late',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-11T00:00:01Z' }],
          }),
        ],
        [],
      );
    });

    const search = (extra: Record<string, unknown>) =>
      store.search({
        limit: 10,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
        ...extra,
      });

    it('bounds rows inclusively on both ends', () => {
      const result = search({
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
      });
      expect(result.total).toBe(1);
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });

    it('applies each bound on its own', () => {
      expect(search({ publishedFrom: '2024-03-10T00:00:00.000Z' }).total).toBe(2);
      expect(search({ publishedTo: '2024-03-10T00:00:00.000Z' }).total).toBe(1);
    });

    it('applies the window on the single-category browse shape', () => {
      // Same shape that would otherwise take the junction-index fast path:
      // one category, no FTS term, non-published sort.
      const result = store.search({
        categoryGroups: [['cs.LG']],
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'updated',
        sortOrder: 'descending',
      });
      expect(result.total).toBe(1);
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });

    it('applies the window alongside an FTS term', () => {
      const result = store.search({
        matchExpr: '"Default"',
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
      });
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });
  });

  it('persists harvest state across writes', () => {
    store.writeHarvestState({
      status: 'in_progress',
      started_at: '2026-05-21T00:00:00Z',
      last_datestamp: '2024-01-22',
      resumption_token: 'tok',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('in_progress');
    expect(state.last_datestamp).toBe('2024-01-22');
    expect(state.resumption_token).toBe('tok');
  });

  it('preserves the completion marker across an in-progress refresh write (#21)', () => {
    // A completed cold harvest sets the durable markers.
    store.writeHarvestState({
      status: 'complete',
      started_at: '2024-02-21T00:00:00Z',
      completed_at: '2024-02-21T01:00:00Z',
      last_datestamp: '2024-02-20',
      total_records: 3_000_000,
    });
    // A subsequent refresh flips status to in_progress and omits the markers —
    // they must survive so readiness (which keys off completed_at) holds and the
    // mirror keeps serving the existing dataset throughout the refresh.
    store.writeHarvestState({
      status: 'in_progress',
      started_at: '2024-02-22T00:00:00Z',
      last_datestamp: '2024-02-21',
      resumption_token: 'tok',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('in_progress');
    expect(state.completed_at).toBe('2024-02-21T01:00:00Z');
    expect(state.total_records).toBe(3_000_000);
    expect(state.last_datestamp).toBe('2024-02-21');
  });

  it('preserves the completion marker across a failed refresh write (#21)', () => {
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-21T01:00:00Z',
      total_records: 3_000_000,
    });
    store.writeHarvestState({
      status: 'error',
      started_at: '2024-02-22T00:00:00Z',
      error_message: 'OAI ListRecords HTTP 503',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('error');
    expect(state.error_message).toBe('OAI ListRecords HTTP 503');
    expect(state.completed_at).toBe('2024-02-21T01:00:00Z');
    expect(state.total_records).toBe(3_000_000);
  });

  it('advances the completion marker when a later harvest completes (#21)', () => {
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-21T01:00:00Z',
      total_records: 3_000_000,
    });
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-22T01:00:00Z',
      total_records: 3_000_100,
    });
    const state = store.readHarvestState();
    expect(state.completed_at).toBe('2024-02-22T01:00:00Z');
    expect(state.total_records).toBe(3_000_100);
  });

  it('passes PRAGMA integrity checks on a freshly migrated database', () => {
    const result = store.integrityCheck();
    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  // `mirror:verify` checks each index and the fill trigger the schema defines
  // against the schema module: a file can record its version and still lack
  // one, and no open recreates it.
  describe('schema objects', () => {
    const SCHEMA_OBJECTS = [
      'index paper_categories_cat_published_idx',
      'index paper_categories_cat_updated_idx',
      'index papers_published_idx',
      'index papers_updated_idx',
      'index papers_revised_early_idx',
      'index paper_categories_paper_id_idx',
      'trigger paper_categories_published_fill',
    ];
    const statuses = () =>
      store.checkSchemaObjects().map((o) => `${o.type} ${o.name}: ${o.status}`);
    const allOk = SCHEMA_OBJECTS.map((object) => `${object}: ok`);
    const runOnFile = (...statements: string[]) => {
      const db = new Database(dbPath);
      for (const sql of statements) db.run(sql);
      db.close();
    };

    it('finds each one as the schema defines it in a new file', () => {
      expect(statuses()).toEqual(allOk);
    });

    it('reports a dropped and a redefined object, no open rebuilds them, and their restore statements do', async () => {
      runOnFile(
        'DROP INDEX papers_updated_idx',
        'DROP INDEX paper_categories_cat_published_idx',
        'CREATE INDEX paper_categories_cat_published_idx ON paper_categories(category, paper_id, published)',
        'DROP TRIGGER paper_categories_published_fill',
        'CREATE TRIGGER paper_categories_published_fill AFTER INSERT ON paper_categories BEGIN SELECT 1; END',
        // The definition the harvest runner built before v5 (#50).
        'DROP INDEX paper_categories_paper_id_idx',
        'CREATE INDEX paper_categories_paper_id_idx ON paper_categories(paper_id)',
      );
      const damaged = [
        'index paper_categories_cat_published_idx: differs',
        'index paper_categories_cat_updated_idx: ok',
        'index papers_published_idx: ok',
        'index papers_updated_idx: missing',
        'index papers_revised_early_idx: ok',
        'index paper_categories_paper_id_idx: differs',
        'trigger paper_categories_published_fill: differs',
      ];
      expect(statuses()).toEqual(damaged);

      store.close();
      store = await MirrorStore.open(dbPath);
      expect(statuses()).toEqual(damaged);

      runOnFile(...store.checkSchemaObjects().flatMap((o) => (o.status === 'ok' ? [] : o.restore)));
      expect(statuses()).toEqual(allOk);
    });

    it('takes a definition that differs from the schema only in spacing or IF NOT EXISTS as the same', () => {
      runOnFile(
        'DROP INDEX papers_published_idx',
        'CREATE INDEX IF NOT EXISTS papers_published_idx\n    ON papers(published,   updated)',
      );
      expect(statuses()).toEqual(allOk);
    });
  });

  // The junction's (paper_id, category) index: the write path's lookups by
  // paper_id (#50) and a term-less search's probe into each other group (#85).
  // The schema owns it from v5, so a new file holds it from its first commit.
  describe('paper_id index', () => {
    it('is in a new file from its first commit, as the schema defines it', () => {
      const db = new Database(dbPath, { readonly: true });
      const stored = db
        .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('paper_categories_paper_id_idx') as { sql: string } | null;
      const columns = (
        db.query(`PRAGMA index_info(paper_categories_paper_id_idx)`).all() as { name: string }[]
      ).map((c) => c.name);
      db.close();

      expect(columns).toEqual(['paper_id', 'category']);
      expect(stored?.sql).toBe(MIRROR_PAPER_ID_INDEX[1]);
      expect(MIRROR_V5_STATEMENTS).toEqual(MIRROR_PAPER_ID_INDEX);
      expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    });

    it('keeps record rewrites and tombstone cascades exact', () => {
      store.applyBatch([mkRecord({ paper_id: 'x', categories: 'cs.LG stat.ML' })], []);
      store.applyBatch([mkRecord({ paper_id: 'x', categories: 'math.AP' })], []);
      const count = (cat: string) =>
        store.search({
          categoryGroups: [[cat]],
          limit: 10,
          offset: 0,
          sortBy: 'updated',
          sortOrder: 'descending',
        }).total;
      expect([count('cs.LG'), count('stat.ML'), count('math.AP')]).toEqual([0, 0, 1]);

      store.applyBatch([], [{ paper_id: 'x' }]);
      expect(count('math.AP')).toBe(0);
    });
  });

  // Issue #64 — the mirror's SQL runs one statement at a time on both drivers,
  // so a failure stops the run and surfaces instead of being skipped.
  describe('statement execution (#64)', () => {
    it('holds one statement per entry, so no statement hides behind another', () => {
      // bun:sqlite's prepare compiles a string's first statement and drops the
      // rest silently; its text is what the statement reports back.
      const db = new Database(':memory:');
      for (const sql of [
        ...MIRROR_PRAGMA_STATEMENTS,
        ...MIRROR_SCHEMA_STATEMENTS,
        ...MIRROR_V4_STATEMENTS,
        ...MIRROR_V5_STATEMENTS,
        ...MIRROR_FTS_DROP_STATEMENTS,
        ...MIRROR_FTS_STATEMENTS,
      ]) {
        const stmt = db.prepare(sql);
        expect(stmt.toString().trim()).toBe(sql.trim());
        stmt.run();
        stmt.finalize();
      }
      db.close();
    });

    it('stops at the first schema statement that fails as it runs, and runs none after it', async () => {
      // A table holding the name of an FTS5 shadow table makes the index's
      // CREATE VIRTUAL TABLE fail when it runs, not when it compiles.
      const brokenPath = join(dir, 'broken.db');
      const raw = new Database(brokenPath);
      raw.run('CREATE TABLE papers_fts_data (id INTEGER PRIMARY KEY, block BLOB)');
      raw.close();

      const prepared = vi.spyOn(Database.prototype, 'prepare');
      const failure = await MirrorStore.open(brokenPath).catch((err: unknown) => err);
      const ran = prepared.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => MIRROR_SCHEMA_STATEMENTS.includes(sql));
      prepared.mockRestore();

      expect(failure).toBeInstanceOf(McpError);
      expect(String((failure as McpError).cause)).toMatch(/papers_fts_data/);
      // Nothing after the index ran: no sync triggers, no junction, no harvest state.
      const failedAt = MIRROR_SCHEMA_STATEMENTS.indexOf(MIRROR_FTS_STATEMENTS[0] as string);
      expect(ran).toEqual(MIRROR_SCHEMA_STATEMENTS.slice(0, failedAt + 1));
      // …and the schema runs in one transaction (#71), so what ran before it is
      // rolled back too: the file holds only what it held before the open.
      expect(tableNames(brokenPath)).toEqual(['papers_fts_data']);
      expect(triggerNames(brokenPath)).toEqual([]);
    });

    it('releases the file when the open fails', async () => {
      const brokenPath = join(dir, 'not-a-database.db');
      await writeFile(brokenPath, 'x'.repeat(4096));
      // The count sees a connection that holds the file.
      const live = new Database(brokenPath);
      expect(fdsOpenOn(brokenPath)).toBe(1);
      live.close();

      await expect(MirrorStore.open(brokenPath)).rejects.toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
      });

      expect(fdsOpenOn(brokenPath)).toBe(0);
    });
  });

  // Issue #49 — a search with an FTS term is driven from the FTS index: the
  // count and the page read only the matching rows, and relevance is BM25.
  describe('FTS-driven search (#49)', () => {
    const WORDS = ['protein', 'folding', 'galaxy', 'neural', 'quantum', 'graph', 'learning'];
    const AUTHORS = ['Alice Smith', 'Bob Jones', 'Carol Adams', 'Dan Smith'];
    const CATS = ['cs.LG', 'cs.AI', 'stat.ML', 'astro-ph.CO', 'math.AP', 'hep-th'];
    const pick = <T>(list: readonly T[], i: number): T => list[i % list.length] as T;

    /** 60 records whose fields, categories, and dates vary independently. */
    const seedVaried = () =>
      store.applyBatch(
        Array.from({ length: 60 }, (_, i) =>
          mkRecord({
            paper_id: `2001.${String(i).padStart(5, '0')}`,
            title: `${pick(WORDS, i)} ${pick(WORDS, i * 3 + 1)} study`,
            authors: `${pick(AUTHORS, i)}, ${pick(AUTHORS, i + 2)}`,
            abstract: `We examine ${pick(WORDS, i * 5 + 2)} with a neural network and ${pick(WORDS, i + 4)}.`,
            categories: `${pick(CATS, i)} ${pick(CATS, i * 7 + 3)}`,
            ...(i % 4 === 0 && { comments: 'Accepted at ICML, 9 pages' }),
            ...(i % 5 === 0 && { journal_ref: 'Nature Physics 17 (2021)' }),
            versions: [
              { version: 'v1', date: new Date(Date.UTC(2020, 0, 1 + i * 23)).toISOString() },
              {
                version: 'v2',
                date: new Date(Date.UTC(2024, 0, 1 + ((i * 37) % 60))).toISOString(),
              },
            ],
          }),
        ),
        [],
      );

    /** Real arXiv-syntax query shapes, run through the production translator. */
    const SHAPES: { category?: string; from?: string; q: string; to?: string }[] = [
      { q: 'ti:protein' },
      { q: 'au:smith' },
      { q: 'abs:"neural network"' },
      { q: 'co:accepted' },
      { q: 'jr:nature' },
      { q: 'all:quantum' },
      { q: 'protein AND folding' },
      { q: 'protein OR galaxy' },
      { q: 'learning ANDNOT graph' },
      { q: '(protein OR galaxy) AND cat:cs.LG' },
      { q: 'all:study AND cat:cs', category: 'math' },
      { q: 'graph', category: 'astro-ph' },
      { q: 'all:study', from: '2021-01-01T00:00:00.000Z', to: '2022-12-31T00:00:00.000Z' },
      { q: 'neural AND submittedDate:[202001010000 TO 202106300000]' },
      { q: 'au:smith OR co:icml', category: 'cs.AI', from: '2020-06-01T00:00:00.000Z' },
    ];

    const resolve = (shape: (typeof SHAPES)[number]) => {
      const t = translateQuery(shape.q);
      if (t.route === 'live') throw new Error(`${shape.q} routes live (${t.reason})`);
      const categoryGroups = [
        ...t.categoryGroups,
        shape.category ? categorySubtree(shape.category) : [],
      ].filter((g) => g.length > 0);
      const from = shape.from ?? t.published.from;
      const to = shape.to ?? t.published.to;
      return {
        matchExpr: t.matchExpr as string,
        categoryGroups,
        ...(from !== undefined && { publishedFrom: from }),
        ...(to !== undefined && { publishedTo: to }),
      };
    };

    /** The rowid-IN filter `store.search` ran before #49, kept as the reference. */
    async function legacyIds(filters: ReturnType<typeof resolve>): Promise<string[]> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const where = ['papers.rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)'];
      const params: string[] = [filters.matchExpr];
      for (const group of filters.categoryGroups) {
        where.push(
          `papers.id IN (SELECT paper_id FROM paper_categories WHERE category IN (${group.map(() => '?').join(', ')}))`,
        );
        params.push(...group);
      }
      if (filters.publishedFrom !== undefined) {
        where.push('papers.published >= ?');
        params.push(filters.publishedFrom);
      }
      if (filters.publishedTo !== undefined) {
        where.push('papers.published <= ?');
        params.push(filters.publishedTo);
      }
      const rows = db
        .prepare(`SELECT papers.id AS id FROM papers WHERE ${where.join(' AND ')}`)
        .all(...params) as { id: string }[];
      db.close();
      return rows.map((r) => r.id).sort();
    }

    it.each(SHAPES.map((s) => [s.q + (s.category ? ` [category ${s.category}]` : ''), s] as const))(
      'matches the same set and count as the rowid-IN form for %s',
      async (_label, shape) => {
        seedVaried();
        const filters = resolve(shape);
        const expected = await legacyIds(filters);
        expect(expected.length).toBeGreaterThan(0);
        for (const sortBy of ['relevance', 'published', 'updated'] as const) {
          const result = store.search({
            ...filters,
            limit: 1_000,
            offset: 0,
            sortBy,
            sortOrder: 'descending',
          });
          expect(result.total).toBe(expected.length);
          expect(result.papers.map((p) => p.id).sort()).toEqual(expected);
        }
      },
    );

    // The unfiltered shape counts from the index alone; the filtered one counts
    // inside its page query, and past the end has no page row to count from.
    const PAGED = [
      { label: 'unfiltered', shape: { q: 'all:study' }, total: 60 },
      {
        label: 'category- and date-filtered',
        shape: { q: 'all:study', category: 'cs', from: '2020-06-01T00:00:00.000Z' },
        total: 35,
      },
    ];
    it.each(
      PAGED.flatMap((p) =>
        (['relevance', 'published', 'updated'] as const).map(
          (sortBy) => [p.label, sortBy, p] as const,
        ),
      ),
    )(
      'pages a %s %s-sorted result without gaps or repeats, and past the end returns nothing',
      async (_label, sortBy, { shape, total }) => {
        seedVaried();
        const filters = resolve(shape);
        const run = (limit: number, offset: number) =>
          store.search({ ...filters, limit, offset, sortBy, sortOrder: 'ascending' });
        const full = run(1_000, 0);
        expect(full.total).toBe(total);
        expect(full.papers.map((p) => p.id).sort()).toEqual(await legacyIds(filters));

        const walked: string[] = [];
        for (let offset = 0; ; offset += 7) {
          const page = run(7, offset);
          expect(page.total).toBe(total);
          if (page.papers.length === 0) break;
          walked.push(...page.papers.map((p) => p.id));
        }
        expect(walked).toEqual(full.papers.map((p) => p.id));

        expect(run(7, total)).toEqual({ papers: [], total, totalIsLowerBound: false });
        expect(run(7, total + 50)).toEqual({ papers: [], total, totalIsLowerBound: false });
      },
    );

    it('returns an exact zero for a term nothing matches', () => {
      seedVaried();
      expect(
        store.search({
          matchExpr: '"nonexistentterm"',
          limit: 10,
          offset: 0,
          sortBy: 'relevance',
          sortOrder: 'descending',
        }),
      ).toEqual({ papers: [], total: 0, totalIsLowerBound: false });
    });

    it('orders relevance pages by BM25 score, best first, not by insertion order', async () => {
      const filler = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');
      store.applyBatch(
        [
          mkRecord({ paper_id: 'weak', title: 'Survey', abstract: `${filler} quantum ${filler}` }),
          mkRecord({ paper_id: 'strong', title: 'Quantum', abstract: 'quantum quantum computing' }),
          mkRecord({ paper_id: 'medium', title: 'Notes', abstract: 'quantum notes on things' }),
          mkRecord({ paper_id: 'unrelated', title: 'Galaxy', abstract: 'galaxy survey' }),
        ],
        [],
      );
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const scored = db
        .prepare(
          `SELECT papers.id AS id, bm25(papers_fts) AS score
           FROM papers_fts JOIN papers ON papers.rowid = papers_fts.rowid
           WHERE papers_fts MATCH ? ORDER BY score`,
        )
        .all('"quantum"') as { id: string; score: number }[];
      db.close();

      // The reference ranking really is BM25: negative, ascending, and not the
      // order the rows were written in.
      expect(scored.every((r) => r.score < 0)).toBe(true);
      expect(scored.map((r) => r.score)).toEqual(
        [...scored.map((r) => r.score)].sort((a, b) => a - b),
      );
      expect(scored.map((r) => r.id)).not.toEqual(['weak', 'strong', 'medium']);

      const result = store.search({
        matchExpr: '"quantum"',
        limit: 10,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });
      expect(result.papers.map((p) => p.id)).toEqual(scored.map((r) => r.id));
      expect(result.total).toBe(3);
    });

    it('orders a category- and date-filtered relevance page by BM25 too', () => {
      const filler = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');
      store.applyBatch(
        [
          mkRecord({ paper_id: 'weak', title: 'Survey', abstract: `${filler} quantum ${filler}` }),
          mkRecord({ paper_id: 'strong', title: 'Quantum', abstract: 'quantum quantum computing' }),
          mkRecord({ paper_id: 'medium', title: 'Notes', abstract: 'quantum notes on things' }),
          mkRecord({
            paper_id: 'other-category',
            title: 'Quantum',
            abstract: 'quantum quantum quantum',
            categories: 'hep-th',
          }),
        ],
        [],
      );

      const result = store.search({
        matchExpr: '"quantum"',
        categoryGroups: [['cs.LG']],
        publishedFrom: '2024-01-01T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });

      expect(result.total).toBe(3);
      expect(result.papers.map((p) => p.id)).toEqual(['strong', 'medium', 'weak']);
    });

    // Issue #84 — a term beside a category group tests each FTS hit against the
    // group from the hit's own `papers.categories`; no statement reads the junction.
    describe('a term beside a category group (#84)', () => {
      const TERM_GROUP_SHAPES: (typeof SHAPES)[number][] = [
        { q: 'all:study AND cat:cs' },
        { q: 'all:study AND cat:cs', category: 'math' },
        { q: '(protein OR galaxy) AND cat:cs.LG', category: 'astro-ph' },
        {
          q: 'all:study AND cat:cs',
          from: '2021-01-01T00:00:00.000Z',
          to: '2022-12-31T00:00:00.000Z',
        },
        { q: 'au:smith OR co:icml', category: 'cs', from: '2020-06-01T00:00:00.000Z' },
      ];

      /** One page as the store answered it before #84: the group read through `IN (SELECT …)`. */
      function pageBefore84(
        filters: ReturnType<typeof resolve>,
        sortBy: 'relevance' | 'published' | 'updated',
        offset: number,
      ): { ids: string[]; total: number } {
        const db = new Database(dbPath, { readonly: true });
        const where = ['papers_fts MATCH ?'];
        const params: string[] = [filters.matchExpr];
        for (const group of filters.categoryGroups) {
          where.push(
            `papers.id IN (SELECT paper_id FROM paper_categories WHERE category IN (${group.map(() => '?').join(', ')}))`,
          );
          params.push(...group);
        }
        if (filters.publishedFrom !== undefined) {
          where.push('papers.published >= ?');
          params.push(filters.publishedFrom);
        }
        if (filters.publishedTo !== undefined) {
          where.push('papers.published <= ?');
          params.push(filters.publishedTo);
        }
        const order = sortBy === 'relevance' ? 'papers_fts.rank' : `papers.${sortBy} DESC`;
        const from = `FROM papers_fts CROSS JOIN papers ON papers.rowid = papers_fts.rowid WHERE ${where.join(' AND ')}`;
        const ids = (
          db
            .prepare(
              `SELECT papers.id AS id ${from} ORDER BY ${order}, papers.rowid LIMIT 7 OFFSET ?`,
            )
            .all(...params, offset) as { id: string }[]
        ).map((r) => r.id);
        const { n } = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number };
        db.close();
        return { ids, total: n };
      }

      it.each(
        TERM_GROUP_SHAPES.map(
          (s) => [s.q + (s.category ? ` [category ${s.category}]` : ''), s] as const,
        ),
      )('answers %s with the totals, papers, and order it gave before', (_label, shape) => {
        seedVaried();
        // Matches for every shape's term that carry one shape group and not the other.
        store.applyBatch(
          ['math.AP astro-ph.CO', 'cs.LG hep-th'].map((categories, i) =>
            mkRecord({
              paper_id: `one-sided-${i}`,
              title: 'protein galaxy study',
              authors: 'Ann Smith',
              comments: 'ICML',
              categories,
              versions: [{ version: 'v1', date: '2021-06-01T00:00:00Z' }],
            }),
          ),
          [],
        );
        const filters = resolve(shape);
        // Every group drops some of the term's matches, so a group the store ignored would show.
        const { total } = pageBefore84(filters, 'relevance', 0);
        for (const group of filters.categoryGroups) {
          const without = filters.categoryGroups.filter((g) => g !== group);
          expect(
            pageBefore84({ ...filters, categoryGroups: without }, 'relevance', 0).total,
            group.join(' '),
          ).toBeGreaterThan(total);
        }
        for (const sortBy of ['relevance', 'published', 'updated'] as const) {
          for (const offset of [0, 7]) {
            const result = store.search({
              ...filters,
              limit: 7,
              offset,
              sortBy,
              sortOrder: 'descending',
            });
            const before = pageBefore84(filters, sortBy, offset);
            expect(before.total).toBeGreaterThan(0);
            expect({ ids: result.papers.map((p) => p.id), total: result.total }).toEqual(before);
            expect(result.totalIsLowerBound).toBe(false);
          }
        }
      });

      it.each(
        TERM_GROUP_SHAPES.map(
          (s) => [s.q + (s.category ? ` [category ${s.category}]` : ''), s] as const,
        ),
      )(
        'tests each match against the group without reading the junction for %s',
        (_label, shape) => {
          seedVaried();
          const filters = resolve(shape);
          for (const sortBy of ['relevance', 'published', 'updated'] as const) {
            const statements = preparedBy(() =>
              store.search({ ...filters, limit: 7, offset: 0, sortBy, sortOrder: 'descending' }),
            );
            expect(statements.length, sortBy).toBeGreaterThan(0);
            for (const sql of statements) {
              // The junction under any alias, through any of its indexes.
              expect(sql, sortBy).not.toMatch(/paper_categories/);
              expect(planOf(dbPath, sql).join('\n'), sql).not.toMatch(
                /LIST SUBQUERY|paper_categories/,
              );
            }
          }
        },
      );

      it('matches a group code only as a whole category token, wherever the paper lists it', () => {
        store.applyBatch(
          [
            mkRecord({ paper_id: 'lg', title: 'probe', categories: 'cs.LG' }),
            mkRecord({ paper_id: 'str-el', title: 'probe', categories: 'cond-mat.str-el' }),
            mkRecord({ paper_id: 'math-ph', title: 'probe', categories: 'math-ph' }),
            mkRecord({ paper_id: 'three', title: 'probe', categories: 'hep-th math.AP cs.CV' }),
          ],
          [],
        );
        const ids = (...categoryGroups: string[][]) =>
          store
            .search({
              matchExpr: '"probe"',
              categoryGroups,
              limit: 10,
              offset: 0,
              sortBy: 'relevance',
              sortOrder: 'descending',
            })
            .papers.map((p) => p.id)
            .sort();

        // A code that is a prefix, a suffix, or a hyphenated stem of a carried one.
        expect(ids(['cs.L'])).toEqual([]);
        expect(ids(['LG'])).toEqual([]);
        expect(ids(['cond-mat'])).toEqual([]);
        expect(ids(['math'])).toEqual([]);
        // A quoted `cat:` operand reaches the store verbatim: two adjacent codes are no one code.
        expect(translateQuery('probe AND cat:"hep-th math.AP"')).toMatchObject({
          route: 'mirror',
          categoryGroups: [['hep-th math.AP']],
        });
        expect(ids(['hep-th math.AP'])).toEqual([]);
        expect(ids(['math.AP cs.CV', 'cs.LG'])).toEqual(['lg']);
        // First, middle, and last of a paper's codes; OR within a group, AND across.
        expect(ids(['hep-th'])).toEqual(['three']);
        expect(ids(['math.AP'])).toEqual(['three']);
        expect(ids(['cs.CV'])).toEqual(['three']);
        expect(ids(['cs.LG', 'cond-mat.str-el'])).toEqual(['lg', 'str-el']);
        expect(ids(['math.AP'], ['cs.CV', 'cs.LG'])).toEqual(['three']);
        expect(ids(['math.AP'], ['cs.LG'])).toEqual([]);
      });
    });
  });
});

/**
 * Issue #49 — the bounded probe that decides whether a free-text search is small
 * enough for the mirror. One store holds 50,001 matches of `everyword`; the
 * marker terms sit one below, at, and above the cap.
 */
describe('MirrorStore.matchReachesCap (#49)', () => {
  let dir: string;
  let store: MirrorStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-cap-test-'));
    const dbPath = join(dir, 'mirror.db');
    (await MirrorStore.open(dbPath)).close();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50001)
      INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                         categories, published, updated, latest_version)
      SELECT 'bulk.' || i, '1', 'Bulk', 'A',
             CASE WHEN i < 50000 THEN 'everyword nearcap atcap'
                  WHEN i = 50000 THEN 'everyword atcap'
                  ELSE 'everyword' END,
             'cs.LG', 'cs.LG', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
             '2024-01-01T00:00:00.000Z'
      FROM n;
      INSERT INTO paper_categories(category, paper_id, updated, published)
      SELECT 'cs.LG', id, updated, published FROM papers;
    `);
    db.close();
    store = await MirrorStore.open(dbPath);
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('stays under the cap one match below it', () => {
    expect(store.matchReachesCap('"nearcap"')).toBe(false);
  });

  it('reaches the cap at exactly the cap and above it', () => {
    expect(store.matchReachesCap('"atcap"')).toBe(true);
    expect(store.matchReachesCap('"everyword"')).toBe(true);
  });

  it('stays under the cap for a term with no matches', () => {
    expect(store.matchReachesCap('"absent"')).toBe(false);
  });

  it('raises the FTS5 parse error for a malformed expression', () => {
    expect(() => store.matchReachesCap('title:')).toThrow(/^fts5:/);
  });

  it('counts a just-under-cap match set exactly, with and without a category group', () => {
    const run = (categoryGroups: string[][]) =>
      store.search({
        matchExpr: '"nearcap"',
        categoryGroups,
        limit: 2,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });
    expect(run([]).total).toBe(49_999);
    expect(run([['cs.LG']]).total).toBe(49_999);
    expect(run([['cs.LG']]).papers).toHaveLength(2);
  });
});

/**
 * Issue #78 — a search with no free-text term counts at most the match cap
 * (a single code excepted) and reads at most that many index entries for a
 * page. The corpus holds 60,000 papers, three per submission hour (so
 * `published` ties in threes) and each revised 0–4 days after it (so `updated`
 * ties too); IDs are a permutation of insertion order, so a tie broken on the
 * ID and one broken on the rowid come out in different orders. One more paper
 * was last revised before it was submitted, as arXiv dates a few.
 */
describe('MirrorStore.search without a free-text term (#78)', () => {
  const PAPERS = 60_000;
  /** Each code's members, by insertion index `i`. */
  const CODES: [code: string, members: string][] = [
    ['cs.LG', 'i % 2 = 0'],
    ['cs.AI', 'i % 2 = 1'],
    ['cs.CL', 'i % 3 = 0'],
    ['stat.ML', 'i % 10 != 0'],
    ['math.AP', 'i % 7 = 0'],
    ['q-fin.ST', 'i % 20 != 0'],
  ];
  const CS = categorySubtree('cs');
  /** The one paper last revised before it was submitted, in `cs.LG` and `stat.ML`. */
  const REVISED_EARLY = 'p60000';
  /** The instant `hours` after the first submission in the corpus. */
  const at = (hours: number) => new Date(Date.UTC(2020, 0, 1) + hours * 3_600_000).toISOString();

  interface Shape {
    /** Bounds on `published`, in hours after the first submission. */
    from?: number;
    groups: string[][];
    label: string;
    sortBy: 'relevance' | 'published' | 'updated';
    sortOrder?: 'ascending' | 'descending';
    to?: number;
  }

  // Match counts in the comments; the cap is 50,000.
  const SHAPES: Shape[] = [
    { label: 'a multi-code group by relevance', groups: [CS], sortBy: 'relevance' }, // 60,001
    { label: 'a multi-code group by submission', groups: [CS], sortBy: 'published' },
    {
      label: 'a multi-code group by update, ascending',
      groups: [CS],
      sortBy: 'updated',
      sortOrder: 'ascending',
    },
    {
      label: 'a multi-code group in a window by relevance',
      groups: [CS],
      from: 0,
      to: 20_000,
      sortBy: 'relevance',
    }, // 60,001
    {
      label: 'a multi-code group in a window open above, by submission ascending',
      groups: [CS],
      from: 2_000,
      sortBy: 'published',
      sortOrder: 'ascending',
    }, // 54,001
    {
      label: 'a multi-code group in a narrow window by relevance',
      groups: [CS],
      from: 1_000,
      to: 7_000,
      sortBy: 'relevance',
    }, // 18,004
    { label: 'a window alone by relevance', groups: [], from: 0, to: 20_000, sortBy: 'relevance' },
    { label: 'a window open above, by submission', groups: [], from: 0, sortBy: 'published' },
    {
      label: 'a window open above, by update ascending',
      groups: [],
      from: 1_000,
      sortBy: 'updated',
      sortOrder: 'ascending',
    }, // 57,001
    {
      label: 'a narrow window alone by relevance',
      groups: [],
      from: 5_000,
      to: 15_000,
      sortBy: 'relevance',
    }, // 30,004
    {
      label: 'a window open below, by submission ascending',
      groups: [],
      to: 9_000,
      sortBy: 'published',
      sortOrder: 'ascending',
    }, // 27,004
    { label: 'no filter at all', groups: [], sortBy: 'relevance' }, // 60,001
    { label: 'two groups by relevance', groups: [CS, ['stat.ML']], sortBy: 'relevance' }, // 54,001
    { label: 'two groups by submission', groups: [['stat.ML'], CS], sortBy: 'published' },
    {
      label: 'two groups in a window by update',
      groups: [CS, ['stat.ML']],
      from: 0,
      to: 20_000,
      sortBy: 'updated',
    },
    {
      label: 'two groups meeting under the cap',
      groups: [['cs.LG'], ['cs.CL']],
      sortBy: 'relevance',
    }, // 10,000
    {
      label: 'a small group beside a large one',
      groups: [CS, ['math.AP']],
      sortBy: 'relevance',
    }, // 8,572
    {
      label: 'two codes over the cap, the smaller listed second',
      groups: [['q-fin.ST'], ['stat.ML']],
      sortBy: 'relevance',
    }, // 54,000
    { label: 'one code by submission', groups: [['stat.ML']], sortBy: 'published' }, // 54,001
    {
      label: 'one code in a window by relevance',
      groups: [['stat.ML']],
      from: 0,
      to: 20_000,
      sortBy: 'relevance',
    },
    {
      label: 'one code in a window by update, ascending',
      groups: [['math.AP']],
      from: 2_000,
      to: 12_000,
      sortBy: 'updated',
      sortOrder: 'ascending',
    },
    { label: 'one code by relevance (the fast path)', groups: [['cs.LG']], sortBy: 'relevance' }, // 30,001
    { label: 'a code no paper carries', groups: [['q-bio.BM']], sortBy: 'relevance' },
    {
      label: 'two groups no paper carries both of',
      groups: [['cs.LG'], ['cs.AI']],
      sortBy: 'published',
    },
    {
      label: 'a multi-code group in a window open above, by update ascending',
      groups: [CS],
      from: 1_000,
      sortBy: 'updated',
      sortOrder: 'ascending',
    }, // 57,001
    {
      label: 'one code in a window open above, by update ascending',
      groups: [['stat.ML']],
      from: 1_000,
      sortBy: 'updated',
      sortOrder: 'ascending',
    }, // 51,301
  ];
  const cases = SHAPES.map((s) => [s.label, s] as const);

  let dir: string;
  let dbPath: string;
  let store: MirrorStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-browse-test-'));
    dbPath = join(dir, 'mirror.db');
    (await MirrorStore.open(dbPath)).close();
    const db = new Database(dbPath);
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                          categories, published, updated, latest_version)
       SELECT printf('p%05d', i * 7919 % ?), '1', 'Paper', 'A. Author', 'Abstract', 'cs.LG',
              'cs.LG', strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i / 3) || ' hours'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i / 3 + 24 * (i % 5)) || ' hours'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i / 3 + 24 * (i % 5)) || ' hours')
       FROM n`,
    ).run(PAPERS - 1, PAPERS);
    for (const [code, members] of CODES) {
      db.prepare(
        `INSERT INTO paper_categories(category, paper_id, updated, published)
         SELECT ?, id, updated, published FROM (SELECT rowid - 1 AS i, * FROM papers) WHERE ${members}`,
      ).run(code);
    }
    // arXiv dates some revisions before their paper's first version
    // (math/0002124: submitted 2000-02-15, revised 1999-11-17). This one is
    // submitted inside every window that opens by hour 5,000 and revised before
    // any of them opens.
    db.prepare(
      `INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                          categories, published, updated, latest_version)
       VALUES (?, '2', 'Paper', 'A. Author', 'Abstract', 'cs.LG', 'cs.LG stat.ML', ?, ?, ?)`,
    ).run(REVISED_EARLY, at(5_000.5), at(500.5), at(500.5));
    for (const code of ['cs.LG', 'stat.ML']) {
      db.prepare(
        `INSERT INTO paper_categories(category, paper_id, updated, published)
         SELECT ?, id, updated, published FROM papers WHERE id = ?`,
      ).run(code, REVISED_EARLY);
    }
    db.close();
    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    store = opened.store;
  }, 30_000);

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const optionsFor = (shape: Shape, offset: number, limit = 10) => ({
    categoryGroups: shape.groups,
    ...(shape.from !== undefined && { publishedFrom: at(shape.from) }),
    ...(shape.to !== undefined && { publishedTo: at(shape.to) }),
    limit,
    offset,
    sortBy: shape.sortBy,
    sortOrder: shape.sortOrder ?? ('descending' as const),
  });

  const references = new Map<Shape, { ids: string[]; keys: string[] }>();
  /**
   * Every match, in the order the search pages through them: by the sort key,
   * ties broken on the paper ID when a category group filters and on the rowid
   * otherwise. Read with the `IN (SELECT …)` filter the store used before #78.
   */
  function reference(shape: Shape): { ids: string[]; keys: string[] } {
    const cached = references.get(shape);
    if (cached) return cached;
    const where: string[] = [];
    const params: string[] = [];
    for (const group of shape.groups) {
      where.push(
        `id IN (SELECT paper_id FROM paper_categories WHERE category IN (${group.map(() => '?').join(', ')}))`,
      );
      params.push(...group);
    }
    if (shape.from !== undefined) {
      where.push('published >= ?');
      params.push(at(shape.from));
    }
    if (shape.to !== undefined) {
      where.push('published <= ?');
      params.push(at(shape.to));
    }
    const key = shape.sortBy === 'published' ? 'published' : 'updated';
    const dir = shape.sortBy !== 'relevance' && shape.sortOrder === 'ascending' ? 'ASC' : 'DESC';
    const tie = shape.groups.length > 0 ? 'id' : 'rowid';
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, ${key} AS k FROM papers ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${key} ${dir}, ${tie} ${dir}`,
      )
      .all(...params) as { id: string; k: string }[];
    db.close();
    const found = { ids: rows.map((r) => r.id), keys: rows.map((r) => r.k) };
    references.set(shape, found);
    return found;
  }

  const isSingleCode = (shape: Shape) => shape.groups.length === 1 && shape.groups[0]?.length === 1;

  it('seeds shapes on both sides of the cap, with ties that straddle a page boundary', () => {
    const counts = SHAPES.map((s) => reference(s).ids.length);
    expect(counts.filter((n) => n >= MIRROR_SEARCH_MATCH_CAP).length).toBeGreaterThanOrEqual(10);
    expect(
      counts.filter((n) => n > 0 && n < MIRROR_SEARCH_MATCH_CAP).length,
    ).toBeGreaterThanOrEqual(6);
    const { keys } = reference(SHAPES[7] as Shape);
    expect(keys[9]).toBe(keys[10]);
    // An update order over a window at the cap starts with the paper revised before it opened.
    for (const s of SHAPES.filter((s) => s.from === 1_000 && s.sortOrder === 'ascending')) {
      expect(reference(s).ids.length, s.label).toBeGreaterThanOrEqual(MIRROR_SEARCH_MATCH_CAP);
      expect(reference(s).ids[0], s.label).toBe(REVISED_EARLY);
    }
  });

  it.each(cases)(
    'counts %s exactly for one code, and up to the cap for any other',
    (_label, shape) => {
      const matches = reference(shape).ids.length;
      const { total, totalIsLowerBound } = store.search(optionsFor(shape, 0));
      expect({ total, totalIsLowerBound }).toEqual(
        isSingleCode(shape) || matches < MIRROR_SEARCH_MATCH_CAP
          ? { total: matches, totalIsLowerBound: false }
          : { total: MIRROR_SEARCH_MATCH_CAP, totalIsLowerBound: true },
      );
    },
  );

  it.each(cases)(
    'pages %s in sort order with ties broken on a unique key, through start 10,000',
    (_label, shape) => {
      const { ids, keys } = reference(shape);
      const sortKey = (p: { published: string; updated: string }) =>
        shape.sortBy === 'published' ? p.published : p.updated;
      for (const offset of [0, 10, 10_000]) {
        const { papers } = store.search(optionsFor(shape, offset));
        // The sort key alone is the order the store kept before #78, which left ties unordered.
        expect(papers.map(sortKey)).toEqual(keys.slice(offset, offset + 10));
        expect(papers.map((p) => p.id)).toEqual(ids.slice(offset, offset + 10));
      }
      // Pages of 7 cut tie groups of 3 at every offset: none overlaps or skips.
      const walked: string[] = [];
      for (let offset = 0; offset < 63; offset += 7) {
        walked.push(...store.search(optionsFor(shape, offset, 7)).papers.map((p) => p.id));
      }
      expect(walked).toEqual(ids.slice(0, 63));
    },
  );

  it.each(cases)(
    'plans %s with no list subquery, no full sort at the cap, and no papers row outside the page',
    (_label, shape) => {
      const atCap = reference(shape).ids.length >= MIRROR_SEARCH_MATCH_CAP;
      // One code in update order with no window keeps its #19 plan: the page
      // joins `papers` by ID as it walks the junction index.
      const fastPath =
        isSingleCode(shape) &&
        shape.from === undefined &&
        shape.to === undefined &&
        shape.sortBy !== 'published';
      for (const offset of atCap ? [0, 10_000] : [0]) {
        const statements = preparedBy(() => store.search(optionsFor(shape, offset)));
        expect(statements.length).toBeGreaterThan(0);
        for (const sql of statements) {
          const plan = planOf(dbPath, sql);
          expect(plan.join('\n'), sql).not.toMatch(/LIST SUBQUERY/);
          if (isPageFetch(sql)) continue;
          if (atCap) expect(plan.join('\n'), sql).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
          // Any read of a `papers` row: by table name, through one of its indexes, or by rowid.
          const readsPapers = (l: string) =>
            /\b(SCAN|SEARCH) papers\b|sqlite_autoindex_papers_1|\bpapers_\w+_idx\b|INTEGER PRIMARY KEY/.test(
              l,
            );
          for (const line of plan.filter(readsPapers)) {
            expect(line, sql).toMatch(
              fastPath && !/COUNT\(\*\)/.test(sql)
                ? /COVERING INDEX|sqlite_autoindex_papers_1 \(id=\?\)/
                : /COVERING INDEX/,
            );
          }
        }
      }
    },
  );

  it.each([
    ['ascending', 'ascending'],
    ['descending', 'descending'],
  ] as const)(
    'browses one code by update, %s, straight off the index with no sort',
    (_label, sortOrder) => {
      const shape: Shape = {
        label: 'the fast path',
        groups: [['cs.LG']],
        sortBy: 'updated',
        sortOrder,
      };
      const { ids } = reference(shape);
      for (const offset of [0, 10_000]) {
        let page: string[] = [];
        const statements = preparedBy(() => {
          page = store.search(optionsFor(shape, offset)).papers.map((p) => p.id);
        });
        expect(page).toEqual(ids.slice(offset, offset + 10));
        const browse = statements.filter((s) => !/COUNT\(\*\)/.test(s) && !isPageFetch(s));
        expect(browse.length).toBeGreaterThan(0);
        for (const sql of browse) {
          expect(planOf(dbPath, sql).join('\n'), sql).not.toMatch(/USE TEMP B-TREE/);
        }
      }
    },
  );

  describe('the group that drives two or more', () => {
    const shape = (label: string) => {
      const found = SHAPES.find((s) => s.label === label);
      if (!found) throw new Error(`no shape '${label}'`);
      return found;
    };
    /** The codes bound to the first `IN` list of the count that probes the other groups. */
    function driverOf(s: Shape): string[] {
      const count = boundBy(() => store.search(optionsFor(s, 0))).find(
        ({ sql }) => /COUNT\(\*\)/.test(sql) && /EXISTS/.test(sql),
      );
      if (!count) throw new Error('no count probed a second group');
      const slots = /IN \(([?, ]+)\)/.exec(count.sql)?.[1]?.split(',').length ?? 0;
      return count.params.slice(0, slots) as string[];
    }

    it('is the code with fewer junction rows when both pass the cap', () => {
      // q-fin.ST holds 57,000 rows, stat.ML 54,001.
      expect(driverOf(shape('two codes over the cap, the smaller listed second'))).toEqual([
        'stat.ML',
      ]);
    });

    it('stays the group under the cap when two others tie there', () => {
      const three: Shape = {
        label: 'three groups',
        groups: [['q-fin.ST'], ['stat.ML'], ['math.AP']],
        sortBy: 'relevance',
      };
      expect(driverOf(three)).toEqual(['math.AP']);
      // Every other group is still tested on each candidate.
      const { ids } = reference(three);
      for (const offset of [0, 10]) {
        const page = store.search(optionsFor(three, offset));
        expect({ ids: page.papers.map((p) => p.id), total: page.total }).toEqual({
          ids: ids.slice(offset, offset + 10),
          total: ids.length,
        });
      }
    });

    it('is the group with fewer junction rows beside a whole archive, in either operand order (#85)', () => {
      // Both pass the cap; stat.ML holds 54,001 rows and cs 80,001 across its
      // codes. Each stat.ML candidate costs one seek into cs however many codes
      // cs holds, so the code count no longer decides.
      expect(driverOf(shape('two groups by submission'))).toEqual(['stat.ML']);
      expect(driverOf(shape('two groups by relevance'))).toEqual(['stat.ML']);
    });

    it('is the same group whichever order the operands come in (#85)', () => {
      for (const groups of [
        [['q-fin.ST'], ['stat.ML']],
        [['stat.ML'], ['q-fin.ST']],
      ]) {
        expect(driverOf({ label: 'swapped', groups, sortBy: 'relevance' })).toEqual(['stat.ML']);
      }
    });

    // Issue #85 — a group with no row in the window ends the search at 0
    // before any group is counted.
    it.each([
      [[['cs.LG'], ['q-bio.BM']]],
      [[['q-bio.BM'], ['cs.LG']]],
      [[CS, ['stat.ML'], ['q-bio.BM']]],
    ])('answers %j with 0, counting no other group’s rows', (groups) => {
      const s: Shape = { label: 'empty', groups, sortBy: 'relevance' };
      let page: ReturnType<MirrorStore['search']> | undefined;
      const runs = boundBy(() => {
        page = store.search(optionsFor(s, 0));
      });
      expect(page).toEqual({ papers: [], total: 0, totalIsLowerBound: false });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.filter(({ sql }) => /COUNT\(\*\)/.test(sql))).toEqual([]);
    });

    it.each([
      'two codes over the cap, the smaller listed second',
      'two groups meeting under the cap',
    ])('takes no DISTINCT pass when it holds one code: %s', (label) => {
      const s = shape(label);
      expect(driverOf(s)).toHaveLength(1);
      const atCap = reference(s).ids.length >= MIRROR_SEARCH_MATCH_CAP;
      for (const offset of atCap ? [0, 10_000] : [0]) {
        for (const sql of preparedBy(() => store.search(optionsFor(s, offset)))) {
          expect(planOf(dbPath, sql).join('\n'), sql).not.toMatch(/TEMP B-TREE FOR DISTINCT/);
        }
      }
    });
  });

  // Issue #85 — every other group costs one covering seek per candidate: its
  // primary-key entry for one code, else the paper's entries in
  // paper_categories_paper_id_idx (paper_id, category), never one seek per code.
  describe('the probe into each other group', () => {
    // SQLite plans an EXISTS probe as `SEARCH pc EXISTS …` where it folds the
    // probe into the outer loop and as a correlated subquery's `SEARCH pc …`
    // elsewhere: the same one seek either way, so both read as one.
    const seekOf = (line: string) => line.replace(/^SEARCH pc EXISTS /, 'SEARCH pc ');
    const PK_SEEK =
      'SEARCH pc USING COVERING INDEX sqlite_autoindex_paper_categories_1 (category=? AND paper_id=?)';
    const PAPER_SEEK = 'SEARCH pc USING COVERING INDEX paper_categories_paper_id_idx (paper_id=?)';
    const PROBED: Shape[] = [
      { label: 'cs beside stat.ML, at the cap', groups: [CS, ['stat.ML']], sortBy: 'updated' },
      {
        label: 'cs beside stat.ML in a window, by submission',
        groups: [['stat.ML'], CS],
        from: 0,
        to: 20_000,
        sortBy: 'published',
      },
      {
        label: 'cs and stat.ML beside math.AP, under the cap',
        groups: [CS, ['stat.ML'], ['math.AP']],
        sortBy: 'relevance',
      },
    ];

    it.each(PROBED.map((s) => [s.label, s] as const))(
      'seeks a several-code group once per candidate, by paper, in every count and page: %s',
      (_label, s) => {
        const { ids } = reference(s);
        const atCap = ids.length >= MIRROR_SEARCH_MATCH_CAP;
        const oneCodeOthers = s.groups.filter((g) => g.length === 1).length - 1;
        for (const offset of atCap ? [0, 10_000] : [0, 10]) {
          let page: string[] = [];
          const probing = preparedBy(() => {
            page = store.search(optionsFor(s, offset)).papers.map((p) => p.id);
          }).filter((sql) => /paper_categories pc\b/.test(sql));
          expect(page).toEqual(ids.slice(offset, offset + 10));
          // The capped count and the page.
          expect(probing.length).toBeGreaterThanOrEqual(2);
          for (const sql of probing) {
            const plan = planOf(dbPath, sql);
            // One read of the driver per arm: the count and an under-cap page
            // read it once, a page at the cap once per driver code.
            const arms = plan.filter((l) => /^SEARCH d USING /.test(l)).length;
            expect(arms, plan.join('\n')).toBeGreaterThan(0);
            // Each arm probes cs with one seek by paper, and each one-code group
            // with one seek on its primary-key entry: nothing else.
            expect(
              plan
                .filter((l) => /^SEARCH pc /.test(l))
                .map(seekOf)
                .sort(),
              plan.join('\n'),
            ).toEqual(
              [
                ...Array(arms).fill(PAPER_SEEK),
                ...Array(arms * oneCodeOthers).fill(PK_SEEK),
              ].sort(),
            );
          }
        }
      },
    );

    it('reads an under-cap page in update order with no window from the index holding updated', () => {
      const s = SHAPES.find((x) => x.label === 'two groups meeting under the cap') as Shape;
      const { ids } = reference(s);
      expect(ids.length).toBeLessThan(MIRROR_SEARCH_MATCH_CAP);
      let papers: string[] = [];
      const pageSql = preparedBy(() => {
        papers = store.search(optionsFor(s, 10)).papers.map((p) => p.id);
      }).find((sql) => /ORDER BY/.test(sql) && !isPageFetch(sql));
      expect(papers).toEqual(ids.slice(10, 20));
      expect(planOf(dbPath, pageSql ?? '')).toContain(
        'SEARCH d USING COVERING INDEX paper_categories_cat_updated_idx (category=?)',
      );
    });
  });
});

// Issue #55 — the server's connection is query-only: it never creates,
// seeds, or migrates the file, and a file it cannot serve reads as not ready.
describe('MirrorStore.openReader (#55)', () => {
  let dir: string;
  let dbPath: string;

  /** A current-schema mirror holding one paper and a completed harvest. */
  async function seedCurrent(): Promise<void> {
    const writer = await MirrorStore.open(dbPath);
    writer.applyBatch([mkRecord({ paper_id: '2401.00001', title: 'Protein folding' })], []);
    writer.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-01T00:00:00.000Z',
      total_records: 1,
    });
    writer.close();
  }

  const searchIds = (store: MirrorStore): string[] =>
    store
      .search({
        matchExpr: '"protein"',
        limit: 10,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      })
      .papers.map((p) => p.id);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-reader-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves a current-schema file at once while another connection holds the write lock', async () => {
    await seedCurrent();
    const lock = holdWriteLock(dbPath);
    try {
      const started = performance.now();
      const opened = await MirrorStore.openReader(dbPath);
      const elapsedMs = performance.now() - started;

      expect(opened.status).toBe('open');
      if (opened.status !== 'open') return;
      expect(searchIds(opened.store)).toEqual(['2401.00001']);
      expect(opened.store.readHarvestState().completed_at).toBe('2024-02-01T00:00:00.000Z');
      expect(elapsedMs).toBeLessThan(1_000);
      opened.store.close();
    } finally {
      lock.release();
    }
  });

  it('refuses every write on its connection with SQLITE_READONLY', async () => {
    await seedCurrent();
    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    const { store } = opened;

    expect(sqliteCode(() => store.writeHarvestState({ status: 'error' }))).toBe('SQLITE_READONLY');
    expect(sqliteCode(() => store.applyBatch([mkRecord({ paper_id: '2401.00002' })], []))).toBe(
      'SQLITE_READONLY',
    );
    expect(store.readHarvestState().status).toBe('complete');
    expect(store.countPapers()).toBe(1);
    store.close();
  });

  it('leaves a missing harvest_state row missing rather than seeding it', async () => {
    await seedCurrent();
    const raw = new Database(dbPath);
    raw.run('DELETE FROM harvest_state');
    raw.close();

    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    expect(opened.store.readHarvestState()).toEqual({ status: 'pending' });
    opened.store.close();

    const check = new Database(dbPath, { readonly: true });
    expect(check.query('SELECT COUNT(*) AS n FROM harvest_state').get()).toEqual({ n: 0 });
    check.close();
  });

  it('reads a missing file as not ready and creates neither it nor its directory', async () => {
    const absentPath = join(dir, 'absent', 'mirror.db');

    expect(await MirrorStore.openReader(absentPath)).toEqual({ status: 'missing_file' });
    expect(existsSync(join(dir, 'absent'))).toBe(false);
  });

  it('reads a file with no mirror schema as not ready and leaves it untouched', async () => {
    await writeFile(dbPath, '');
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'missing_schema' });
    expect(statSync(dbPath).size).toBe(0);

    // A writer creating the file records its version last: no row yet is no schema yet.
    const raw = new Database(dbPath);
    raw.run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    raw.close();
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'missing_schema' });
    expect(tableNames(dbPath)).toEqual(['schema_version']);
  });

  it('releases the file on a not-ready open and on a failed one', async () => {
    await writeFile(dbPath, '');
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'missing_schema' });
    expect(fdsOpenOn(dbPath)).toBe(0);

    const brokenPath = join(dir, 'not-a-database.db');
    await writeFile(brokenPath, 'x'.repeat(4096));
    await expect(MirrorStore.openReader(brokenPath)).rejects.toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
    });
    expect(fdsOpenOn(brokenPath)).toBe(0);
  });
});

describe('isDriverError (#76)', () => {
  const raised = (() => {
    const db = new Database(':memory:');
    try {
      db.query('SELECT * FROM missing_table').all();
    } catch (err) {
      return err;
    } finally {
      db.close();
    }
    throw new Error('the driver accepted a query on a missing table');
  })();

  it('takes an error bun:sqlite raised, here or rebuilt from the reader worker’s reply', () => {
    expect(isDriverError(raised)).toBe(true);
    expect(isDriverError(fromWireError(structuredClone(toWireError(raised))))).toBe(true);
  });

  it('keys on the driver’s error class, never on the wording', () => {
    expect(isDriverError(new Error('database disk image is malformed'))).toBe(false);
    expect(isDriverError(new McpError(JsonRpcErrorCode.DatabaseError, 'SQLiteError'))).toBe(false);
    expect(isDriverError('SQLiteError: no such table: missing_table')).toBe(false);
    // The reader worker's reply, before `fromWireError` rebuilds it, carries the name but is no error.
    expect(isDriverError(structuredClone(toWireError(raised)))).toBe(false);
  });
});

// The suite runs on Bun, so the store's better-sqlite3 driver, the one a server
// started with `node` uses, runs only here: the store bundled for Node and
// driven by a `node` child, which reports what each open did.
describe('MirrorStore under Node (better-sqlite3)', () => {
  const STORE_SOURCE = fileURLToPath(
    new URL('../../../../src/services/arxiv/mirror/store.ts', import.meta.url),
  );
  // Inside the project's node_modules, so the bundle's package imports resolve.
  const CACHE_ROOT = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));

  /**
   * The first `node` on PATH that is Node.js. `bun run` puts a `node` that runs
   * Bun first on the PATH of the scripts it starts, this suite included, and
   * that shim is shared by every Bun install of the same revision, so it can
   * point at a Bun other than the one running this suite: each candidate is
   * asked which runtime it is.
   */
  function realNode(): string {
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(entry, 'node');
      if (!existsSync(candidate)) continue;
      const probe = spawnSync(candidate, ['-p', 'process.versions.bun ?? process.release.name'], {
        encoding: 'utf8',
      });
      if (probe.status === 0 && probe.stdout.trim() === 'node') return candidate;
    }
    throw new Error('No Node.js on PATH: the better-sqlite3 tests need a `node` binary');
  }

  /** Each scenario's outcome, as the `node` child reports it. */
  interface NodeReport {
    created: { exists: boolean; version: number };
    failedOpens: {
      afterReader: number;
      afterWriter: number;
      control: number;
      reader: { cause?: string; code: number } | null;
      writer: { cause?: string; code: number } | null;
    };
    locked: {
      completedAt?: string;
      ids?: string[];
      status: string;
      write?: string | null;
    };
    overwrittenPage: {
      byCategory: DriverFailure | null;
      byId: DriverFailure | null;
      byTerm: DriverFailure | null;
      opened: string;
      owner: string | null;
    };
    runtime: string;
  }

  /** A store call's error as the `node` child saw it, and whether {@link isDriverError} takes it as the driver's. */
  interface DriverFailure {
    classified: boolean;
    code: string;
    name: string;
  }

  const SCRIPT = `
    import { createRequire } from 'node:module';
    import {
      closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, statSync, writeFileSync,
      writeSync,
    } from 'node:fs';
    import { join } from 'node:path';
    const { isDriverError, MirrorStore } = await import(process.env.STORE_BUNDLE);
    const Database = createRequire(process.env.STORE_BUNDLE)('better-sqlite3');
    const dir = process.env.WORK_DIR;
    const fdsOpenOn = (path) => {
      const { dev, ino } = statSync(path);
      let open = 0;
      for (const entry of readdirSync('/dev/fd')) {
        try {
          const fd = fstatSync(Number(entry));
          if (fd.dev === dev && fd.ino === ino) open += 1;
        } catch {}
      }
      return open;
    };
    const codeOf = (fn) => { try { fn(); return null; } catch (err) { return err.code; } };
    const failure = (promise) =>
      promise.then(() => null, (err) => ({ code: err.code, cause: err.cause?.code }));
    const report = { runtime: process.versions.bun ? 'bun' : process.release.name };

    const path = join(dir, 'new', 'mirror.db');
    const writer = await MirrorStore.open(path);
    writer.applyBatch([{
      paper_id: '2401.00001', identifier: 'oai:arXiv.org:2401.00001', datestamp: '2024-01-22',
      title: 'Protein folding', authors: 'A. Author', abstract: 'X', categories: 'cs.LG',
      versions: [{ version: 'v1', date: '2024-01-22T00:00:00Z' }],
    }], []);
    writer.writeHarvestState({
      status: 'complete', completed_at: '2024-02-01T00:00:00.000Z', total_records: 1,
    });
    report.created = { exists: existsSync(path), version: writer.schemaVersion().current };
    writer.close();

    const holder = new Database(path);
    holder.prepare('BEGIN IMMEDIATE').run();
    const opened = await MirrorStore.openReader(path).catch((err) => ({
      status: 'failed', code: err.code, cause: err.cause?.code,
    }));
    if (opened.status === 'open') {
      const { store } = opened;
      report.locked = {
        status: 'open',
        ids: store.search({
          matchExpr: '"protein"', limit: 10, offset: 0, sortBy: 'relevance', sortOrder: 'descending',
        }).papers.map((p) => p.id),
        completedAt: store.readHarvestState().completed_at,
        write: codeOf(() => store.writeHarvestState({ status: 'error' })),
      };
      store.close();
    } else {
      report.locked = opened;
    }
    holder.prepare('COMMIT').run();
    holder.close();

    const broken = join(dir, 'not-a-database.db');
    writeFileSync(broken, 'x'.repeat(4096));
    const live = new Database(broken);
    const control = fdsOpenOn(broken);
    live.close();
    const writerFailure = await failure(MirrorStore.open(broken));
    const afterWriter = fdsOpenOn(broken);
    const readerFailure = await failure(MirrorStore.openReader(broken));
    report.failedOpens = {
      control, writer: writerFailure, afterWriter, reader: readerFailure,
      afterReader: fdsOpenOn(broken),
    };

    // 16 pages of 0xFF from the papers page holding the marker row, as in #76.
    const overwritten = join(dir, 'overwritten-page.db');
    const seeding = await MirrorStore.open(overwritten);
    const record = (paper_id, abstract, categories, doi) => ({
      paper_id, identifier: 'oai:arXiv.org:' + paper_id, datestamp: '2024-02-15', title: 'Paper',
      authors: 'A. Author', abstract, categories, doi,
      versions: [{ version: 'v1', date: '2024-02-15T00:00:00Z' }],
    });
    seeding.applyBatch([
      ...Array.from({ length: 2000 }, (_, i) =>
        record('2301.' + String(i).padStart(5, '0'), 'filler', 'cs.LG')),
      record('2402.99999', 'zymurgy', 'q-fin.TR', '10.76/overwritten-page-marker'),
    ], []);
    seeding.writeHarvestState({ status: 'complete', completed_at: '2024-02-16T00:00:00.000Z' });
    seeding.close();
    const raw = new Database(overwritten);
    raw.pragma('wal_checkpoint(TRUNCATE)');
    const pageSize = raw.pragma('page_size', { simple: true });
    const bytes = readFileSync(overwritten);
    const page = Math.floor(bytes.indexOf('10.76/overwritten-page-marker') / pageSize) + 1;
    const owner = raw.prepare('SELECT name FROM dbstat WHERE pageno = ?').get(page)?.name ?? null;
    raw.close();
    const offset = (page - 1) * pageSize;
    const length = Math.min(16 * pageSize, bytes.length - offset);
    const fd = openSync(overwritten, 'r+');
    writeSync(fd, Buffer.alloc(length, 0xff), 0, length, offset);
    closeSync(fd);
    const driverFailure = (fn) => {
      try { fn(); return null; } catch (err) {
        return { name: err.name, code: err.code, classified: isDriverError(err) };
      }
    };
    const reading = await MirrorStore.openReader(overwritten);
    const page1 = { limit: 2, offset: 0, sortBy: 'relevance', sortOrder: 'descending' };
    report.overwrittenPage = {
      owner,
      opened: reading.status,
      byId: driverFailure(() => reading.store.getPapersByIds(['2402.99999'])),
      byTerm: driverFailure(() => reading.store.search({ ...page1, matchExpr: '"zymurgy"' })),
      byCategory: driverFailure(() => reading.store.search({ ...page1, categoryGroups: [['q-fin.TR']] })),
    };
    reading.store.close();

    console.log(JSON.stringify(report));
  `;

  let bundleDir: string;
  let workDir: string;
  let report: NodeReport;

  beforeAll(async () => {
    await mkdir(CACHE_ROOT, { recursive: true });
    bundleDir = await mkdtemp(join(CACHE_ROOT, 'arxiv-store-node-'));
    workDir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-node-test-'));
    const built = await Bun.build({
      entrypoints: [STORE_SOURCE],
      outdir: bundleDir,
      target: 'node',
      format: 'esm',
      packages: 'external',
    });
    if (!built.success) throw new AggregateError(built.logs, 'Bundling the store for Node failed');

    const child = spawn(realNode(), ['--input-type=module', '-e', SCRIPT], {
      env: { ...process.env, STORE_BUNDLE: join(bundleDir, 'store.js'), WORK_DIR: workDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const line = stdout.trim().split('\n').at(-1);
    if (code !== 0 || !line) throw new Error(`node exited ${code}: ${stderr}`);
    report = JSON.parse(line) as NodeReport;
    if (report.runtime !== 'node') throw new Error(`the store ran on ${report.runtime}, not Node`);
  }, 30_000);

  afterAll(async () => {
    await rm(bundleDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates a missing file, and its directory, at the current schema', () => {
    expect(report.created).toEqual({ exists: true, version: MIRROR_SCHEMA_VERSION });
  });

  it('serves a current file while another connection holds the write lock, refusing every write', () => {
    expect(report.locked).toEqual({
      status: 'open',
      ids: ['2401.00001'],
      completedAt: '2024-02-01T00:00:00.000Z',
      write: 'SQLITE_READONLY',
    });
  });

  it('releases the file after a failed writer open and a failed reader open', () => {
    expect(report.failedOpens).toEqual({
      control: 1,
      writer: { code: JsonRpcErrorCode.DatabaseError, cause: 'SQLITE_NOTADB' },
      afterWriter: 0,
      reader: { code: JsonRpcErrorCode.DatabaseError, cause: 'SQLITE_NOTADB' },
      afterReader: 0,
    });
  });

  it('raises an overwritten page at query time as an error isDriverError takes as the driver’s (#76)', () => {
    const corrupt = { name: 'SqliteError', code: 'SQLITE_CORRUPT', classified: true };
    expect(report.overwrittenPage).toEqual({
      owner: 'papers',
      opened: 'open',
      byId: corrupt,
      byTerm: corrupt,
      byCategory: corrupt,
    });
  });
});

describe('rawToRow', () => {
  it('uses the latest version date as updated and the earliest as published', () => {
    const row = rawToRow(
      mkRecord({
        versions: [
          { version: 'v1', date: '2024-01-22T00:00:00Z' },
          { version: 'v3', date: '2024-04-10T00:00:00Z' },
          { version: 'v2', date: '2024-02-01T00:00:00Z' },
        ],
      }),
    );
    // normalizeDateToIso always uses toISOString() which includes milliseconds.
    expect(row.published).toBe('2024-01-22T00:00:00.000Z');
    expect(row.updated).toBe('2024-04-10T00:00:00.000Z');
    expect(row.version).toBe('3');
  });

  it('picks the first category token as primary', () => {
    const row = rawToRow(mkRecord({ categories: 'physics.optics cs.LG' }));
    expect(row.primary_category).toBe('physics.optics');
    expect(row.categories).toBe('physics.optics cs.LG');
  });
});
