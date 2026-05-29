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
      categoryFilters: ['cs.CL'],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(clResult.total).toBe(2);
    expect(clResult.papers.map((p) => p.id).sort()).toEqual(['1706.03762', '1811.07991']);

    // stat.ML — only attn (1706.03762).
    const mlResult = store.search({
      categoryFilters: ['stat.ML'],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(mlResult.total).toBe(1);
    expect(mlResult.papers[0]?.id).toBe('1706.03762');

    // Schema version updated to 2.
    store.close();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    const ver = db
      .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
      .get() as { version: number } | undefined;
    db.close();
    expect(ver?.version).toBe(2);
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
      categoryFilters: ['cs.LG'],
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
      categoryFilters: ['cs.LG'],
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
      categoryFilters: ['stat.ML'],
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
      categoryFilters: ['cs.CL', 'cs.LG'],
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
      categoryFilters: ['cs.L'],
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
      categoryFilters: ['cs.LG'],
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
      categoryFilters: ['cs.LG'],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'ascending',
    });
    // cs.LG → cs1 (2024-03-01), cs2 (2024-02-01); ascending → cs2 first
    expect(result.papers.map((p) => p.id)).toEqual(['cs2', 'cs1']);
  });
});
