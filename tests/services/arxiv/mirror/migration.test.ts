/**
 * @fileoverview Tests for the v1→v2 mirror schema migration — date
 * normalization (RFC 2822 → ISO 8601), paper_categories junction population,
 * and migration idempotency. Also covers sort-order correctness (issue #18)
 * and index-backed category COUNT (issue #19).
 * @module services/arxiv/mirror/migration.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIRROR_SCHEMA_VERSION } from '@/services/arxiv/mirror/schema.js';
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

  it('denormalizes updated into the junction and indexes (category, updated)', async () => {
    await buildV1Db();
    const store = await MirrorStore.open(dbPath);
    store.close();

    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    // Composite index present, in (category, updated) order.
    const idxCols = db.prepare(`PRAGMA index_info(paper_categories_cat_updated_idx)`).all() as {
      name: string;
    }[];
    expect(idxCols.map((c) => c.name)).toEqual(['category', 'updated']);
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

  it('upgrades an empty mirror without touching harvest state', async () => {
    await buildV2Db([]);
    const store = await MirrorStore.open(dbPath);
    expect(store.countPapers()).toBe(0);
    expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
    expect(store.readHarvestState().status).toBe('pending');
    expect(await ftsColumns()).toEqual(['title', 'authors', 'abstract', 'comment', 'journal_ref']);
    store.close();
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
