/**
 * @fileoverview Tests for the v1→v2 mirror schema migration — date
 * normalization (RFC 2822 → ISO 8601), paper_categories junction population,
 * and migration idempotency. Also covers the v2→v3 index rebuild (issue #37),
 * the v3→v4 junction backfill and date-index rebuild (issue #78), the v4→v5
 * repair of the quote references a pre-v5 harvester stored (issue #88) and its
 * redefinition of the junction's paper_id index (issue #85), the v5→v6
 * conversion of the TeX a pre-v6 harvester stored (issue #89),
 * the one-writer guard on migrating and creating a file (issue #71),
 * sort-order correctness (issue #18), and index-backed category COUNT
 * (issue #19).
 * @module services/arxiv/mirror/migration.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseListRecords } from '@/services/arxiv/mirror/harvester.js';
import {
  MIRROR_PAPER_ID_INDEX,
  MIRROR_PRAGMA_STATEMENTS,
  MIRROR_SCHEMA_STATEMENTS,
  MIRROR_SCHEMA_VERSION,
  MIRROR_V4_STATEMENTS,
  MIRROR_V5_STATEMENTS,
} from '@/services/arxiv/mirror/schema.js';
import { MirrorStore, normalizeDateToIso, rawToRow } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Pattern that matches a valid ISO 8601 UTC timestamp from toISOString(). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// normalizeDateToIso
// ---------------------------------------------------------------------------

describe('normalizeDateToIso', () => {
  it('normalizes RFC 2822 to ISO 8601', () => {
    const result = normalizeDateToIso('Wed, 31 Oct 2018 14:58:30 GMT');
    expect(result).toMatch(ISO_RE);
    expect(result).toBe('2018-10-31T14:58:30.000Z');
  });

  it('normalizes a YYYY-MM-DD datestamp to ISO 8601', () => {
    const result = normalizeDateToIso('2024-01-22');
    expect(result).toMatch(ISO_RE);
    expect(result).toBe('2024-01-22T00:00:00.000Z');
  });

  it('is a fixed point for already-ISO strings', () => {
    const iso = '2024-04-10T12:00:00.000Z';
    expect(normalizeDateToIso(iso)).toBe(iso);
  });

  it('returns the original string when unparseable (guard against corrupt data)', () => {
    const bad = 'not-a-date';
    expect(normalizeDateToIso(bad)).toBe(bad);
  });

  it('returns an empty string unchanged', () => {
    expect(normalizeDateToIso('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// rawToRow — date normalization
// ---------------------------------------------------------------------------

describe('rawToRow — date normalization', () => {
  it('normalizes RFC 2822 version dates to ISO 8601', () => {
    const row = rawToRow(
      mkRecord({
        versions: [
          { version: 'v1', date: 'Fri, 19 Jan 2018 14:58:30 GMT' },
          { version: 'v2', date: 'Wed, 31 Oct 2018 09:22:00 GMT' },
        ],
      }),
    );
    expect(row.published).toBe('2018-01-19T14:58:30.000Z');
    expect(row.updated).toBe('2018-10-31T09:22:00.000Z');
    expect(row.latest_version).toBe(row.updated);
  });

  it('normalizes YYYY-MM-DD datestamp fallback to ISO 8601', () => {
    const row = rawToRow(
      mkRecord({
        versions: [],
        datestamp: '2020-05-12',
      }),
    );
    expect(row.published).toBe('2020-05-12T00:00:00.000Z');
    expect(row.updated).toBe('2020-05-12T00:00:00.000Z');
  });

  it('round-trips already-ISO dates without mutation', () => {
    const row = rawToRow(
      mkRecord({
        versions: [{ version: 'v1', date: '2024-03-15T10:00:00.000Z' }],
      }),
    );
    expect(row.published).toBe('2024-03-15T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

describe('v1→v2 migration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-migration-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Build a v1-schema DB directly using raw SQL — bypassing the v2 store so
   * the fixture faithfully mimics a pre-migration production database.
   */
  async function buildV1Db(): Promise<void> {
    // Open with the current store (which runs v2 DDL) then manually downgrade
    // the data to look like v1: RFC 2822 dates, no junction rows, schema_version = 1.
    const store = await MirrorStore.open(dbPath);
    store.applyBatch(
      [
        mkRecord({
          paper_id: '1811.07991',
          title: 'BERT: Pre-training of Deep Bidirectional Transformers',
          categories: 'cs.CL cs.LG',
          versions: [
            { version: 'v1', date: 'Wed, 31 Oct 2018 14:58:30 GMT' },
            { version: 'v2', date: 'Thu, 24 May 2019 11:00:00 GMT' },
          ],
          datestamp: '2018-10-31',
        }),
        mkRecord({
          paper_id: '1706.03762',
          title: 'Attention Is All You Need',
          categories: 'cs.CL cs.LG stat.ML',
          versions: [
            { version: 'v1', date: 'Mon, 12 Jun 2017 08:00:00 GMT' },
            { version: 'v5', date: 'Wed, 06 Dec 2017 12:00:00 GMT' },
          ],
          datestamp: '2017-06-12',
        }),
      ],
      [],
    );
    store.close();

    // Now overwrite those rows with RFC 2822 dates and drop junction rows to
    // simulate a v1 DB. Also set schema_version = 1.
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      UPDATE papers SET
        published     = 'Wed, 31 Oct 2018 14:58:30 GMT',
        updated       = 'Thu, 24 May 2019 11:00:00 GMT',
        latest_version = 'Thu, 24 May 2019 11:00:00 GMT'
      WHERE id = '1811.07991';
      UPDATE papers SET
        published     = 'Mon, 12 Jun 2017 08:00:00 GMT',
        updated       = 'Wed, 06 Dec 2017 12:00:00 GMT',
        latest_version = 'Wed, 06 Dec 2017 12:00:00 GMT'
      WHERE id = '1706.03762';
      DELETE FROM paper_categories;
      DELETE FROM schema_version;
      INSERT INTO schema_version(version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');
    `);
    db.close();
  }

  it('migrates dates from RFC 2822 to ISO 8601 and populates the junction table', async () => {
    await buildV1Db();

    // Opening with the v2 store triggers the migration.
    const store = await MirrorStore.open(dbPath);

    const rows = store.getPapersByIds(['1811.07991', '1706.03762']);
    const bert = rows.find((r) => r.id === '1811.07991');
    const attn = rows.find((r) => r.id === '1706.03762');

    // Dates are now ISO 8601.
    expect(bert?.published).toBe('2018-10-31T14:58:30.000Z');
    expect(bert?.updated).toBe('2019-05-24T11:00:00.000Z');
    expect(bert?.latest_version).toBe(bert?.updated);
    expect(attn?.published).toBe('2017-06-12T08:00:00.000Z');
    expect(attn?.updated).toBe('2017-12-06T12:00:00.000Z');

    // Junction table is populated — category filter returns correct papers.
    const clResult = store.search({
      categoryGroups: [['cs.CL']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(clResult.total).toBe(2);
    expect(clResult.papers.map((p) => p.id).sort()).toEqual(['1706.03762', '1811.07991']);

    // stat.ML — only attn (1706.03762).
    const mlResult = store.search({
      categoryGroups: [['stat.ML']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(mlResult.total).toBe(1);
    expect(mlResult.papers[0]?.id).toBe('1706.03762');

    // A v1 DB is carried all the way to the current schema in one open.
    expect(store.schemaVersion()).toEqual({
      current: MIRROR_SCHEMA_VERSION,
      expected: MIRROR_SCHEMA_VERSION,
    });
    store.close();
  });

  it('leaves a v1 DB unmigrated when the reader opens it (#55)', async () => {
    await buildV1Db();

    expect(await MirrorStore.openReader(dbPath)).toEqual({
      status: 'older_schema',
      version: 1,
    });

    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    expect(db.query(`SELECT version FROM schema_version`).all()).toEqual([{ version: 1 }]);
    expect(db.query(`SELECT published FROM papers WHERE id = '1811.07991'`).get()).toEqual({
      published: 'Wed, 31 Oct 2018 14:58:30 GMT',
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM paper_categories`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('migration is idempotent — opening a v2 DB again is a no-op', async () => {
    await buildV1Db();

    // First open: migrates.
    const store1 = await MirrorStore.open(dbPath);
    const rows1 = store1.getPapersByIds(['1811.07991']);
    const iso1 = rows1[0]?.published;
    store1.close();

    // Second open: no-op.
    const store2 = await MirrorStore.open(dbPath);
    const rows2 = store2.getPapersByIds(['1811.07991']);
    const iso2 = rows2[0]?.published;
    store2.close();

    expect(iso1).toBe(iso2);
    expect(iso1).toMatch(ISO_RE);
  });

  it('denormalizes updated into the junction and indexes (category, updated, paper_id, published)', async () => {
    await buildV1Db();
    const store = await MirrorStore.open(dbPath);
    store.close();

    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    // Composite index present, leading with (category, updated); v4 widened it (#78).
    const idxCols = db.prepare(`PRAGMA index_info(paper_categories_cat_updated_idx)`).all() as {
      name: string;
    }[];
    expect(idxCols.map((c) => c.name)).toEqual(['category', 'updated', 'paper_id', 'published']);
    // updated is denormalized into the junction as ISO 8601 (mirrors papers.updated).
    const jrow = db
      .prepare(
        `SELECT updated FROM paper_categories WHERE category = 'cs.CL' AND paper_id = '1811.07991'`,
      )
      .get() as { updated: string } | undefined;
    expect(jrow?.updated).toBe('2019-05-24T11:00:00.000Z');
    db.close();
  });

  it('fresh v2 DB has no junction rows until papers are inserted', async () => {
    const store = await MirrorStore.open(dbPath);
    // Empty DB — no papers yet, so category search returns 0.
    const result = store.search({
      categoryGroups: [['cs.LG']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(0);
    expect(result.papers).toEqual([]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// v2 → v3 migration (issue #37) — comment and journal_ref join the FTS index.
// ---------------------------------------------------------------------------

/** The v2 FTS index and its triggers, verbatim, as a pre-migration fixture. */
const V2_FTS_SQL = `
CREATE VIRTUAL TABLE papers_fts USING fts5(
  title,
  authors,
  abstract,
  content='papers',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
);
CREATE TRIGGER papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, authors, abstract)
  VALUES (new.rowid, new.title, new.authors, new.abstract);
END;
CREATE TRIGGER papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract);
END;
CREATE TRIGGER papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract);
  INSERT INTO papers_fts(rowid, title, authors, abstract)
  VALUES (new.rowid, new.title, new.authors, new.abstract);
END;
`;

describe('v2→v3 migration (#37)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-migration-v3-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const V2_RECORDS: ArxivRawRecord[] = [
    mkRecord({
      paper_id: '2101.00001',
      title: 'Sparse Attention at Scale',
      categories: 'cs.LG',
      comments: 'Accepted at ICML 2021, 12 pages',
      journal_ref: 'Nature Physics 17 (2021) 123',
    }),
    mkRecord({
      paper_id: '2101.00002',
      title: 'A paper with no publication metadata',
      categories: 'cs.LG',
    }),
  ];

  /**
   * Build a DB carrying the v2 shape: rows already present, `papers_fts`
   * indexing only title/authors/abstract, v2 triggers, schema_version = 2. The
   * store writes the rows first so `papers` matches a real harvested mirror;
   * the index is then rebuilt from them through the v2 DDL.
   */
  async function buildV2Db(records: ArxivRawRecord[] = V2_RECORDS): Promise<void> {
    const store = await MirrorStore.open(dbPath);
    store.applyBatch(records, []);
    store.close();

    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      DROP TRIGGER papers_ai;
      DROP TRIGGER papers_ad;
      DROP TRIGGER papers_au;
      DROP TABLE papers_fts;
      ${V2_FTS_SQL}
      INSERT INTO papers_fts(rowid, title, authors, abstract)
        SELECT rowid, title, authors, abstract FROM papers;
      DELETE FROM schema_version;
      INSERT INTO schema_version(version, applied_at) VALUES (2, '2025-06-01T00:00:00.000Z');
    `);
    db.close();
  }

  async function ftsColumns(): Promise<string[]> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    const cols = db.prepare(`PRAGMA table_info(papers_fts)`).all() as { name: string }[];
    db.close();
    return cols.map((c) => c.name);
  }

  const idsFor = (store: MirrorStore, matchExpr: string): string[] =>
    store
      .search({ matchExpr, limit: 10, offset: 0, sortBy: 'relevance', sortOrder: 'descending' })
      .papers.map((p) => p.id);

  it('leaves a v2 mirror unable to answer co:/jr: before the upgrade', async () => {
    // The premise of the migration: on the v2 index these columns do not exist,
    // so routing a prefix at them is an error rather than an empty result.
    await buildV2Db();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    expect(() =>
      db.prepare(`SELECT rowid FROM papers_fts WHERE papers_fts MATCH 'comment:"ICML"'`).all(),
    ).toThrow(/no such column: comment/);
    db.close();
  });

  it('rebuilds the index with comment and journal_ref and makes existing rows searchable', async () => {
    await buildV2Db();

    const store = await MirrorStore.open(dbPath);
    expect(store.schemaVersion()).toEqual({
      current: MIRROR_SCHEMA_VERSION,
      expected: MIRROR_SCHEMA_VERSION,
    });
    // Rows harvested under v2 are searchable on the new prefixes without a
    // re-harvest — the index is rebuilt from the content table.
    expect(idsFor(store, 'comment:"ICML"')).toEqual(['2101.00001']);
    expect(idsFor(store, 'journal_ref:"Nature"')).toEqual(['2101.00001']);
    // …and the columns the v2 index already carried still resolve.
    expect(idsFor(store, 'title:"Sparse"')).toEqual(['2101.00001']);
    store.close();

    expect(await ftsColumns()).toEqual(['title', 'authors', 'abstract', 'comment', 'journal_ref']);
  });

  it('leaves a v2 DB unmigrated when the reader opens it, for a writer to upgrade (#55)', async () => {
    await buildV2Db();

    expect(await MirrorStore.openReader(dbPath)).toEqual({
      status: 'older_schema',
      version: 2,
    });
    expect(await ftsColumns()).toEqual(['title', 'authors', 'abstract']);

    // Once a writer has migrated the file, the next reader open serves it.
    (await MirrorStore.open(dbPath)).close();
    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    expect(idsFor(opened.store, 'comment:"ICML"')).toEqual(['2101.00001']);
    opened.store.close();
  });

  it('recreates the sync triggers so post-migration writes keep the index current', async () => {
    // A v2 trigger left in place would enumerate three columns against a
    // five-column index: every subsequent write drifts silently.
    await buildV2Db();
    const store = await MirrorStore.open(dbPath);

    store.applyBatch(
      [
        mkRecord({
          paper_id: '2101.00003',
          title: 'Inserted after the upgrade',
          comments: 'Presented at NeurIPS',
          journal_ref: 'JMLR 24 (2023) 1',
        }),
      ],
      [],
    );
    expect(idsFor(store, 'comment:"NeurIPS"')).toEqual(['2101.00003']);
    expect(idsFor(store, 'journal_ref:"JMLR"')).toEqual(['2101.00003']);

    // Update: the old indexed comment must go, the new one must land.
    store.applyBatch(
      [
        mkRecord({
          paper_id: '2101.00003',
          title: 'Inserted after the upgrade',
          comments: 'Withdrawn by the authors',
        }),
      ],
      [],
    );
    expect(idsFor(store, 'comment:"NeurIPS"')).toEqual([]);
    expect(idsFor(store, 'comment:"Withdrawn"')).toEqual(['2101.00003']);
    expect(idsFor(store, 'journal_ref:"JMLR"')).toEqual([]);

    // Delete: the row leaves the index entirely.
    store.applyBatch([], [{ paper_id: '2101.00003' }]);
    expect(idsFor(store, 'comment:"Withdrawn"')).toEqual([]);

    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  it('is idempotent — a re-run over an already-rebuilt index does not duplicate rows', async () => {
    await buildV2Db();
    const first = await MirrorStore.open(dbPath);
    first.close();

    // Simulate a run killed after the refill but before the version write: the
    // index is fully populated and schema_version is still 2, so the next open
    // repeats the whole migration.
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version(version, applied_at) VALUES (2, '2025-06-01T00:00:00.000Z');
    `);
    db.close();

    const second = await MirrorStore.open(dbPath);
    const result = second.search({
      matchExpr: 'comment:"ICML"',
      limit: 10,
      offset: 0,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(1);
    expect(result.papers.map((p) => p.id)).toEqual(['2101.00001']);
    expect(second.integrityCheck().ok).toBe(true);
    expect(second.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    second.close();
  });

  it('carries a v1 database through both migrations in one open', async () => {
    await buildV2Db();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      UPDATE papers SET published = 'Wed, 31 Oct 2018 14:58:30 GMT',
                        updated   = 'Wed, 31 Oct 2018 14:58:30 GMT';
      DELETE FROM paper_categories;
      DELETE FROM schema_version;
      INSERT INTO schema_version(version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');
    `);
    db.close();

    const store = await MirrorStore.open(dbPath);
    // v2's work: ISO dates and a populated junction table.
    expect(store.getPapersByIds(['2101.00001'])[0]?.published).toBe('2018-10-31T14:58:30.000Z');
    expect(
      store.search({
        categoryGroups: [['cs.LG']],
        limit: 10,
        offset: 0,
        sortBy: 'updated',
        sortOrder: 'descending',
      }).total,
    ).toBe(2);
    // v3's work: the new columns are indexed.
    expect(idsFor(store, 'journal_ref:"Nature"')).toEqual(['2101.00001']);
    expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    store.close();
  });

  it('ends with the paper_id index as the schema defines it from v5 (#50, #85)', async () => {
    await buildV2Db();
    const store = await MirrorStore.open(dbPath);
    expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    expect(store.checkSchemaObjects().map((o) => `${o.name}: ${o.status}`)).toContain(
      'paper_categories_paper_id_idx: ok',
    );
    expect(idsFor(store, 'journal_ref:"Nature"')).toEqual(['2101.00001']);
    store.close();
  });

  it('upgrades an empty mirror without touching harvest state', async () => {
    await buildV2Db([]);
    const store = await MirrorStore.open(dbPath);
    expect(store.countPapers()).toBe(0);
    expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    expect(store.readHarvestState().status).toBe('pending');
    expect(await ftsColumns()).toEqual(['title', 'authors', 'abstract', 'comment', 'journal_ref']);
    store.close();
  });

  // Issue #71 — one writer creates or migrates a file; a second writer that
  // opens meanwhile changes nothing, and readers can tell the two apart.
  describe('one writer at a time (#71)', () => {
    const STORE_MODULE = fileURLToPath(
      new URL('../../../../src/services/arxiv/mirror/store.ts', import.meta.url),
    );
    const LAPSED = '2000-01-01T00:00:00.000Z';

    /** A v2 mirror of `count` papers, written with raw SQL so a large one builds in seconds. */
    async function buildBulkV2Db(count: number): Promise<void> {
      (await MirrorStore.open(dbPath)).close();
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath);
      db.exec(`
        DROP TRIGGER papers_ai;
        DROP TRIGGER papers_ad;
        DROP TRIGGER papers_au;
        DROP TABLE papers_fts;
        ${V2_FTS_SQL}
      `);
      db.run(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
         INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                            categories, published, updated, latest_version)
         SELECT printf('2401.%05d', n), '1', 'Paper ' || n || ' on sparse attention',
                'A. Author', 'Abstract ' || n || ' words words', 'cs.LG', 'cs.LG',
                '2024-01-22T00:00:00.000Z', '2024-01-22T00:00:00.000Z', '2024-01-22T00:00:00.000Z'
         FROM seq`,
        [count],
      );
      db.exec(`
        DELETE FROM schema_version;
        INSERT INTO schema_version(version, applied_at) VALUES (2, '2025-06-01T00:00:00.000Z');
      `);
      db.close();
    }

    /** Record another writer's migration lease, last renewed at `renewedAt`. */
    async function setLease(renewedAt: string): Promise<void> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath);
      db.run(
        `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
         VALUES (1, 'another-writer', 4242, '2026-01-01T00:00:00.000Z', ?)`,
        [renewedAt],
      );
      db.close();
    }

    async function readFile(): Promise<{
      integrity: string;
      leases: { holder: string }[];
      version: number | undefined;
    }> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath);
      let integrity = 'ok';
      try {
        db.run(`INSERT INTO papers_fts(papers_fts, rank) VALUES ('integrity-check', 1)`);
      } catch (err) {
        integrity = String((err as { code?: string }).code ?? err);
      }
      const leases = db.query('SELECT holder FROM migration_lease').all() as { holder: string }[];
      const version = (db.query('SELECT version FROM schema_version').get() as { version: number })
        ?.version;
      db.close();
      return { integrity, leases, version };
    }

    /** Count the v2→v3 batch lines `fn` writes to stdout. */
    async function countRebuildBatches(fn: () => Promise<unknown>): Promise<number> {
      const writes = vi.spyOn(process.stdout, 'write');
      try {
        await fn();
        return writes.mock.calls.filter(([chunk]) => String(chunk).includes('fts rebuild')).length;
      } finally {
        writes.mockRestore();
      }
    }

    /**
     * A writer open of the mirror in its own process. It loads the store, reports
     * ready, and opens on `go()`, so two of them start together.
     */
    function spawnWriter() {
      const child: ChildProcess = spawn(
        process.execPath,
        [
          '-e',
          `const { MirrorStore } = await import(process.env.STORE_MODULE);
           console.log('READY');
           process.stdin.once('data', async () => {
             let result;
             try {
               (await MirrorStore.open(process.env.DB_PATH)).close();
               result = { ok: true };
             } catch (err) {
               result = { ok: false, reason: err.data?.reason, message: err.message };
             }
             console.log('RESULT ' + JSON.stringify(result));
           });`,
        ],
        { env: { ...process.env, STORE_MODULE, DB_PATH: dbPath }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      const ready = new Promise<void>((resolve) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('READY')) resolve();
        });
      });
      const done = new Promise<{
        rebuildBatches: number;
        result: { message?: string; ok: boolean; reason?: string };
      }>((resolve) => {
        child.on('close', () => {
          const resultLine = out.split('\n').find((l) => l.startsWith('RESULT '));
          resolve({
            rebuildBatches: (out.match(/fts rebuild/g) ?? []).length,
            result: resultLine ? JSON.parse(resultLine.slice('RESULT '.length)) : { ok: false },
          });
        });
      });
      return { ready, done, go: () => child.stdin?.end('GO\n') };
    }

    it('lets one of two writers that open an older file at once rebuild the index, never both', async () => {
      await buildBulkV2Db(40_000);
      const writers = [spawnWriter(), spawnWriter()];
      await Promise.all(writers.map((w) => w.ready));
      for (const w of writers) w.go();
      const results = await Promise.all(writers.map((w) => w.done));

      // 40,000 rows in 5,000-row batches: one full rebuild, by one writer.
      expect(results.map((r) => r.rebuildBatches).sort((a, b) => a - b)).toEqual([0, 8]);
      expect(await readFile()).toEqual({
        integrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
      expect(await ftsColumns()).toEqual([
        'title',
        'authors',
        'abstract',
        'comment',
        'journal_ref',
      ]);
      // The other writer either found the migration running and changed nothing,
      // or opened the file once it was done.
      const other = results.find((r) => r.rebuildBatches === 0)?.result;
      expect(other?.ok || other?.reason === 'migration_in_progress').toBe(true);
    }, 60_000);

    it('changes nothing and names the holder when another writer holds a live lease', async () => {
      await buildV2Db();
      await setLease(new Date().toISOString());

      let failure: unknown;
      const batches = await countRebuildBatches(async () => {
        failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);
      });

      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'migration_in_progress', holderPid: 4242, schemaVersion: 2 },
      });
      expect((failure as McpError).message).toMatch(
        new RegExp(
          `from schema v2 to v${MIRROR_SCHEMA_VERSION} by another writer \\(pid 4242, .*changed nothing\\. Run it again once that migration finishes\\.`,
        ),
      );
      expect(batches).toBe(0);
      expect(await ftsColumns()).toEqual(['title', 'authors', 'abstract']);
      expect(await readFile()).toMatchObject({
        leases: [{ holder: 'another-writer' }],
        version: 2,
      });
    });

    it('takes over a lease whose holder stopped renewing it, and migrates the file', async () => {
      await buildV2Db();
      await setLease(LAPSED);

      const store = await MirrorStore.open(dbPath);
      expect(idsFor(store, 'comment:"ICML"')).toEqual(['2101.00001']);
      store.close();
      expect(await readFile()).toEqual({
        integrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
    });

    it('stops a writer whose lease another writer took over, before its next batch', async () => {
      await buildBulkV2Db(12_000);
      // Stands in for a writer that takes the lease over between two of this
      // writer's transactions: the first renewal hands it away.
      const { Database } = await import('bun:sqlite');
      const raw = new Database(dbPath);
      raw.run(`CREATE TRIGGER steal_lease AFTER UPDATE OF renewed_at ON migration_lease BEGIN
        UPDATE migration_lease SET holder = 'another-writer', pid = 4242 WHERE id = 1;
      END`);
      raw.close();

      let failure: unknown;
      const batches = await countRebuildBatches(async () => {
        failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);
      });

      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'migration_lease_lost', holderPid: 4242 },
      });
      expect(batches).toBe(0);
      expect(await readFile()).toMatchObject({
        leases: [{ holder: 'another-writer' }],
        version: 2,
      });

      // Once that writer's lease lapses, the next open migrates the file whole.
      const fix = new Database(dbPath);
      fix.run('DROP TRIGGER steal_lease');
      fix.close();
      await setLease(LAPSED);
      const rebuilt = await countRebuildBatches(async () => {
        (await MirrorStore.open(dbPath)).close();
      });
      expect(rebuilt).toBe(3);
      expect(await readFile()).toEqual({
        integrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
    });

    it('drops its lease when the migration fails for another reason', async () => {
      await buildV2Db();
      const { Database } = await import('bun:sqlite');
      const raw = new Database(dbPath);
      raw.exec(`
        DELETE FROM schema_version;
        INSERT INTO schema_version(version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');
        CREATE TRIGGER fail_backfill BEFORE UPDATE OF published ON papers BEGIN
          SELECT RAISE(ABORT, 'simulated write failure');
        END;
      `);
      raw.close();

      const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

      expect(failure).toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
      expect(String((failure as McpError).cause)).toMatch(/simulated write failure/);
      // No lease left to wait out: the next writer migrates at once.
      expect(await readFile()).toMatchObject({ leases: [], version: 1 });
      const fix = new Database(dbPath);
      fix.run('DROP TRIGGER fail_backfill');
      fix.close();
      (await MirrorStore.open(dbPath)).close();
      expect(await readFile()).toEqual({
        integrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
    });

    it('names the migration, not the lock, when the busy wait runs out on a live lease', async () => {
      await buildV2Db();
      await setLease(new Date().toISOString());
      const { Database } = await import('bun:sqlite');
      const holder = new Database(dbPath);
      holder.run('BEGIN IMMEDIATE');

      const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);
      holder.run('COMMIT');
      holder.close();

      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'migration_in_progress', holderPid: 4242 },
      });
      expect(await readFile()).toMatchObject({ version: 2 });
    }, 15_000);

    it('reads a file a writer is migrating as migrating, and one whose lease lapsed as older', async () => {
      await buildV2Db();
      await setLease(new Date().toISOString());
      expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'migrating', version: 2 });

      await setLease(LAPSED);
      expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'older_schema', version: 2 });
    });

    it('records the current version in the commit that creates a file, never an older one first', async () => {
      // A log of every version the file records, from its first write on.
      const { Database } = await import('bun:sqlite');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE version_log (version INTEGER NOT NULL);
        CREATE TRIGGER log_version AFTER INSERT ON schema_version BEGIN
          INSERT INTO version_log(version) VALUES (new.version);
        END;
      `);
      raw.close();

      (await MirrorStore.open(dbPath)).close();

      const check = new Database(dbPath, { readonly: true });
      expect(check.query('SELECT version FROM version_log').all()).toEqual([
        { version: MIRROR_SCHEMA_VERSION },
      ]);
      check.close();
    });
  });
});

// ---------------------------------------------------------------------------
// v3 → v4 migration (issue #78) — the junction's `published` column and the
// date-order indexes the bounded category- and date-only searches read.
// ---------------------------------------------------------------------------

/** The three v3 date indexes v4 widens, verbatim, as a pre-migration fixture. */
const V3_DATE_INDEX_SQL = [
  'CREATE INDEX papers_published_idx ON papers(published)',
  'CREATE INDEX papers_updated_idx ON papers(updated)',
  'CREATE INDEX paper_categories_cat_updated_idx ON paper_categories(category, updated)',
];

/** The five date-order indexes as v4 defines them, by name. */
const V4_DATE_INDEX_COLUMNS = {
  paper_categories_cat_published_idx: ['category', 'published', 'paper_id'],
  paper_categories_cat_updated_idx: ['category', 'updated', 'paper_id', 'published'],
  papers_published_idx: ['published', 'updated'],
  papers_updated_idx: ['updated', 'published'],
  papers_revised_early_idx: ['published', 'updated'],
};

describe('v3→v4 migration (#78)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-migration-v4-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A v3 mirror of `count` papers, each in three categories: the schema
   * statements v4 left as they were, the v3 date indexes, rows written with raw
   * SQL (so a large file builds in seconds) and junction rows without
   * `published`, as a v3 writer left them, and schema_version 3.
   */
  async function buildV3Db(count: number): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    for (const sql of [
      ...MIRROR_PRAGMA_STATEMENTS,
      ...MIRROR_SCHEMA_STATEMENTS,
      ...V3_DATE_INDEX_SQL,
    ]) {
      db.prepare(sql).run();
    }
    db.prepare(
      `INSERT INTO schema_version(version, applied_at) VALUES (3, '2026-10-09T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                          categories, published, updated, latest_version)
       SELECT printf('2401.%05d', i), '1', 'Paper ' || i, 'A. Author', 'Abstract ' || i, 'cs.LG',
              'cs.LG math.AP stat.ML',
              strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || i || ' hours'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || (i + 24 * (i % 4)) || ' hours'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || (i + 24 * (i % 4)) || ' hours')
       FROM n`,
    ).run(count);
    for (const code of ['cs.LG', 'math.AP', 'stat.ML']) {
      db.prepare(
        `INSERT INTO paper_categories(category, paper_id, updated) SELECT ?, id, updated FROM papers`,
      ).run(code);
    }
    db.close();
  }

  /** Record another writer's migration lease, last renewed at `renewedAt`. */
  async function setLease(renewedAt: string): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.run(
      `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
       VALUES (1, 'another-writer', 4242, '2026-01-01T00:00:00.000Z', ?)`,
      [renewedAt],
    );
    db.close();
  }

  /** What a migration leaves behind, read on a separate connection. */
  async function inspect(path = dbPath): Promise<{
    junctionColumns: string[];
    junctionRows: number;
    leases: string[];
    papers: number;
    unfilled: number;
    version: number | undefined;
  }> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    const junctionColumns = (
      db.query('PRAGMA table_info(paper_categories)').all() as { name: string }[]
    ).map((c) => c.name);
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    const result = {
      junctionColumns,
      junctionRows: count('SELECT COUNT(*) AS n FROM paper_categories'),
      leases: (db.query('SELECT holder FROM migration_lease').all() as { holder: string }[]).map(
        (l) => l.holder,
      ),
      papers: count('SELECT COUNT(*) AS n FROM papers'),
      // Junction rows whose `published` is not their paper's.
      unfilled: junctionColumns.includes('published')
        ? count(
            `SELECT COUNT(*) AS n FROM paper_categories pc
             LEFT JOIN papers p ON p.id = pc.paper_id
             WHERE p.published IS NULL OR pc.published IS NOT p.published`,
          )
        : -1,
      version: (db.query('SELECT version FROM schema_version').get() as { version: number })
        ?.version,
    };
    db.close();
    return result;
  }

  /**
   * The definitions of every column, index, and trigger on `papers` and
   * `paper_categories`, as SQLite reports them, plus the SQL it stores for each.
   */
  async function schemaOf(path: string): Promise<unknown> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    const out: Record<string, unknown> = {};
    for (const table of ['papers', 'paper_categories']) {
      out[`${table} columns`] = db.query(`PRAGMA table_xinfo(${table})`).all();
      const indexes = db
        .query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`,
        )
        .all(table) as { name: string; sql: string | null }[];
      for (const { name, sql } of indexes) {
        out[`${name} sql`] = sql;
        out[`${name} columns`] = db.query(`PRAGMA index_xinfo(${name})`).all();
      }
      out[`${table} triggers`] = db
        .query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
        )
        .all(table);
      out[`${table} sql`] = (
        db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as {
          sql: string;
        }
      ).sql;
    }
    db.close();
    return out;
  }

  async function indexColumns(name: string): Promise<string[]> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.query(`PRAGMA index_info(${name})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    db.close();
    return cols;
  }

  /** Count the v3→v4 backfill batch lines `fn` writes to stdout. */
  async function countBackfillBatches(fn: () => Promise<unknown>): Promise<number> {
    const writes = vi.spyOn(process.stdout, 'write');
    try {
      await fn();
      return writes.mock.calls.filter(([chunk]) => String(chunk).includes('junction published'))
        .length;
    } finally {
      writes.mockRestore();
    }
  }

  it('starts from a v3 file: no junction published column, the v3 date indexes', async () => {
    await buildV3Db(10);
    expect((await inspect()).junctionColumns).toEqual(['category', 'paper_id', 'updated']);
    expect(await indexColumns('paper_categories_cat_updated_idx')).toEqual(['category', 'updated']);
    expect(await indexColumns('papers_published_idx')).toEqual(['published']);
  });

  it('reads a v3 file as not ready — migrating under a live lease, older otherwise — and serves it once a writer migrates it', async () => {
    await buildV3Db(10);
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'older_schema', version: 3 });
    await setLease(new Date().toISOString());
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'migrating', version: 3 });
    await setLease('2000-01-01T00:00:00.000Z');

    (await MirrorStore.open(dbPath)).close();

    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    expect(
      opened.store.search({
        categoryGroups: [['math.AP', 'stat.ML'], ['cs.LG']],
        publishedFrom: '2024-01-01T02:00:00.000Z',
        limit: 3,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
      }),
    ).toMatchObject({
      total: 9,
      totalIsLowerBound: false,
      papers: [{ id: '2401.00002' }, { id: '2401.00003' }, { id: '2401.00004' }],
    });
    opened.store.close();
  });

  it('migrates a populated v3 file in place: every row kept, published backfilled in 5,000-row batches, the date indexes widened', async () => {
    await buildV3Db(4_000);
    const before = await inspect();
    expect(before).toMatchObject({ papers: 4_000, junctionRows: 12_000, version: 3 });

    const batches = await countBackfillBatches(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    expect(batches).toBe(3);
    expect(await inspect()).toEqual({
      junctionColumns: ['category', 'paper_id', 'updated', 'published'],
      junctionRows: 12_000,
      leases: [],
      papers: 4_000,
      unfilled: 0,
      version: MIRROR_SCHEMA_VERSION,
    });
    for (const [name, columns] of Object.entries(V4_DATE_INDEX_COLUMNS)) {
      expect(await indexColumns(name), name).toEqual(columns);
    }
    // The migrated file keeps writing `published` for the rows a harvest adds.
    const store = await MirrorStore.open(dbPath);
    store.applyBatch(
      [
        mkRecord({
          paper_id: '2410.00001',
          categories: 'cs.LG hep-th',
          versions: [{ version: 'v1', date: '2024-10-01T12:00:00Z' }],
        }),
      ],
      [],
    );
    store.close();
    expect(await inspect()).toMatchObject({ junctionRows: 12_002, unfilled: 0 });
  });

  it('ends with the columns and index definitions a fresh file is created with', async () => {
    await buildV3Db(100);
    (await MirrorStore.open(dbPath)).close();
    const freshPath = join(dir, 'fresh.db');
    (await MirrorStore.open(freshPath)).close();

    const fresh = await schemaOf(freshPath);
    expect(await schemaOf(dbPath)).toEqual(fresh);
    expect(fresh).toHaveProperty('paper_categories_cat_published_idx columns');
    expect(fresh).toHaveProperty(['paper_categories triggers', 0, 'name']);
  });

  it('leaves each index and the fill trigger as the schema check expects them', async () => {
    await buildV3Db(100);
    const store = await MirrorStore.open(dbPath);
    const checked = store.checkSchemaObjects();
    store.close();

    expect(checked.map((o) => `${o.type} ${o.name}: ${o.status}`)).toEqual([
      'index paper_categories_cat_published_idx: ok',
      'index paper_categories_cat_updated_idx: ok',
      'index papers_published_idx: ok',
      'index papers_updated_idx: ok',
      'index papers_revised_early_idx: ok',
      'index paper_categories_paper_id_idx: ok',
      'trigger paper_categories_published_fill: ok',
    ]);
  });

  /**
   * Write `id` as the v3 writer of 1.7.0 does — its own `applyBatch` statements,
   * verbatim — to a file that is already v4, as after an image rollback: the
   * paper upserts, then its junction rows name no `published`.
   */
  async function writeAsV3Writer(path: string, id: string, instant: string): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO papers(id, version, title, authors, abstract,
                            primary_category, categories, published, updated,
                            latest_version, comment, journal_ref, doi)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           title = excluded.title,
           authors = excluded.authors,
           abstract = excluded.abstract,
           primary_category = excluded.primary_category,
           categories = excluded.categories,
           published = excluded.published,
           updated = excluded.updated,
           latest_version = excluded.latest_version,
           comment = excluded.comment,
           journal_ref = excluded.journal_ref,
           doi = excluded.doi`,
      ).run(
        id,
        '1',
        'T',
        'A',
        'X',
        'cs.LG',
        'cs.LG cs.AI',
        instant,
        instant,
        instant,
        null,
        null,
        null,
      );
      db.prepare(`DELETE FROM paper_categories WHERE paper_id = ?`).run(id);
      for (const code of ['cs.LG', 'cs.AI']) {
        db.prepare(
          `INSERT OR IGNORE INTO paper_categories(category, paper_id, updated) VALUES (?, ?, ?)`,
        ).run(code, id, instant);
      }
    })();
    db.close();
  }

  it.each([
    ['created at v4', false],
    ['migrated from v3', true],
  ])(
    'fills published for a junction row a v3 writer adds to a file %s',
    async (_label, migrated) => {
      if (migrated) await buildV3Db(10);
      (await MirrorStore.open(dbPath)).close();

      await writeAsV3Writer(dbPath, '2410.00001', '2024-10-01T12:00:00.000Z');
      // A paper the v3 writer rewrites keeps its rows filled, too.
      await writeAsV3Writer(dbPath, '2410.00001', '2024-10-02T12:00:00.000Z');
      await writeAsV3Writer(dbPath, '2410.00002', '2024-10-03T12:00:00.000Z');

      expect(await inspect()).toMatchObject({ unfilled: 0, version: MIRROR_SCHEMA_VERSION });
      const opened = await MirrorStore.openReader(dbPath);
      if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
      const page = opened.store.search({
        categoryGroups: [['cs.LG', 'cs.AI']],
        publishedFrom: '2024-09-01T00:00:00.000Z',
        limit: 5,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'descending',
      });
      opened.store.close();
      expect(page).toMatchObject({
        total: 2,
        papers: [{ id: '2410.00002' }, { id: '2410.00001', published: '2024-10-02T12:00:00.000Z' }],
      });
    },
  );

  it('changes nothing and names the holder when another writer holds a live lease', async () => {
    await buildV3Db(10);
    await setLease(new Date().toISOString());

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_in_progress', holderPid: 4242, schemaVersion: 3 },
    });
    expect((failure as McpError).message).toContain(
      `from schema v3 to v${MIRROR_SCHEMA_VERSION} by another writer`,
    );
    expect(await inspect()).toMatchObject({
      junctionColumns: ['category', 'paper_id', 'updated'],
      leases: ['another-writer'],
      version: 3,
    });
    expect(await indexColumns('papers_updated_idx')).toEqual(['updated']);
  });

  it('stops a writer whose lease another writer took over, and the next writer finishes the step from the start', async () => {
    await buildV3Db(6_000);
    // The first renewal — the commit of the step's first transaction — hands the lease away.
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER steal_lease AFTER UPDATE OF renewed_at ON migration_lease BEGIN
      UPDATE migration_lease SET holder = 'another-writer', pid = 4242 WHERE id = 1;
    END`);
    raw.close();

    let failure: unknown;
    const batches = await countBackfillBatches(async () => {
      failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);
    });

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_lease_lost', holderPid: 4242 },
    });
    expect(batches).toBe(0);
    // The column the first transaction added stays; nothing after it ran.
    expect(await inspect()).toMatchObject({
      junctionColumns: ['category', 'paper_id', 'updated', 'published'],
      leases: ['another-writer'],
      version: 3,
    });

    const fix = new Database(dbPath);
    fix.run('DROP TRIGGER steal_lease');
    fix.close();
    await setLease('2000-01-01T00:00:00.000Z');
    const resumed = await countBackfillBatches(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    // 18,000 junction rows in 5,000-row batches.
    expect(resumed).toBe(4);
    expect(await inspect()).toMatchObject({
      junctionRows: 18_000,
      leases: [],
      unfilled: 0,
      version: MIRROR_SCHEMA_VERSION,
    });
    for (const [name, columns] of Object.entries(V4_DATE_INDEX_COLUMNS)) {
      expect(await indexColumns(name), name).toEqual(columns);
    }
  });

  it('backfills published for the junction rows a v1 file gains on its way to v4', async () => {
    await buildV3Db(10);
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      UPDATE papers SET published = 'Wed, 31 Oct 2018 14:58:30 GMT';
      DELETE FROM paper_categories;
      DELETE FROM schema_version;
      INSERT INTO schema_version(version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');
    `);
    raw.close();

    (await MirrorStore.open(dbPath)).close();

    expect(await inspect()).toMatchObject({
      junctionRows: 30,
      unfilled: 0,
      version: MIRROR_SCHEMA_VERSION,
    });
  });

  it('records v4 before the next step runs, so an upgrade interrupted after it resumes there', async () => {
    await buildV3Db(6_000);
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      UPDATE papers SET title = 'Agents&#39; interactions' WHERE id = '2401.00001';
      CREATE TRIGGER fail_repair BEFORE UPDATE OF title ON papers BEGIN
        SELECT RAISE(ABORT, 'simulated repair failure');
      END;
    `);
    raw.close();

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    expect(String((failure as McpError).cause)).toMatch(/simulated repair failure/);
    expect(await inspect()).toMatchObject({ leases: [], unfilled: 0, version: 4 });

    const fix = new Database(dbPath);
    fix.run('DROP TRIGGER fail_repair');
    fix.close();
    const backfillsOnResume = await countBackfillBatches(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    expect(backfillsOnResume).toBe(0);
    expect(await inspect()).toMatchObject({
      leases: [],
      unfilled: 0,
      version: MIRROR_SCHEMA_VERSION,
    });
    const check = new Database(dbPath, { readonly: true });
    expect(check.query(`SELECT title FROM papers WHERE id = '2401.00001'`).get()).toEqual({
      title: "Agents' interactions",
    });
    check.close();
  });
});

// ---------------------------------------------------------------------------
// v4 → v5 migration (issue #88) — the quote references the pre-fix harvester
// stored undecoded, repaired in place.
// ---------------------------------------------------------------------------

describe('v4→v5 migration (#88, #85)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-migration-v5-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The six text columns the repair rewrites. */
  const TEXT_COLUMNS = ['title', 'authors', 'abstract', 'comment', 'journal_ref', 'doi'] as const;

  type Row = Record<string, string | number | null>;

  /**
   * Whether paper `i` holds a quote reference, as {@link buildV4Db} writes them:
   * the title of every 3rd paper, the abstract of every 5th, the comment of
   * every 7th, the authors of every 11th, the journal ref of every 13th, the
   * DOI of every 17th. Every 4th abstract also carries references from arXiv's
   * own text, which stay.
   */
  const holdsQuote = (i: number) => [3, 5, 7, 11, 13, 17].some((d) => i % d === 0);

  /**
   * A v4 mirror of `count` papers as the pre-fix harvester wrote them, through
   * the live FTS triggers: the v4 schema statements, junction rows for two
   * codes each, and schema_version 4.
   */
  async function buildV4Db(count: number): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    for (const sql of [
      ...MIRROR_PRAGMA_STATEMENTS,
      ...MIRROR_SCHEMA_STATEMENTS,
      ...MIRROR_V4_STATEMENTS,
    ]) {
      db.prepare(sql).run();
    }
    db.prepare(
      `INSERT INTO schema_version(version, applied_at) VALUES (4, '2026-10-20T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO papers(id, version, title, authors, abstract, primary_category, categories,
                          published, updated, latest_version, comment, journal_ref, doi)
       SELECT printf('2401.%05d', i), '1',
              'Paper ' || i || CASE WHEN i % 3 = 0 THEN ' on why we don&#39;t stop' ELSE '' END,
              CASE WHEN i % 11 = 0 THEN 'J. O&#39;Neil, A. Author' ELSE 'A. Author' END,
              'Abstract ' || i
                || CASE WHEN i % 5 = 0 THEN ' on &#34;quoted&#34; claims' ELSE '' END
                || CASE WHEN i % 4 = 0 THEN ' with &#8722;1 &amp; &lt;x&gt;' ELSE '' END,
              'cs.LG', 'cs.LG math.AP',
              '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z',
              CASE WHEN i % 7 = 0 THEN 'ICGA&#39;97' WHEN i % 2 = 0 THEN '12 pages' END,
              CASE WHEN i % 13 = 0 THEN 'Proc. &#34;X&#34; 3 (1999)' END,
              CASE WHEN i % 17 = 0 THEN '10.1/a&#34;b' END
       FROM n`,
    ).run(count);
    for (const code of ['cs.LG', 'math.AP']) {
      db.prepare(
        `INSERT INTO paper_categories(category, paper_id, updated, published)
         SELECT ?, id, updated, published FROM papers`,
      ).run(code);
    }
    db.close();
  }

  /** Every `papers` row in rowid order, and every junction row, read on a separate connection. */
  async function rows(): Promise<{ junction: Row[]; papers: Row[] }> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const result = {
      papers: db.query('SELECT rowid, * FROM papers ORDER BY rowid').all() as Row[],
      junction: db.query('SELECT rowid, * FROM paper_categories ORDER BY rowid').all() as Row[],
    };
    db.close();
    return result;
  }

  /** `row` with the two quote references decoded in the six text columns. */
  const repaired = (row: Row): Row => {
    const out = { ...row };
    for (const c of TEXT_COLUMNS) {
      const v = out[c];
      if (typeof v === 'string') out[c] = v.replaceAll('&#39;', "'").replaceAll('&#34;', '"');
    }
    return out;
  };

  async function fileState(): Promise<{
    ftsIntegrity: string;
    leases: string[];
    version: number | undefined;
  }> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    let ftsIntegrity = 'ok';
    try {
      db.run(`INSERT INTO papers_fts(papers_fts, rank) VALUES ('integrity-check', 1)`);
    } catch (err) {
      ftsIntegrity = String((err as { code?: string }).code ?? err);
    }
    const leases = (
      db.query('SELECT holder FROM migration_lease').all() as { holder: string }[]
    ).map((l) => l.holder);
    const version = (db.query('SELECT version FROM schema_version').get() as { version: number })
      ?.version;
    db.close();
    return { ftsIntegrity, leases, version };
  }

  /** Papers whose FTS row matches `matchExpr`, counted on a query-only connection. */
  async function ftsCount(matchExpr: string): Promise<number> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const n = (
      db.query('SELECT COUNT(*) AS n FROM papers_fts WHERE papers_fts MATCH ?').get(matchExpr) as {
        n: number;
      }
    ).n;
    db.close();
    return n;
  }

  /** Record another writer's migration lease, last renewed at `renewedAt`. */
  async function setLease(renewedAt: string): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.run(
      `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
       VALUES (1, 'another-writer', 4242, '2026-01-01T00:00:00.000Z', ?)`,
      [renewedAt],
    );
    db.close();
  }

  /** Run `fn`, returning the repair's progress lines it wrote to stdout. */
  async function repairLines(fn: () => Promise<unknown>): Promise<string[]> {
    const writes = vi.spyOn(process.stdout, 'write');
    try {
      await fn();
      return writes.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('quote references'));
    } finally {
      writes.mockRestore();
    }
  }

  const PAPERS = 12_000;
  /** How many of papers 1..12,000 hold a quote reference. */
  const QUOTED = Array.from({ length: PAPERS }, (_, k) => k + 1).filter(holdsQuote).length;

  it('repairs every quote reference in place, one 5,000-row batch at a time, and leaves every other byte as it was', async () => {
    await buildV4Db(PAPERS);
    const before = await rows();
    expect(QUOTED).toBe(7_668);
    expect(await ftsCount('title:"don\'t"')).toBe(0);
    expect(await ftsCount('title:39')).toBe(4_000);

    const lines = await repairLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    expect(lines).toEqual([
      'mirror migration v4→v5 (quote references): 5000/12000 rows, 3197 repaired\n',
      'mirror migration v4→v5 (quote references): 10000/12000 rows, 6391 repaired\n',
      'mirror migration v4→v5 (quote references): 12000/12000 rows, 7668 repaired\n',
    ]);
    const after = await rows();
    expect(after.papers).toEqual(before.papers.map(repaired));
    // The repair touched exactly the rows that held a quote reference.
    const changed = after.papers.filter(
      (row, k) => JSON.stringify(row) !== JSON.stringify(before.papers[k]),
    );
    expect(changed).toHaveLength(QUOTED);
    expect(after.junction).toEqual(before.junction);
    const text = JSON.stringify(after.papers);
    expect(text).not.toMatch(/&#3[49];/);
    // arXiv's own references stay as the source text carries them.
    expect(
      after.papers.filter((r) => String(r.abstract).includes('&#8722;1 &amp; &lt;x&gt;')),
    ).toHaveLength(3_000);
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });

    expect(await ftsCount('title:"don\'t"')).toBe(4_000);
    // The token now stands only for itself: paper 39's title.
    expect(await ftsCount('title:39')).toBe(1);
    expect(await ftsCount('comment:"ICGA\'97"')).toBe(1_714);
    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    expect(
      opened.store.search({
        matchExpr: 'title:"don\'t"',
        limit: 1,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
      }),
    ).toMatchObject({
      total: 4_000,
      papers: [{ id: '2401.00003', title: "Paper 3 on why we don't stop" }],
    });
    opened.store.close();
  });

  it('runs no repair on a file it creates', async () => {
    const lines = await repairLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });
    expect(lines).toEqual([]);
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });
  });

  it('resumes an interrupted repair, leaving the rows it already repaired untouched', async () => {
    await buildV4Db(PAPERS);
    const before = await rows();
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER fail_repair BEFORE UPDATE ON papers WHEN old.rowid > 5000 BEGIN
      SELECT RAISE(ABORT, 'simulated repair failure');
    END`);
    raw.close();

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    expect(String((failure as McpError).cause)).toMatch(/simulated repair failure/);
    expect(await fileState()).toMatchObject({ leases: [], version: 4 });
    const partial = (await rows()).papers;
    expect(partial.slice(0, 5_000)).toEqual(before.papers.slice(0, 5_000).map(repaired));
    expect(partial.slice(5_000)).toEqual(before.papers.slice(5_000));

    const fix = new Database(dbPath);
    fix.exec(`
      DROP TRIGGER fail_repair;
      CREATE TABLE update_log (row INTEGER NOT NULL);
      CREATE TRIGGER log_update AFTER UPDATE ON papers BEGIN
        INSERT INTO update_log(row) VALUES (old.rowid);
      END;
    `);
    fix.close();
    (await MirrorStore.open(dbPath)).close();

    const log = new Database(dbPath, { readonly: true });
    const updated = (
      log.query('SELECT row FROM update_log ORDER BY row').all() as { row: number }[]
    ).map((r) => r.row);
    log.close();
    const quotedPastFirstBatch = Array.from({ length: PAPERS - 5_000 }, (_, k) => k + 5_001).filter(
      holdsQuote,
    );
    expect(quotedPastFirstBatch).toHaveLength(4_471);
    expect(updated).toEqual(quotedPastFirstBatch);
    expect((await rows()).papers).toEqual(before.papers.map(repaired));
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });

    // A file that reached v5 runs no repair again.
    const rerun = await repairLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });
    expect(rerun).toEqual([]);
  });

  it('changes nothing and names the holder when another writer holds a live lease', async () => {
    await buildV4Db(10);
    const before = await rows();
    await setLease(new Date().toISOString());
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'migrating', version: 4 });

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_in_progress', holderPid: 4242, schemaVersion: 4 },
    });
    expect((failure as McpError).message).toContain(
      `from schema v4 to v${MIRROR_SCHEMA_VERSION} by another writer`,
    );
    expect(await rows()).toEqual(before);
    expect(await fileState()).toMatchObject({ leases: ['another-writer'], version: 4 });
  });

  it('fences each batch: a writer whose lease another writer took over stops after the batch that lost it', async () => {
    await buildV4Db(PAPERS);
    const before = await rows();
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER steal_lease AFTER UPDATE OF renewed_at ON migration_lease BEGIN
      UPDATE migration_lease SET holder = 'another-writer', pid = 4242 WHERE id = 1;
    END`);
    raw.close();

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_lease_lost', holderPid: 4242 },
    });
    const partial = (await rows()).papers;
    expect(partial.slice(0, 5_000)).toEqual(before.papers.slice(0, 5_000).map(repaired));
    expect(partial.slice(5_000)).toEqual(before.papers.slice(5_000));
    expect(await fileState()).toMatchObject({ leases: ['another-writer'], version: 4 });
  });

  it('keeps a query-only connection answering between batches', async () => {
    await buildV4Db(PAPERS);
    const { Database } = await import('bun:sqlite');
    const reader = new Database(dbPath, { readonly: true });
    reader.run('PRAGMA busy_timeout = 0');
    reader.run('PRAGMA query_only = ON');
    const phrase = reader.prepare('SELECT COUNT(*) AS n FROM papers_fts WHERE papers_fts MATCH ?');
    const point = reader.prepare('SELECT title FROM papers WHERE id = ?');
    const seen: { dont: number; title: string }[] = [];

    const writes = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (String(chunk).includes('quote references')) {
        seen.push({
          dont: (phrase.get('title:"don\'t"') as { n: number }).n,
          title: (point.get('2401.09999') as { title: string }).title,
        });
      }
      return true;
    });
    try {
      (await MirrorStore.open(dbPath)).close();
    } finally {
      writes.mockRestore();
      reader.close();
    }

    expect(seen).toEqual([
      { dont: 1_666, title: 'Paper 9999 on why we don&#39;t stop' },
      { dont: 3_333, title: "Paper 9999 on why we don't stop" },
      { dont: 4_000, title: "Paper 9999 on why we don't stop" },
    ]);
  });

  // Issue #85 — v5's second part: paper_categories_paper_id_idx, which the
  // harvest runner built as (paper_id) outside the schema version (#50),
  // becomes the schema's (paper_id, category).
  describe('the paper_id index', () => {
    /** What the file holds under the index's name, read on a separate connection. */
    async function paperIdIndex(path = dbPath): Promise<{ columns: string[]; sql?: string }> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(path, { readonly: true });
      const sql = (
        db
          .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get('paper_categories_paper_id_idx') as { sql: string } | null
      )?.sql;
      const columns = (
        db.query('PRAGMA index_info(paper_categories_paper_id_idx)').all() as { name: string }[]
      ).map((c) => c.name);
      db.close();
      return { columns, ...(sql !== undefined && { sql }) };
    }

    /** SQLite's schema cookie, which every CREATE or DROP advances. */
    async function schemaCookie(): Promise<number> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const { schema_version } = db.query('PRAGMA schema_version').get() as {
        schema_version: number;
      };
      db.close();
      return schema_version;
    }

    /** The index as the harvest runner built it before v5. */
    const RUNNER_INDEX =
      'CREATE INDEX IF NOT EXISTS paper_categories_paper_id_idx ON paper_categories(paper_id)';

    async function runOnFile(...statements: string[]): Promise<void> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath);
      for (const sql of statements) db.run(sql);
      db.close();
    }

    /** The v4→v5 progress lines `fn` writes to stdout. */
    async function v5Lines(fn: () => Promise<unknown>): Promise<string[]> {
      const writes = vi.spyOn(process.stdout, 'write');
      try {
        await fn();
        return writes.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes('v4→v5'));
      } finally {
        writes.mockRestore();
      }
    }

    it.each([
      ['a store-created file, which lacks it', []],
      ['a harvested file, which holds the runner’s (paper_id)', [RUNNER_INDEX]],
    ])('defines it on %s as a new file does, after the repair', async (_label, damage) => {
      await buildV4Db(6_000);
      await runOnFile(...damage);
      expect((await paperIdIndex()).columns).toEqual(damage.length === 0 ? [] : ['paper_id']);

      const lines = await v5Lines(async () => {
        (await MirrorStore.open(dbPath)).close();
      });

      // Two repair batches, then the index in one transaction of its own.
      expect(lines.map((l) => l.replace(/:.*/s, ''))).toEqual([
        'mirror migration v4→v5 (quote references)',
        'mirror migration v4→v5 (quote references)',
        'mirror migration v4→v5 (index)',
      ]);
      expect(lines.at(-1)).toBe(`mirror migration v4→v5 (index): ${MIRROR_PAPER_ID_INDEX[1]}\n`);
      const freshPath = join(dir, 'fresh.db');
      (await MirrorStore.open(freshPath)).close();
      expect(await paperIdIndex()).toEqual({
        columns: ['paper_id', 'category'],
        sql: MIRROR_PAPER_ID_INDEX[1],
      });
      expect(await paperIdIndex()).toEqual(await paperIdIndex(freshPath));
      expect(await fileState()).toEqual({
        ftsIntegrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
      const store = await MirrorStore.open(dbPath);
      expect(store.checkSchemaObjects().filter((o) => o.status !== 'ok')).toEqual([]);
      store.close();
      // The junction is unchanged, the write path's lookup by paper_id included.
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      expect(
        (
          db
            .query('EXPLAIN QUERY PLAN DELETE FROM paper_categories WHERE paper_id = ?')
            .all('2401.00001') as { detail: string }[]
        ).map((r) => r.detail),
      ).toEqual(['SEARCH paper_categories USING INDEX paper_categories_paper_id_idx (paper_id=?)']);
      db.close();
    });

    it('rebuilds nothing on a file that already holds the v5 definition', async () => {
      await buildV4Db(10);
      await runOnFile(MIRROR_PAPER_ID_INDEX[1]);
      const before = await schemaCookie();

      const lines = await v5Lines(async () => {
        (await MirrorStore.open(dbPath)).close();
      });

      // The repair ran and the index part found its work done: no DDL ran.
      expect(lines.map((l) => l.replace(/:.*/s, ''))).toEqual([
        'mirror migration v4→v5 (quote references)',
      ]);
      expect(await schemaCookie()).toBe(before);
      expect(await paperIdIndex()).toEqual({
        columns: ['paper_id', 'category'],
        sql: MIRROR_PAPER_ID_INDEX[1],
      });
      expect(await fileState()).toEqual({
        ftsIntegrity: 'ok',
        leases: [],
        version: MIRROR_SCHEMA_VERSION,
      });
    });

    it('leaves the index as it was when the lease is lost before its transaction', async () => {
      // One repair batch: its commit renews the lease, which the trigger hands
      // to another writer before the index part checks it.
      await buildV4Db(4_000);
      await runOnFile(
        RUNNER_INDEX,
        `CREATE TRIGGER steal_lease AFTER UPDATE OF renewed_at ON migration_lease BEGIN
          UPDATE migration_lease SET holder = 'another-writer', pid = 4242 WHERE id = 1;
        END`,
      );

      const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'migration_lease_lost', holderPid: 4242 },
      });
      expect(await paperIdIndex()).toEqual({
        columns: ['paper_id'],
        sql: RUNNER_INDEX.replace('IF NOT EXISTS ', ''),
      });
      expect(await fileState()).toMatchObject({ leases: ['another-writer'], version: 4 });
    });
  });
});

// ---------------------------------------------------------------------------
// v5 → v6 migration (issue #89) — the TeX a pre-v6 harvester stored in the
// text columns, converted to Unicode in place.
// ---------------------------------------------------------------------------

describe('v5→v6 migration (#89)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-migration-v6-test-'));
    dbPath = join(dir, 'mirror.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  type Row = Record<string, string | number | null>;

  /** A v5 file as a pre-v6 writer left it: the schema through v5, schema_version 5, no papers. */
  async function buildV5Schema(): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    for (const sql of [
      ...MIRROR_PRAGMA_STATEMENTS,
      ...MIRROR_SCHEMA_STATEMENTS,
      ...MIRROR_V4_STATEMENTS,
      ...MIRROR_V5_STATEMENTS,
    ]) {
      db.prepare(sql).run();
    }
    db.prepare(
      `INSERT INTO schema_version(version, applied_at) VALUES (5, '2026-10-25T00:00:00.000Z')`,
    ).run();
    db.close();
  }

  /**
   * A v5 mirror of `count` papers with TeX as a pre-v6 harvester stored it,
   * written through the live FTS triggers: the title of every 3rd paper, the
   * authors of every 5th, the abstract of every 7th, the comment of every 11th,
   * and the journal ref of every 13th hold TeX the conversion rewrites. Every
   * 4th abstract holds math it leaves as written, and every 17th DOI a TeX
   * accent, which is not a converted column.
   */
  async function buildV5Db(count: number): Promise<void> {
    await buildV5Schema();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO papers(id, version, title, authors, abstract, primary_category, categories,
                          published, updated, latest_version, comment, journal_ref, doi)
       SELECT printf('2401.%05d', i), '1',
              'Paper ' || i || CASE WHEN i % 3 = 0 THEN ' from Sm{\\o}r-re-br{\\o}d' ELSE '' END,
              CASE WHEN i % 5 = 0 THEN 'O. Barrag\\''an and A. Petralia' ELSE 'A. Author' END,
              'Abstract ' || i
                || CASE WHEN i % 7 = 0 THEN ' at (3300-9700 \\AA)' ELSE '' END
                || CASE WHEN i % 4 = 0 THEN ' over $\\mathbb{R}^3$' ELSE '' END,
              'cs.LG', 'cs.LG math.AP',
              '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z',
              CASE WHEN i % 11 = 0 THEN '\\copyright 2026 IEEE' WHEN i % 2 = 0 THEN '12 pages' END,
              CASE WHEN i % 13 = 0 THEN 'Proc. Vald\\''es 3 (1999)' END,
              CASE WHEN i % 17 = 0 THEN '10.1/a\\''b' END
       FROM n`,
    ).run(count);
    for (const code of ['cs.LG', 'math.AP']) {
      db.prepare(
        `INSERT INTO paper_categories(category, paper_id, updated, published)
         SELECT ?, id, updated, published FROM papers`,
      ).run(code);
    }
    db.close();
  }

  /** Whether paper `i` of {@link buildV5Db} holds TeX the conversion rewrites. */
  const changes = (i: number) => [3, 5, 7, 11, 13].some((d) => i % d === 0);
  const changedUpTo = (n: number) =>
    Array.from({ length: n }, (_, k) => k + 1).filter(changes).length;

  /** `row` as arXiv's conversion leaves it, written out by hand for the five TeX forms. */
  const converted = (row: Row): Row => ({
    ...row,
    title: String(row.title).replace('Sm{\\o}r-re-br{\\o}d', 'Smør-re-brød'),
    authors: String(row.authors).replace("Barrag\\'an", 'Barragán'),
    abstract: String(row.abstract).replace('\\AA', 'Å'),
    comment: row.comment === null ? null : String(row.comment).replace('\\copyright ', '©'),
    journal_ref:
      row.journal_ref === null ? null : String(row.journal_ref).replace("Vald\\'es", 'Valdés'),
  });

  async function rows(): Promise<{ junction: Row[]; papers: Row[] }> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const result = {
      papers: db.query('SELECT rowid, * FROM papers ORDER BY rowid').all() as Row[],
      junction: db.query('SELECT rowid, * FROM paper_categories ORDER BY rowid').all() as Row[],
    };
    db.close();
    return result;
  }

  async function fileState(): Promise<{
    ftsIntegrity: string;
    leases: string[];
    version: number | undefined;
  }> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    let ftsIntegrity = 'ok';
    try {
      db.run(`INSERT INTO papers_fts(papers_fts, rank) VALUES ('integrity-check', 1)`);
    } catch (err) {
      ftsIntegrity = String((err as { code?: string }).code ?? err);
    }
    const leases = (
      db.query('SELECT holder FROM migration_lease').all() as { holder: string }[]
    ).map((l) => l.holder);
    const version = (db.query('SELECT version FROM schema_version').get() as { version: number })
      ?.version;
    db.close();
    return { ftsIntegrity, leases, version };
  }

  async function ftsCount(matchExpr: string): Promise<number> {
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const { n } = db
      .query('SELECT COUNT(*) AS n FROM papers_fts WHERE papers_fts MATCH ?')
      .get(matchExpr) as { n: number };
    db.close();
    return n;
  }

  /** Run `fn`, returning the conversion's progress lines it wrote to stdout. */
  async function conversionLines(fn: () => Promise<unknown>): Promise<string[]> {
    const writes = vi.spyOn(process.stdout, 'write');
    try {
      await fn();
      return writes.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes('v5→v6'));
    } finally {
      writes.mockRestore();
    }
  }

  const PAPERS = 12_000;

  it('converts every row that changes in place, one 5,000-row batch at a time, and leaves every other byte as it was', async () => {
    await buildV5Db(PAPERS);
    const before = await rows();
    expect(changedUpTo(PAPERS)).toBe(7_397);
    expect(await ftsCount('authors:barragan')).toBe(0);
    expect(await ftsCount('title:"Smør-re-brød"')).toBe(0);

    const lines = await conversionLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    expect(lines).toEqual([
      `mirror migration v5→v6 (TeX to Unicode): 5000/12000 rows, ${changedUpTo(5_000)} rewritten\n`,
      `mirror migration v5→v6 (TeX to Unicode): 10000/12000 rows, ${changedUpTo(10_000)} rewritten\n`,
      'mirror migration v5→v6 (TeX to Unicode): 12000/12000 rows, 7397 rewritten\n',
    ]);
    const after = await rows();
    expect(after.papers).toEqual(before.papers.map(converted));
    const rewritten = after.papers.filter(
      (row, k) => JSON.stringify(row) !== JSON.stringify(before.papers[k]),
    );
    expect(rewritten).toHaveLength(7_397);
    expect(after.junction).toEqual(before.junction);
    // Math the conversion leaves, and a DOI it never reads, stay as written.
    expect(after.papers.filter((r) => String(r.abstract).includes('$\\mathbb{R}^3$'))).toHaveLength(
      3_000,
    );
    expect(after.papers.filter((r) => r.doi === "10.1/a\\'b")).toHaveLength(705);
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });

    // The index holds the converted text: diacritic folding meets both spellings.
    expect(await ftsCount('authors:barragan')).toBe(2_400);
    expect(await ftsCount('authors:"Barragán"')).toBe(2_400);
    expect(await ftsCount('title:"Smør-re-brød"')).toBe(4_000);
    expect(await ftsCount('abstract:"3300-9700 Å"')).toBe(1_714);
    const opened = await MirrorStore.openReader(dbPath);
    if (opened.status !== 'open') throw new Error(`expected an open store, got ${opened.status}`);
    expect(
      opened.store.search({
        matchExpr: 'authors:barragan',
        limit: 1,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
      }),
    ).toMatchObject({
      total: 2_400,
      papers: [{ id: '2401.00005', authors: 'O. Barragán and A. Petralia' }],
    });
    opened.store.close();
  });

  it('rewrites each captured arXivRaw row to what the harvest now stores for its record', async () => {
    const fixtures = fileURLToPath(new URL('../../../fixtures/arxiv-metadata/', import.meta.url));
    const records = parseListRecords(
      gunzipSync(readFileSync(join(fixtures, 'oai-arxivraw.xml.gz'))).toString('utf8'),
    ).records;
    expect(records).toHaveLength(174);
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
    await buildV5Schema();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    // The row a pre-v6 harvester stored: whitespace collapsed, TeX as written.
    const insert = db.prepare(
      `INSERT INTO papers(id, version, title, authors, abstract, primary_category, categories,
                          published, updated, latest_version, comment, journal_ref, doi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of records) {
      const row = rawToRow(record);
      insert.run(
        row.id,
        row.version,
        collapse(record.title),
        collapse(record.authors),
        collapse(record.abstract),
        row.primary_category,
        row.categories,
        row.published,
        row.updated,
        row.latest_version,
        record.comments ? collapse(record.comments) : null,
        record.journal_ref ? collapse(record.journal_ref) : null,
        row.doi ?? null,
      );
    }
    db.close();
    const before = await rows();

    const lines = await conversionLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });

    const after = await rows();
    const byId = new Map(records.map((record) => [record.paper_id, rawToRow(record)]));
    let rewritten = 0;
    for (const [k, row] of after.papers.entries()) {
      const expected = byId.get(String(row.id));
      expect(row, String(row.id)).toMatchObject({
        title: expected?.title,
        authors: expected?.authors,
        abstract: expected?.abstract,
        comment: expected?.comment ?? null,
        journal_ref: expected?.journal_ref ?? null,
        doi: expected?.doi ?? null,
      });
      if (JSON.stringify(row) !== JSON.stringify(before.papers[k])) rewritten++;
    }
    expect(rewritten).toBe(88);
    expect(lines).toEqual([
      'mirror migration v5→v6 (TeX to Unicode): 174/174 rows, 88 rewritten\n',
    ]);
    expect(await fileState()).toMatchObject({ ftsIntegrity: 'ok', version: MIRROR_SCHEMA_VERSION });
  });

  it('runs no conversion on a file it creates', async () => {
    const lines = await conversionLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });
    expect(lines).toEqual([]);
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });
  });

  it('resumes an interrupted conversion, rewriting no row it already converted', async () => {
    await buildV5Db(PAPERS);
    const before = await rows();
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER fail_convert BEFORE UPDATE ON papers WHEN old.rowid > 5000 BEGIN
      SELECT RAISE(ABORT, 'simulated conversion failure');
    END`);
    raw.close();

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    expect(String((failure as McpError).cause)).toMatch(/simulated conversion failure/);
    expect(await fileState()).toMatchObject({ leases: [], version: 5 });
    const partial = (await rows()).papers;
    expect(partial.slice(0, 5_000)).toEqual(before.papers.slice(0, 5_000).map(converted));
    expect(partial.slice(5_000)).toEqual(before.papers.slice(5_000));

    const fix = new Database(dbPath);
    fix.exec(`
      DROP TRIGGER fail_convert;
      CREATE TABLE update_log (row INTEGER NOT NULL);
      CREATE TRIGGER log_update AFTER UPDATE ON papers BEGIN
        INSERT INTO update_log(row) VALUES (old.rowid);
      END;
    `);
    fix.close();
    (await MirrorStore.open(dbPath)).close();

    const log = new Database(dbPath, { readonly: true });
    const updated = (
      log.query('SELECT row FROM update_log ORDER BY row').all() as { row: number }[]
    ).map((r) => r.row);
    log.close();
    const changingPastFirstBatch = Array.from(
      { length: PAPERS - 5_000 },
      (_, k) => k + 5_001,
    ).filter(changes);
    expect(changingPastFirstBatch).toHaveLength(4_315);
    expect(updated).toEqual(changingPastFirstBatch);
    expect((await rows()).papers).toEqual(before.papers.map(converted));
    expect(await fileState()).toEqual({
      ftsIntegrity: 'ok',
      leases: [],
      version: MIRROR_SCHEMA_VERSION,
    });

    // A file that reached v6 runs no conversion again.
    const rerun = await conversionLines(async () => {
      (await MirrorStore.open(dbPath)).close();
    });
    expect(rerun).toEqual([]);
  });

  it('changes nothing and names the holder when another writer holds a live lease', async () => {
    await buildV5Db(10);
    const before = await rows();
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(
      `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
       VALUES (1, 'another-writer', 4242, '2026-01-01T00:00:00.000Z', ?)`,
      [new Date().toISOString()],
    );
    raw.close();
    expect(await MirrorStore.openReader(dbPath)).toEqual({ status: 'migrating', version: 5 });

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_in_progress', holderPid: 4242, schemaVersion: 5 },
    });
    expect((failure as McpError).message).toContain('from schema v5 to v6 by another writer');
    expect(await rows()).toEqual(before);
    expect(await fileState()).toMatchObject({ leases: ['another-writer'], version: 5 });
  });

  it('fences each batch: a writer whose lease another writer took over stops after the batch that lost it', async () => {
    await buildV5Db(PAPERS);
    const before = await rows();
    const { Database } = await import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER steal_lease AFTER UPDATE OF renewed_at ON migration_lease BEGIN
      UPDATE migration_lease SET holder = 'another-writer', pid = 4242 WHERE id = 1;
    END`);
    raw.close();

    const failure = await MirrorStore.open(dbPath).catch((err: unknown) => err);

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'migration_lease_lost', holderPid: 4242 },
    });
    const partial = (await rows()).papers;
    expect(partial.slice(0, 5_000)).toEqual(before.papers.slice(0, 5_000).map(converted));
    expect(partial.slice(5_000)).toEqual(before.papers.slice(5_000));
    expect(await fileState()).toMatchObject({ leases: ['another-writer'], version: 5 });
  });
});

// ---------------------------------------------------------------------------
// Sort-order correctness (issue #18)
// ---------------------------------------------------------------------------

describe('sort order correctness after ISO normalization', () => {
  let dir: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-sort-test-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('sort_by:submitted descending returns most-recently published first', () => {
    store.applyBatch(
      [
        mkRecord({
          paper_id: '2017.001',
          title: 'Oldest paper',
          versions: [{ version: 'v1', date: 'Mon, 12 Jun 2017 08:00:00 GMT' }],
        }),
        mkRecord({
          paper_id: '2021.001',
          title: 'Middle paper',
          versions: [{ version: 'v1', date: 'Wed, 14 Jul 2021 10:00:00 GMT' }],
        }),
        mkRecord({
          paper_id: '2024.001',
          title: 'Newest paper',
          versions: [{ version: 'v1', date: 'Fri, 19 Jan 2024 14:00:00 GMT' }],
        }),
      ],
      [],
    );

    const desc = store.search({
      limit: 10,
      offset: 0,
      sortBy: 'published',
      sortOrder: 'descending',
    });
    expect(desc.papers.map((p) => p.id)).toEqual(['2024.001', '2021.001', '2017.001']);

    const asc = store.search({
      limit: 10,
      offset: 0,
      sortBy: 'published',
      sortOrder: 'ascending',
    });
    expect(asc.papers.map((p) => p.id)).toEqual(['2017.001', '2021.001', '2024.001']);
  });

  it('sort_by:updated descending returns most-recently updated first', () => {
    store.applyBatch(
      [
        mkRecord({
          paper_id: '2018.001',
          title: 'Updated 2018',
          versions: [
            { version: 'v1', date: 'Wed, 31 Oct 2018 14:58:30 GMT' },
            { version: 'v2', date: 'Mon, 02 Jan 2023 09:00:00 GMT' },
          ],
        }),
        mkRecord({
          paper_id: '2023.001',
          title: 'Updated 2024',
          versions: [
            { version: 'v1', date: 'Tue, 10 Jan 2023 12:00:00 GMT' },
            { version: 'v2', date: 'Thu, 15 Feb 2024 16:30:00 GMT' },
          ],
        }),
        mkRecord({
          paper_id: '2020.001',
          title: 'Updated 2020',
          versions: [{ version: 'v1', date: 'Fri, 01 May 2020 08:00:00 GMT' }],
        }),
      ],
      [],
    );

    const desc = store.search({
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    // updated order: 2023.001 (2024-02-15) > 2018.001 (2023-01-02) > 2020.001 (2020-05-01)
    expect(desc.papers.map((p) => p.id)).toEqual(['2023.001', '2018.001', '2020.001']);
  });

  it('sort_by:submitted ascending (old-to-new)', () => {
    store.applyBatch(
      [
        mkRecord({
          paper_id: 'p2022',
          versions: [{ version: 'v1', date: 'Tue, 15 Mar 2022 10:00:00 GMT' }],
        }),
        mkRecord({
          paper_id: 'p2019',
          versions: [{ version: 'v1', date: 'Thu, 07 Nov 2019 08:00:00 GMT' }],
        }),
        mkRecord({
          paper_id: 'p2025',
          versions: [{ version: 'v1', date: 'Mon, 10 Feb 2025 14:00:00 GMT' }],
        }),
      ],
      [],
    );

    const asc = store.search({
      limit: 10,
      offset: 0,
      sortBy: 'published',
      sortOrder: 'ascending',
    });
    expect(asc.papers.map((p) => p.id)).toEqual(['p2019', 'p2022', 'p2025']);
  });
});

// ---------------------------------------------------------------------------
// Category query via junction table (issue #19)
// ---------------------------------------------------------------------------

describe('category-only query (issue #19)', () => {
  let dir: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-catquery-test-'));
    store = await MirrorStore.open(join(dir, 'mirror.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const seed = () =>
    store.applyBatch(
      [
        mkRecord({
          paper_id: 'cs1',
          categories: 'cs.CL cs.LG',
          versions: [{ version: 'v1', date: '2024-03-01T00:00:00Z' }],
        }),
        mkRecord({
          paper_id: 'cs2',
          categories: 'cs.LG stat.ML',
          versions: [{ version: 'v1', date: '2024-02-01T00:00:00Z' }],
        }),
        mkRecord({
          paper_id: 'cs3',
          categories: 'cs.AI',
          versions: [{ version: 'v1', date: '2024-01-01T00:00:00Z' }],
        }),
        mkRecord({
          paper_id: 'stat1',
          categories: 'stat.ML',
          versions: [{ version: 'v1', date: '2023-12-01T00:00:00Z' }],
        }),
      ],
      [],
    );

  it('returns exact set for single-category filter (no LIKE heuristic)', () => {
    seed();
    const result = store.search({
      categoryGroups: [['cs.LG']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(2);
    expect(result.papers.map((p) => p.id).sort()).toEqual(['cs1', 'cs2']);
  });

  it('total for category-only query matches paper count', () => {
    seed();
    const result = store.search({
      categoryGroups: [['stat.ML']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(2); // cs2 and stat1
    expect(result.papers.map((p) => p.id).sort()).toEqual(['cs2', 'stat1']);
  });

  it('multi-category OR filter: paper appears once even if it matches both', () => {
    seed();
    const result = store.search({
      categoryGroups: [['cs.CL', 'cs.LG']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    // cs.CL → [cs1]; cs.LG → [cs1, cs2]; union → [cs1, cs2]
    expect(result.total).toBe(2);
    expect(result.papers.map((p) => p.id).sort()).toEqual(['cs1', 'cs2']);
  });

  it('junction table does not partially match category codes (exact match)', () => {
    seed();
    // cs.L should not match cs.LG or cs.CL
    const result = store.search({
      categoryGroups: [['cs.L']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(0);
  });

  it('category-only result is in date-descending order', () => {
    seed();
    const result = store.search({
      categoryGroups: [['cs.LG']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    // cs1 published 2024-03-01, cs2 published 2024-02-01 → cs1 first
    expect(result.papers.map((p) => p.id)).toEqual(['cs1', 'cs2']);
  });

  it('single-category ascending returns oldest-updated first', () => {
    seed();
    const result = store.search({
      categoryGroups: [['cs.LG']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'ascending',
    });
    // cs.LG → cs1 (2024-03-01), cs2 (2024-02-01); ascending → cs2 first
    expect(result.papers.map((p) => p.id)).toEqual(['cs2', 'cs1']);
  });
});
