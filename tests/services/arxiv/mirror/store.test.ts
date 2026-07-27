/**
 * @fileoverview Tests for the MirrorStore — schema migration, batch upsert
 * idempotency, FTS5 round-trip via `search()`, category filter matching, and
 * harvest-state read/write.
 * @module services/arxiv/mirror/store.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MirrorStore, rawToRow } from '@/services/arxiv/mirror/store.js';
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
