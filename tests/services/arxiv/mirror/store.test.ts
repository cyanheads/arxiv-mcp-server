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
      categoryFilters: [],
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
      categoryFilters: ['stat.ML'],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(2);
    expect(result.papers.map((p) => p.id).sort()).toEqual(['1', '2']);
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
    expect(row.published).toBe('2024-01-22T00:00:00Z');
    expect(row.updated).toBe('2024-04-10T00:00:00Z');
    expect(row.version).toBe('3');
  });

  it('picks the first category token as primary', () => {
    const row = rawToRow(mkRecord({ categories: 'physics.optics cs.LG' }));
    expect(row.primary_category).toBe('physics.optics');
    expect(row.categories).toBe('physics.optics cs.LG');
  });
});
