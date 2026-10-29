/**
 * @fileoverview Tests for the mirror harvest runner — where a run starts
 * (saved resumption token vs. `from=last_datestamp`), what it persists as it
 * goes, the write-path index its lookups by paper_id use (#50, #85), the
 * deadline that stops it after a whole page (#39), which writes keep the token
 * for a later run (#62), the stalled token recovery that fails a run (#59), the
 * outage wait only `init` runs (#61), the run on a file another writer is
 * migrating (#71), `mirror:verify` on a file missing an index or trigger,
 * and the mirror scripts run from an installed package (#75).
 * Drives the real `MirrorStore` on a temp file; only `fetch` (the OAI endpoint)
 * is stubbed, except in the real-process blocks, which run the mirror scripts
 * against a loopback OAI endpoint or, for the installed package, against stub
 * server modules.
 * @module services/arxiv/mirror/runner.test
 */

import { Database } from 'bun:sqlite';
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worstCasePageFetchMs } from '@/services/arxiv/mirror/harvester.js';
import { runHarvest } from '@/services/arxiv/mirror/runner.js';
import { MIRROR_SCHEMA_VERSION } from '@/services/arxiv/mirror/schema.js';
import { MirrorStore, openStore, resetStore } from '@/services/arxiv/mirror/store.js';

const config = {
  apiTimeoutMs: 15_000,
  mirrorPath: '',
  mirrorOaiBaseUrl: 'https://oai.test/oai',
  mirrorOaiRequestDelayMs: 0,
};

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

/** Rejects any call a test has not stubbed; each `mockReset` restores this. */
const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
  throw new Error(`unmocked fetch: ${url}`);
});
vi.stubGlobal('fetch', mockFetch);

/** A request's URL when it goes to the stubbed OAI host; a request to any other host throws. */
function oaiUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.hostname !== 'oai.test') throw new Error(`unmocked fetch: ${url}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// OAI response builders
// ---------------------------------------------------------------------------

const record = (id: string, datestamp: string): string => `
  <record>
    <header><identifier>oai:arXiv.org:${id}</identifier><datestamp>${datestamp}</datestamp></header>
    <metadata><arXivRaw>
      <id>${id}</id><title>Paper ${id}</title><authors>A. Author</authors>
      <categories>cs.LG math.AP</categories><abstract>Abstract of ${id}.</abstract>
      <version version="v1"><date>Mon, 1 Jun 2026 00:00:00 GMT</date></version>
    </arXivRaw></metadata>
  </record>`;

const listRecords = (records: string[], token?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>${records.join('')}${
    token ? `<resumptionToken expirationDate="2026-06-05T00:00:00Z">${token}</resumptionToken>` : ''
  }</ListRecords></OAI-PMH>`;

const BAD_TOKEN = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="badResumptionToken">expired</error></OAI-PMH>`;

/** Requested URLs, in order. */
let requests: URL[];

/** Answer each fetch with the next queued body (status 200 unless given). */
function serve(...bodies: (string | { body: string; status: number })[]): void {
  mockFetch.mockImplementation(async (url, init) => {
    init?.signal?.throwIfAborted();
    requests.push(oaiUrl(url));
    const next = bodies.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    const { body, status } = typeof next === 'string' ? { body: next, status: 200 } : next;
    return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
  });
}

const tokenOf = (u: URL | undefined) => u?.searchParams.get('resumptionToken') ?? null;
const fromOf = (u: URL | undefined) => u?.searchParams.get('from') ?? null;
/** Each request as its token, or its `from` when it sent none. */
const startOf = (u: URL) => tokenOf(u) ?? fromOf(u);

/**
 * An OAI endpoint with arXiv's own `ListRecords` logic (arXiv/oaipmh
 * `processors/db.py`, `fetch_list.py`, `resume.py`): the list for `from=D` is
 * every record modified on or after D, ordered by (modtime, paper_id) and
 * recomputed on every request, and a token is the request's `from` plus an
 * offset `skip`. When a page spans days, the token's `from` moves to the page's
 * last day and `skip` counts that day's records already shown. `modtimes` maps
 * paper IDs to ISO instants. `touch` re-modifies a record, which moves it to
 * the end of the list. `intercept` sees each request first: a Response it
 * returns answers instead, and a signal it aborts fails the fetch.
 */
function serveArxivList(modtimes: Record<string, string>, pageSize = 3) {
  const modified = new Map(Object.entries(modtimes));
  const dayOf = (instant: string) => instant.slice(0, 10);
  const endpoint = {
    intercept: (_url: URL): Response | undefined => undefined,
    touch: (id: string, instant: string) => void modified.set(id, instant),
    /** The IDs of `modtimes` the mirror does not hold. */
    missing: (store: MirrorStore) => {
      const held = new Set(store.getPapersByIds([...modified.keys()]).map((p) => p.id));
      return [...modified.keys()].filter((id) => !held.has(id));
    },
  };
  mockFetch.mockImplementation(async (url, init) => {
    const u = oaiUrl(url);
    requests.push(u);
    const answer = endpoint.intercept(u);
    init?.signal?.throwIfAborted();
    if (answer) return answer;
    const token = new URLSearchParams(tokenOf(u) ?? '');
    const from = tokenOf(u) ? token.get('from') : fromOf(u);
    const skip = Number(token.get('skip') ?? 0);
    const list = [...modified]
      .filter(([, at]) => !from || dayOf(at) >= from)
      .sort(([a, atA], [b, atB]) => atA.localeCompare(atB) || a.localeCompare(b));
    const window = list.slice(skip, skip + pageSize + 1);
    const over = window[pageSize];
    let next: string | undefined;
    if (over) {
      const lastDay = dayOf(over[1]);
      const sameDay = window.filter(([, at]) => dayOf(at) === lastDay).length;
      next = new URLSearchParams(
        sameDay === window.length
          ? { ...(from && { from }), skip: String(skip + pageSize) }
          : { from: lastDay, skip: String(sameDay - 1) },
      ).toString();
    }
    const page = window.slice(0, pageSize).map(([id, at]) => record(id, dayOf(at)));
    return new Response(listRecords(page, next), { headers: { 'content-type': 'text/xml' } });
  });
  return endpoint;
}

/** `count` records modified on `day`, a second apart, numbered from `first` (`2606.000NN`). */
const modifiedOn = (day: string, first: number, count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `2606.${String(first + i).padStart(5, '0')}`,
      `${day}T01:00:${String(i).padStart(2, '0')}Z`,
    ]),
  );

const makeCtx = (signal = new AbortController().signal) => ({
  log: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
  signal,
});

/** Query plans for the two lookups a record write and a tombstone cascade make by paper_id. */
function writePathPlans(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const plans = [
    `EXPLAIN QUERY PLAN DELETE FROM paper_categories WHERE paper_id = ?`,
    `EXPLAIN QUERY PLAN SELECT 1 FROM paper_categories WHERE paper_id = ?`,
  ].map((sql) =>
    (db.prepare(sql).all('2606.00001') as { detail: string }[]).map((r) => r.detail).join(' | '),
  );
  db.close();
  return plans;
}

const INDEXED_LOOKUP =
  /^SEARCH paper_categories USING (COVERING )?INDEX paper_categories_paper_id_idx \(paper_id=\?\)$/;

describe('runHarvest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-runner-test-'));
    config.mirrorPath = join(dir, 'mirror.db');
    requests = [];
    mockFetch.mockReset();
  });

  afterEach(async () => {
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  /** Seed papers plus a harvest_state row through the shared store handle. */
  async function seed(
    state: Parameters<MirrorStore['writeHarvestState']>[0],
  ): Promise<MirrorStore> {
    const store = await openStore(config.mirrorPath);
    store.writeHarvestState(state);
    return store;
  }

  // -------------------------------------------------------------------------
  // Where a run starts
  // -------------------------------------------------------------------------

  describe('start position', () => {
    it('starts a refresh after a completed run from last_datestamp (inclusive)', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-06-03', completed_at: 'c' });
      serve(listRecords([record('2606.00001', '2026-06-03')]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests).toHaveLength(1);
      expect(tokenOf(requests[0])).toBeNull();
      expect(fromOf(requests[0])).toBe('2026-06-03');
    });

    it('resumes a refresh that stopped before draining from its saved token (#50)', async () => {
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      serve(listRecords([record('2606.00002', '2026-06-04')]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(tokenOf(requests[0])).toBe('saved-tok');
      expect(fromOf(requests[0])).toBeNull();
    });

    it('resumes from the saved token after a run that ended in error (#50)', async () => {
      await seed({ status: 'error', last_datestamp: '2026-06-04', resumption_token: 'saved-tok' });
      serve(listRecords([record('2606.00002', '2026-06-04')]));

      await runHarvest(makeCtx(), { mode: 'init' });

      expect(tokenOf(requests[0])).toBe('saved-tok');
    });

    it('falls back to from=last_datestamp when the saved token is rejected (#50)', async () => {
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'stale-tok',
      });
      serve(BAD_TOKEN, listRecords([record('2606.00003', '2026-06-04')]));

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map((u) => [tokenOf(u), fromOf(u)])).toEqual([
        ['stale-tok', null],
        [null, '2026-06-04'],
      ]);
      expect(result.drained).toBe(true);
    });

    it('keeps the saved token through the start-of-run write (#50)', async () => {
      // A run that fails before its first page must leave the token it started
      // from, or the next run loses its place inside the datestamp.
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      const store = await openStore(config.mirrorPath);
      let tokenDuringFirstFetch: string | undefined;
      mockFetch.mockImplementation(async (url) => {
        requests.push(new URL(url));
        // A run killed here never reaches its catch: this is the state it leaves.
        tokenDuringFirstFetch = store.readHarvestState().resumption_token;
        return new Response('Bad request', { status: 400 });
      });

      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toThrow(/HTTP 400/);

      expect(tokenDuringFirstFetch).toBe('saved-tok');
      const state = (await openStore(config.mirrorPath)).readHarvestState();
      expect(state.status).toBe('error');
      expect(state.resumption_token).toBe('saved-tok');
      expect(state.last_datestamp).toBe('2026-06-04');
    });

    it('writes complete and clears the token once the list drains', async () => {
      const store = await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      serve(listRecords([record('2606.00004', '2026-06-05')], 'next-tok'), listRecords([]));

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      const state = store.readHarvestState();
      expect(state.status).toBe('complete');
      expect(state.resumption_token).toBeUndefined();
      expect(state.completed_at).toBeDefined();
      expect(state.last_datestamp).toBe('2026-06-05');
      expect(tokenOf(requests[1])).toBe('next-tok');
      expect(result).toMatchObject({
        drained: true,
        pagesFetched: 2,
        recordsApplied: 1,
        lastDatestamp: '2026-06-05',
        totalRecords: 1,
      });
    });

    it("checkpoints this run's start time, not the previous run's", async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-03',
        started_at: '2020-01-01T00:00:00.000Z',
        completed_at: '2020-01-01T01:00:00.000Z',
      });
      serve(listRecords([record('2606.00001', '2026-06-03')], 'tok-1'), listRecords([]));
      const seen: (string | undefined)[] = [];

      const before = new Date().toISOString();
      await runHarvest(makeCtx(), {
        mode: 'refresh',
        onProgress: () => seen.push(store.readHarvestState().started_at),
      });
      const after = new Date().toISOString();

      // Every checkpoint, and the completed state, carry one start time taken
      // during this run.
      const [startedAt] = seen;
      expect(startedAt! >= before && startedAt! <= after, String(startedAt)).toBe(true);
      expect(seen).toEqual([startedAt, startedAt]);
      expect(store.readHarvestState().started_at).toBe(startedAt);
    });
  });

  // -------------------------------------------------------------------------
  // Write-path index (#50)
  // -------------------------------------------------------------------------

  describe('write-path index on paper_categories(paper_id)', () => {
    it('serves every lookup by paper_id in a file MirrorStore.open created (#85)', async () => {
      const store = await MirrorStore.open(config.mirrorPath);
      expect(store.schemaVersion().current).toBe(MIRROR_SCHEMA_VERSION);
      store.close();

      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
    });

    it('is the schema’s, so a run changes no schema object before its first page (#85)', async () => {
      (await MirrorStore.open(config.mirrorPath)).close();
      // SQLite's schema cookie, which every CREATE or DROP advances.
      const cookie = () => {
        const db = new Database(config.mirrorPath, { readonly: true });
        const { schema_version } = db.query('PRAGMA schema_version').get() as {
          schema_version: number;
        };
        db.close();
        return schema_version;
      };
      const before = cookie();
      // The first fetch fails, so everything the run did came before its first page.
      serve({ body: 'Bad request', status: 400 });

      await expect(runHarvest(makeCtx(), { mode: 'init' })).rejects.toThrow(/HTTP 400/);

      expect(cookie()).toBe(before);
      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
    });
  });

  // -------------------------------------------------------------------------
  // Deadline (#39)
  // -------------------------------------------------------------------------

  describe('deadline', () => {
    /** Pages p1..pN, each with one record stamped `2026-06-0<n>`, the last one terminal. */
    const pages = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        listRecords(
          [record(`2606.0000${i + 1}`, `2026-06-0${i + 1}`)],
          i < n - 1 ? `tok-${i + 1}` : undefined,
        ),
      );

    it('stops after a whole page once no further page cycle fits, leaving a datestamp checkpoint with no token past the start datestamp (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: '2026-06-01T00:00:00.000Z',
        total_records: 0,
      });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({
        drained: false,
        pagesFetched: 1,
        recordsApplied: 1,
        lastDatestamp: '2026-06-01',
      });
      const state = store.readHarvestState();
      expect(state.status).toBe('in_progress');
      expect(state.resumption_token).toBeUndefined();
      expect(state.last_datestamp).toBe('2026-06-01');
      expect(state.completed_at).toBe('2026-06-01T00:00:00.000Z');
      expect(store.countPapers()).toBe(1);
    });

    it('lets the next run restart at the datestamp checkpoint the stopped run left (#62)', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));
      await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(startOf)).toEqual(['2026-05-31', '2026-06-01', 'tok-2']);
      expect(result.drained).toBe(true);
      expect((await openStore(config.mirrorPath)).countPapers()).toBe(3);
    });

    it('reserves one worst-case page fetch before the deadline, not just the time left', async () => {
      // At these settings a page fetch can take ~105 s (three attempts at the
      // 15 s timeout plus two 30 s backoffs), so 100 s is not enough room.
      expect(worstCasePageFetchMs(harvestOptions())).toBe(105_000);
      expect(worstCasePageFetchMs({ ...harvestOptions(), requestDelayMs: 3000 })).toBe(108_000);
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), {
        mode: 'refresh',
        deadline: Date.now() + 100_000,
      });

      expect(result.drained).toBe(false);
      expect(requests).toHaveLength(1);
    });

    it('drains when its last page lands past the deadline', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      serve(...pages(1));

      const result = await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(result.drained).toBe(true);
      expect(store.readHarvestState().status).toBe('complete');
    });

    it('reserves the slowest page apply seen so far, not only the fetch', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));
      const apply = MirrorStore.prototype.applyBatch;
      const slowApply = vi.spyOn(MirrorStore.prototype, 'applyBatch').mockImplementation(function (
        this: MirrorStore,
        ...args
      ) {
        const until = performance.now() + 400;
        while (performance.now() < until) {
          // a 400 ms page apply
        }
        return apply.apply(this, args);
      });
      try {
        // Room for one worst-case fetch plus 600 ms: a second page fits without
        // the 400 ms apply reserved, and not with it.
        const result = await runHarvest(makeCtx(), {
          mode: 'refresh',
          deadline: Date.now() + worstCasePageFetchMs(harvestOptions()) + 600,
        });
        expect(result.drained).toBe(false);
        expect(requests).toHaveLength(1);
      } finally {
        slowApply.mockRestore();
      }
    });

    it('drains when every page cycle fits, and advances completed_at', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: '2026-06-01T00:00:00.000Z',
      });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), {
        mode: 'refresh',
        deadline: Date.now() + 3_600_000,
      });

      expect(result).toMatchObject({ drained: true, pagesFetched: 3, lastDatestamp: '2026-06-03' });
      expect(store.readHarvestState().status).toBe('complete');
      expect(store.readHarvestState().completed_at).not.toBe('2026-06-01T00:00:00.000Z');
    });

    it('reports a cancellation as a failure, never as a deadline stop, and saves no token (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      const controller = new AbortController();
      const [first] = pages(3);
      mockFetch.mockImplementation(async (url, init) => {
        init?.signal?.throwIfAborted();
        requests.push(new URL(url));
        // Cancelled while the page is in hand — the abort lands during apply.
        controller.abort(new Error('Aborted by SIGTERM'));
        return new Response(first, { status: 200 });
      });

      await expect(
        runHarvest(makeCtx(controller.signal), { mode: 'refresh', deadline: Date.now() }),
      ).rejects.toThrow('Aborted by SIGTERM');

      const state = store.readHarvestState();
      expect(state.status).toBe('error');
      expect(state.resumption_token).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Which writes keep the token (#62)
  // -------------------------------------------------------------------------

  describe('token kept across runs (#62)', () => {
    /** Nine records modified on 2026-06-04: three pages of three. */
    const busyDay = modifiedOn('2026-06-04', 1, 9);

    it('saves no token at a deadline stop past the start datestamp, so the next run restarts at the checkpoint and skips nothing (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-03',
        completed_at: 'c',
      });
      const oai = serveArxivList(busyDay);

      const first = await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(first).toMatchObject({ drained: false, pagesFetched: 1, lastDatestamp: '2026-06-04' });
      expect(store.readHarvestState()).toMatchObject({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
      });
      expect(store.readHarvestState()).not.toHaveProperty('resumption_token');

      // arXiv re-modifies a record the stopped run already read: it moves to the
      // end of the list, and every record after it one place earlier.
      oai.touch('2606.00002', '2026-06-05T00:00:00Z');
      requests = [];
      const next = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(startOf)).toEqual([
        '2026-06-04',
        'from=2026-06-04&skip=3',
        'from=2026-06-04&skip=6',
      ]);
      expect(next.drained).toBe(true);
      expect(oai.missing(store)).toEqual([]);
    });

    it('stores no token on the per-page writes of a run that has not stopped, so a killed run restarts at the checkpoint (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      serveArxivList(busyDay);
      const saved: (string | undefined)[] = [];

      await runHarvest(makeCtx(), {
        mode: 'refresh',
        onProgress: () => saved.push(store.readHarvestState().resumption_token),
      });

      // Pages one and two returned a token; neither write kept it.
      expect(saved).toEqual([undefined, undefined, undefined]);
    });

    it('keeps the token at a deadline stop on the start datestamp, and the next run resumes it (#50, #62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      const oai = serveArxivList(busyDay);

      await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(store.readHarvestState()).toMatchObject({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'from=2026-06-04&skip=3',
      });

      requests = [];
      const next = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(startOf)).toEqual(['from=2026-06-04&skip=3', 'from=2026-06-04&skip=6']);
      expect(next).toMatchObject({ drained: true, pagesFetched: 2 });
      expect(oai.missing(store)).toEqual([]);
    });

    it('saves no token when a page fails on the start datestamp, and the next init restarts there (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      const oai = serveArxivList(busyDay);
      oai.intercept = (u) =>
        tokenOf(u) === 'from=2026-06-04&skip=3'
          ? new Response('Bad request', { status: 400 })
          : undefined;

      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toThrow(/HTTP 400/);

      expect(requests.map(startOf)).toEqual(['2026-06-04', 'from=2026-06-04&skip=3']);
      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-04',
      });
      expect(store.readHarvestState()).not.toHaveProperty('resumption_token');

      oai.intercept = () => undefined;
      oai.touch('2606.00002', '2026-06-05T00:00:00Z');
      requests = [];
      const next = await runHarvest(makeCtx(), { mode: 'init' });

      expect(requests.map(startOf)[0]).toBe('2026-06-04');
      expect(next.drained).toBe(true);
      expect(oai.missing(store)).toEqual([]);
    });

    it('saves no token when a run on the start datestamp is cancelled (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      const oai = serveArxivList(busyDay);
      const controller = new AbortController();
      // Cancelled once the second page's request is in flight.
      oai.intercept = (u) => {
        if (tokenOf(u)) controller.abort(new Error('Aborted by SIGTERM'));
        return;
      };

      await expect(runHarvest(makeCtx(controller.signal), { mode: 'refresh' })).rejects.toThrow(
        'Aborted by SIGTERM',
      );

      const state = store.readHarvestState();
      expect(state).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-04',
        error_message: 'Aborted by SIGTERM',
      });
      expect(state).not.toHaveProperty('resumption_token');

      oai.intercept = () => undefined;
      requests = [];
      await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(startOf)[0]).toBe('2026-06-04');
      expect(oai.missing(store)).toEqual([]);
    });

    it('keeps a resumed token while the checkpoint stays on the start datestamp, and drops it once the checkpoint moves (#62)', async () => {
      // Three pages on 2026-06-04, then two on 2026-06-05.
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      const oai = serveArxivList({ ...busyDay, ...modifiedOn('2026-06-05', 10, 6) });
      const failOn = (token: string) => {
        oai.intercept = (u) =>
          tokenOf(u) === token ? new Response('Bad request', { status: 400 }) : undefined;
      };
      const tokenNow = () => store.readHarvestState().resumption_token;

      // Run 1 stops at its deadline inside the start datestamp: the token stays.
      await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });
      expect(tokenNow()).toBe('from=2026-06-04&skip=3');

      // Run 2 resumed it and fails still inside that datestamp: the newer token stays.
      requests = [];
      failOn('from=2026-06-04&skip=6');
      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toThrow(/HTTP 400/);
      expect(requests.map(startOf)).toEqual(['from=2026-06-04&skip=3', 'from=2026-06-04&skip=6']);
      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-04',
        resumption_token: 'from=2026-06-04&skip=6',
      });

      // Run 3 resumed that one and fails once its checkpoint moved to 2026-06-05: none stays.
      requests = [];
      failOn('from=2026-06-05&skip=3');
      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toThrow(/HTTP 400/);
      expect(requests.map(startOf)).toEqual([
        'from=2026-06-04&skip=6',
        'from=2026-06-05&skip=0',
        'from=2026-06-05&skip=3',
      ]);
      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-05',
      });
      expect(tokenNow()).toBeUndefined();

      // Run 4 restarts at the checkpoint, past a record re-modified since run 3 read it.
      oai.intercept = () => undefined;
      oai.touch('2606.00011', '2026-06-06T00:00:00Z');
      requests = [];
      const last = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(startOf)).toEqual(['2026-06-05', 'from=2026-06-05&skip=3']);
      expect(last).toMatchObject({ drained: true, lastDatestamp: '2026-06-06' });
      expect(store.readHarvestState()).toMatchObject({ status: 'complete' });
      expect(tokenNow()).toBeUndefined();
      expect(oai.missing(store)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Token-recovery guard (#59)
  // -------------------------------------------------------------------------

  describe('token-recovery guard (#59)', () => {
    it('fails a refresh whose token recovery makes no progress, leaving an error checkpoint', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-04',
        completed_at: 'c',
      });
      // Every token is rejected; every from= page stays on 2026-06-04. A 400
      // past eight requests ends a harvest that keeps looping.
      let issued = 0;
      mockFetch.mockImplementation(async (url) => {
        const u = oaiUrl(url);
        requests.push(u);
        if (requests.length > 8) return new Response('stop', { status: 400 });
        if (tokenOf(u)) return new Response(BAD_TOKEN, { status: 200 });
        issued += 1;
        return new Response(listRecords([record('2606.00001', '2026-06-04')], `t${issued}`));
      });

      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toMatchObject({
        data: { reason: 'token_recovery_stalled', resumptionToken: 't2', from: '2026-06-04' },
      });

      expect(requests.map((u) => tokenOf(u) ?? fromOf(u))).toEqual([
        '2026-06-04',
        't1',
        '2026-06-04',
        't2',
      ]);
      const state = store.readHarvestState();
      expect(state.status).toBe('error');
      expect(state.last_datestamp).toBe('2026-06-04');
      expect(state.error_message).toMatch(/'t2'.*2026-06-04/);
    });
  });

  // -------------------------------------------------------------------------
  // Init outage wait (#61)
  // -------------------------------------------------------------------------

  describe('init outage wait (#61)', () => {
    const WAIT_MSG = 'arXiv OAI-PMH unavailable; waiting, then re-sending the same request';

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Page 1 carries `tok-1`; `tok-1` answers 503 `failures` times, then a terminal page. */
    function outageAfterFirstPage(failures: number, retryAfter?: string): void {
      let calls = 0;
      mockFetch.mockImplementation(async (url, init) => {
        init?.signal?.throwIfAborted();
        const u = oaiUrl(url);
        requests.push(u);
        if (!tokenOf(u)) {
          return new Response(listRecords([record('2606.00001', '2026-06-01')], 'tok-1'));
        }
        calls += 1;
        if (calls <= failures) {
          return new Response('down', {
            status: 503,
            ...(retryAfter && { headers: { 'retry-after': retryAfter } }),
          });
        }
        return new Response(listRecords([record('2606.00002', '2026-06-02')]));
      });
    }

    it('waits out an outage in init, re-sends the same token, drains, and writes complete', async () => {
      // Opened before the clock is faked, so the run's open resolves at once.
      const store = await openStore(config.mirrorPath);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      outageAfterFirstPage(3);
      const ctx = makeCtx();

      const run = runHarvest(ctx, { mode: 'init' });
      await vi.advanceTimersByTimeAsync(3_600_000);
      const result = await run;

      expect(requests.map(tokenOf)).toEqual([null, 'tok-1', 'tok-1', 'tok-1', 'tok-1']);
      expect(result).toMatchObject({ drained: true, pagesFetched: 2, lastDatestamp: '2026-06-02' });
      expect(store.readHarvestState()).toMatchObject({ status: 'complete', total_records: 2 });
      expect(ctx.log.warning).toHaveBeenCalledWith(WAIT_MSG, {
        error: expect.stringMatching(/HTTP 503.*\(failed after 3 attempts\)$/),
        request: { resumptionToken: 'tok-1' },
        waitMs: 60_000,
      });
    });

    it('still fails a refresh after the page retries, with no wait and no token saved past the start datestamp (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      outageAfterFirstPage(3);
      const ctx = makeCtx();

      const run = runHarvest(ctx, { mode: 'refresh' }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(await run).toMatchObject({
        message: expect.stringMatching(/HTTP 503.*\(failed after 3 attempts\)$/),
      });
      expect(requests.map(tokenOf)).toEqual([null, 'tok-1', 'tok-1', 'tok-1']);
      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-01',
      });
      expect(store.readHarvestState()).not.toHaveProperty('resumption_token');
      expect(ctx.log.warning).not.toHaveBeenCalled();
    });

    it('writes the transport cause and host into error_message when a refresh fails, and no token past the start datestamp (#62)', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // The token request fails to resolve the host, as Node's fetch reports it.
      mockFetch.mockImplementation(async (url) => {
        const u = oaiUrl(url);
        requests.push(u);
        if (!tokenOf(u)) {
          return new Response(listRecords([record('2606.00001', '2026-06-01')], 'tok-1'));
        }
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND oai.test'), { code: 'ENOTFOUND' }),
        });
      });

      const run = runHarvest(makeCtx(), { mode: 'refresh' }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3_600_000);
      await run;

      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        error_message:
          'arXiv OAI-PMH network error reaching oai.test: getaddrinfo ENOTFOUND oai.test (failed after 3 attempts)',
      });
      expect(store.readHarvestState()).not.toHaveProperty('resumption_token');
    });

    it('ends a wait at once on a cancelled signal, leaving the datestamp checkpoint the next init restarts at (#62)', async () => {
      // Opened before the clock is faked, so the run's open resolves at once.
      const store = await openStore(config.mirrorPath);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // One 503 asking for 120 s: the run is in a 120 s wait when the signal fires.
      outageAfterFirstPage(1, '120');
      const controller = new AbortController();
      const ctx = makeCtx(controller.signal);

      const run = runHarvest(ctx, { mode: 'init' }).catch((e: unknown) => e);
      await vi.waitFor(() =>
        expect(ctx.log.warning).toHaveBeenCalledWith(
          WAIT_MSG,
          expect.objectContaining({ waitMs: 120_000 }),
        ),
      );
      const clock = Date.now();
      controller.abort(new Error('Aborted by SIGINT'));

      // Settles with no further advance of the clock.
      expect(await run).toMatchObject({ message: 'Aborted by SIGINT' });
      expect(Date.now()).toBe(clock);
      expect(requests.map(tokenOf)).toEqual([null, 'tok-1']);
      expect(store.readHarvestState()).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-01',
        error_message: 'Aborted by SIGINT',
      });
      expect(store.readHarvestState()).not.toHaveProperty('resumption_token');

      vi.useRealTimers();
      requests = [];
      serve(listRecords([record('2606.00002', '2026-06-02')]));
      const next = await runHarvest(makeCtx(), { mode: 'init' });

      expect(requests.map(startOf)).toEqual(['2026-06-01']);
      expect(next.drained).toBe(true);
      expect(store.readHarvestState().status).toBe('complete');
    });
  });

  // -------------------------------------------------------------------------
  // mirror:init as a real process (#61)
  // -------------------------------------------------------------------------

  describe('mirror:init script (real process)', () => {
    const SCRIPT = fileURLToPath(
      new URL('../../../../scripts/arxiv-mirror-init.ts', import.meta.url),
    );
    let server: Server;
    let baseUrl: string;
    let served: URL[];
    /** How the endpoint answers each request. */
    let respond: (url: URL, res: ServerResponse) => void;
    /** Children started in the current test, with a promise for each one's `close`. */
    let started: { child: ChildProcess; closed: Promise<void> }[];

    beforeEach(async () => {
      served = [];
      started = [];
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        served.push(url);
        respond(url, res);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oai`;
    });

    afterEach(async () => {
      for (const { child } of started) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(started.map((s) => s.closed));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    /** Run the init script; `onStderr` sees each stderr chunk with the child's handle. */
    function runInit(onStderr?: (text: string, child: ChildProcess) => void) {
      return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [SCRIPT], {
          env: {
            ...process.env,
            ARXIV_MIRROR_PATH: config.mirrorPath,
            ARXIV_MIRROR_OAI_BASE_URL: baseUrl,
            ARXIV_MIRROR_OAI_REQUEST_DELAY_MS: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        started.push({ child, closed: new Promise((r) => child.once('close', () => r())) });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          onStderr?.(stderr, child);
        });
        child.on('close', (code) => resolve({ code, stderr, stdout }));
      });
    }

    it('exits 1 at once on SIGTERM during an outage wait, and the next run restarts at the datestamp checkpoint (#62)', async () => {
      const firstPage = listRecords([record('2606.00001', '2026-06-01')], 'tok-1');
      respond = (url, res) => {
        if (!url.searchParams.has('resumptionToken')) {
          res.end(firstPage);
          return;
        }
        res.writeHead(503, { 'retry-after': '120' });
        res.end('down');
      };
      let signalledAt = 0;

      const first = await runInit((stderr, child) => {
        if (!signalledAt && stderr.includes('arXiv OAI-PMH unavailable; waiting')) {
          signalledAt = performance.now();
          child.kill('SIGTERM');
        }
      });

      expect(signalledAt).toBeGreaterThan(0);
      expect(performance.now() - signalledAt).toBeLessThan(5000);
      expect(first.code).toBe(1);
      expect(first.stderr).toContain('"waitMs":120000');
      expect(first.stderr).toContain('Received SIGTERM; aborting harvest');
      expect(first.stderr).toContain('Harvest failed: Aborted by SIGTERM');
      expect(served.map((u) => u.searchParams.get('resumptionToken'))).toEqual([null, 'tok-1']);
      const state = (await openStore(config.mirrorPath)).readHarvestState();
      expect(state).toMatchObject({
        status: 'error',
        last_datestamp: '2026-06-01',
      });
      expect(state).not.toHaveProperty('resumption_token');
      resetStore();

      const resumeAt = served.length;
      respond = (_url, res) => res.end(listRecords([record('2606.00002', '2026-06-02')]));
      const second = await runInit();

      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Harvest complete');
      expect(served[resumeAt]?.searchParams.get('resumptionToken')).toBeNull();
      expect(served[resumeAt]?.searchParams.get('from')).toBe('2026-06-01');
      expect((await openStore(config.mirrorPath)).readHarvestState().status).toBe('complete');
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // A file another writer is migrating (#71)
  // -------------------------------------------------------------------------

  describe('a file another writer is migrating (#71)', () => {
    /** Leave the mirror on schema v2, a completed harvest, and another writer's live migration lease. */
    async function migratingElsewhere(): Promise<void> {
      const store = await MirrorStore.open(config.mirrorPath);
      store.writeHarvestState({
        status: 'complete',
        last_datestamp: '2026-06-03',
        completed_at: '2026-06-04T00:00:00.000Z',
      });
      store.close();
      const now = new Date().toISOString();
      const db = new Database(config.mirrorPath);
      db.run('DELETE FROM schema_version');
      db.run(
        `INSERT INTO schema_version(version, applied_at) VALUES (2, '2025-06-01T00:00:00.000Z')`,
      );
      db.run(
        `INSERT INTO migration_lease(id, holder, pid, started_at, renewed_at)
         VALUES (1, 'another-writer', 4242, ?, ?)`,
        [now, now],
      );
      db.close();
    }

    function fileState() {
      const db = new Database(config.mirrorPath, { readonly: true });
      const state = db
        .query('SELECT status, last_datestamp, resumption_token FROM harvest_state')
        .get();
      const version = db.query('SELECT version FROM schema_version').get();
      const leases = db.query('SELECT holder FROM migration_lease').all();
      db.close();
      return { state, version, leases };
    }

    const UNCHANGED = {
      state: { status: 'complete', last_datestamp: '2026-06-03', resumption_token: null },
      version: { version: 2 },
      leases: [{ holder: 'another-writer' }],
    };

    it('fails the run before any request, leaving the checkpoint as it was', async () => {
      await migratingElsewhere();
      serve();

      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'migration_in_progress', holderPid: 4242 },
      });
      expect(requests).toEqual([]);
      expect(fileState()).toEqual(UNCHANGED);
    });

    describe('mirror scripts (real process)', () => {
      let server: Server;
      let served: URL[];

      beforeEach(async () => {
        served = [];
        server = createServer((req, res) => {
          served.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
          res.statusCode = 500;
          res.end();
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      });

      afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      });

      function runScript(name: string) {
        const script = fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url));
        return new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [script], {
            env: {
              ...process.env,
              ARXIV_MIRROR_PATH: config.mirrorPath,
              ARXIV_MIRROR_OAI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oai`,
              ARXIV_MIRROR_OAI_REQUEST_DELAY_MS: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('close', (code) => resolve({ code, stderr }));
        });
      }

      it.each([
        ['arxiv-mirror-init.ts', 'Harvest'],
        ['arxiv-mirror-refresh.ts', 'Refresh'],
        ['arxiv-mirror-verify.ts', 'Verify'],
      ])(
        '%s exits 75 naming the migrating writer, and changes nothing',
        async (name, label) => {
          await migratingElsewhere();

          const { code, stderr } = await runScript(name);

          expect(code).toBe(75);
          expect(stderr).toContain(
            `${label} did not run: Mirror file ${config.mirrorPath} is being migrated from schema v2 to v${MIRROR_SCHEMA_VERSION} by another writer (pid 4242,`,
          );
          expect(stderr).toContain('Run it again once that migration finishes.');
          expect(served).toEqual([]);
          expect(fileState()).toEqual(UNCHANGED);
        },
        30_000,
      );
    });
  });

  // -------------------------------------------------------------------------
  // mirror:verify against the schema's indexes and trigger (#78, #85)
  // -------------------------------------------------------------------------

  describe('mirror:verify script (real process)', () => {
    const SCRIPT = fileURLToPath(
      new URL('../../../../scripts/arxiv-mirror-verify.ts', import.meta.url),
    );

    function runVerify() {
      return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [SCRIPT], {
          env: { ...process.env, ARXIV_MIRROR_PATH: config.mirrorPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => resolve({ code, stderr, stdout }));
      });
    }

    /** A current mirror file, then `statements` run against it on a separate connection. */
    async function currentFileAfter(...statements: string[]): Promise<void> {
      (await MirrorStore.open(config.mirrorPath)).close();
      const db = new Database(config.mirrorPath);
      for (const sql of statements) db.run(sql);
      db.close();
    }

    /** The SQL the file stores for the schema object `name`, or `null` when it has none. */
    function storedSql(name: string): string | null {
      const db = new Database(config.mirrorPath, { readonly: true });
      const row = db.query('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as {
        sql: string;
      } | null;
      db.close();
      return row?.sql ?? null;
    }

    it('passes a current file, listing each index and the fill trigger as ok', async () => {
      await currentFileAfter();

      const { code, stderr, stdout } = await runVerify();

      expect(code, stderr).toBe(0);
      for (const object of [
        'index paper_categories_cat_published_idx',
        'index paper_categories_cat_updated_idx',
        'index papers_published_idx',
        'index papers_updated_idx',
        'index papers_revised_early_idx',
        'index paper_categories_paper_id_idx',
        'trigger paper_categories_published_fill',
      ]) {
        expect(stdout).toContain(`  ${object}: ok\n`);
      }
      expect(stdout).toContain('Mirror OK');
    }, 30_000);

    it.each([
      {
        label: 'a dropped index',
        damage: ['DROP INDEX papers_published_idx'],
        name: 'papers_published_idx',
        listed: 'index papers_published_idx: missing',
        failure: 'index papers_published_idx is missing',
        restore: [
          'DROP INDEX IF EXISTS papers_published_idx;',
          'CREATE INDEX papers_published_idx ON papers(published, updated);',
        ],
      },
      {
        label: 'an index with its v3 definition',
        damage: [
          'DROP INDEX paper_categories_cat_updated_idx',
          'CREATE INDEX paper_categories_cat_updated_idx ON paper_categories(category, updated)',
        ],
        name: 'paper_categories_cat_updated_idx',
        listed: `index paper_categories_cat_updated_idx: differs from schema v${MIRROR_SCHEMA_VERSION}`,
        failure: `index paper_categories_cat_updated_idx differs from schema v${MIRROR_SCHEMA_VERSION}`,
        restore: [
          'DROP INDEX IF EXISTS paper_categories_cat_updated_idx;',
          'CREATE INDEX paper_categories_cat_updated_idx ON paper_categories(category, updated, paper_id, published);',
        ],
      },
      {
        label: 'a partial index that lost its WHERE clause',
        damage: [
          'DROP INDEX papers_revised_early_idx',
          'CREATE INDEX papers_revised_early_idx ON papers(published, updated)',
        ],
        name: 'papers_revised_early_idx',
        listed: `index papers_revised_early_idx: differs from schema v${MIRROR_SCHEMA_VERSION}`,
        failure: `index papers_revised_early_idx differs from schema v${MIRROR_SCHEMA_VERSION}`,
        restore: [
          'DROP INDEX IF EXISTS papers_revised_early_idx;',
          'CREATE INDEX papers_revised_early_idx ON papers(published, updated) WHERE updated < published;',
        ],
      },
      {
        label: 'the paper_id index as the harvest runner built it before v5',
        damage: [
          'DROP INDEX paper_categories_paper_id_idx',
          'CREATE INDEX paper_categories_paper_id_idx ON paper_categories(paper_id)',
        ],
        name: 'paper_categories_paper_id_idx',
        listed: `index paper_categories_paper_id_idx: differs from schema v${MIRROR_SCHEMA_VERSION}`,
        failure: `index paper_categories_paper_id_idx differs from schema v${MIRROR_SCHEMA_VERSION}`,
        restore: [
          'DROP INDEX IF EXISTS paper_categories_paper_id_idx;',
          'CREATE INDEX paper_categories_paper_id_idx ON paper_categories(paper_id, category);',
        ],
      },
      {
        label: 'a dropped fill trigger',
        damage: ['DROP TRIGGER paper_categories_published_fill'],
        name: 'paper_categories_published_fill',
        listed: 'trigger paper_categories_published_fill: missing',
        failure: 'trigger paper_categories_published_fill is missing',
        restore: [
          'DROP TRIGGER IF EXISTS paper_categories_published_fill;',
          'CREATE TRIGGER IF NOT EXISTS paper_categories_published_fill\nAFTER INSERT ON paper_categories',
        ],
      },
    ])(
      'exits 1 on $label, naming it and the statements that restore it, and leaves the file as it was',
      async ({ damage, name, listed, failure, restore }) => {
        await currentFileAfter(...damage);
        const before = storedSql(name);

        const { code, stderr, stdout } = await runVerify();

        expect(code, stdout).toBe(1);
        expect(stdout).toContain(`  ${listed}\n`);
        expect(stdout).not.toContain('Mirror OK');
        expect(stderr).toContain(`Schema objects FAILED: ${failure}.`);
        for (const statement of restore) expect(stderr).toContain(statement);
        // The writer open verify makes rebuilds nothing.
        expect(storedSql(name)).toBe(before);
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // The mirror scripts as the npm package ships them (#75)
  // -------------------------------------------------------------------------

  describe('mirror scripts installed from the package (real process, #75)', () => {
    const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

    /** Server modules that report the tree they were loaded from as the mirror path. */
    const serverStubs = (tree: string): Record<string, string> => ({
      'config/server-config': `export const getServerConfig = () => ({ mirrorPath: '${tree}' });`,
      'services/arxiv/mirror/index': `export const isMigrationConflict = () => false;
export const openStore = async () => ({
  readHarvestState: () => ({ status: 'pending' }),
  schemaVersion: () => ({ current: 3, expected: 3 }),
  checkSchemaObjects: () => [],
  integrityCheck: () => ({ ok: true, results: ['ok'] }),
});`,
    });

    /**
     * The package under another project's `node_modules`: the `scripts/` entries
     * `package.json` `files` lists, a `dist/` of stub modules standing in for the
     * build, and a `src/` beside it only when `withSrc` (a checkout). The project
     * root carries its own `tsconfig.json` mapping `@/*` elsewhere.
     */
    async function installPackage(withSrc: boolean): Promise<string> {
      const pkg = join(dir, 'node_modules', '@cyanheads', 'arxiv-mcp-server');
      const { files } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
        files: string[];
      };
      await mkdir(join(pkg, 'scripts'), { recursive: true });
      for (const entry of files.filter((f) => f.startsWith('scripts/'))) {
        await copyFile(join(ROOT, entry), join(pkg, entry));
      }
      const trees: [string, string][] = withSrc
        ? [
            ['dist', '.js'],
            ['src', '.ts'],
          ]
        : [['dist', '.js']];
      for (const [tree, ext] of trees) {
        for (const [module, body] of Object.entries(serverStubs(tree))) {
          const file = join(pkg, tree, `${module}${ext}`);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, body);
        }
      }
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      );
      return pkg;
    }

    function runVerify(pkg: string, cwd: string) {
      return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [join(pkg, 'scripts', 'arxiv-mirror-verify.ts')], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => resolve({ code, stderr, stdout }));
      });
    }

    it('resolves their @/ imports to dist/ with no src/, from the package directory and from the project root (#75)', async () => {
      const pkg = await installPackage(false);

      for (const cwd of [pkg, dir]) {
        const { code, stderr, stdout } = await runVerify(pkg, cwd);

        expect(code, stderr).toBe(0);
        expect(stdout).toContain('Verifying mirror at dist');
        expect(stdout).toContain('Mirror OK');
      }
    }, 30_000);

    it('resolves them to src/ first when a checkout also holds a built dist/ (#75)', async () => {
      const pkg = await installPackage(true);

      const { code, stderr, stdout } = await runVerify(pkg, pkg);

      expect(code, stderr).toBe(0);
      expect(stdout).toContain('Verifying mirror at src');
    }, 30_000);
  });
});

/** Harvester options as `runHarvest` derives them from {@link config}. */
function harvestOptions() {
  return {
    baseUrl: config.mirrorOaiBaseUrl,
    requestDelayMs: config.mirrorOaiRequestDelayMs,
    requestTimeoutMs: config.apiTimeoutMs,
  };
}
