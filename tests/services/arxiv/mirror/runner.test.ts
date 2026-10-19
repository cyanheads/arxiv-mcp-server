/**
 * @fileoverview Tests for the mirror harvest runner — where a run starts
 * (saved resumption token vs. `from=last_datestamp`), what it persists as it
 * goes, the write-path index it ensures before the first page (#50), the
 * deadline that stops it after a whole page (#39), the stalled token recovery
 * that fails a run (#59), the outage wait only `init` runs (#61), and the run
 * on a file another writer is migrating (#71). Drives the real `MirrorStore` on
 * a temp file; only `fetch` (the OAI endpoint) is stubbed, except in the
 * real-process blocks, which run the mirror scripts against a loopback OAI
 * endpoint.
 * @module services/arxiv/mirror/runner.test
 */

import { Database } from 'bun:sqlite';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worstCasePageFetchMs } from '@/services/arxiv/mirror/harvester.js';
import { runHarvest } from '@/services/arxiv/mirror/runner.js';
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
    it('is absent from a file MirrorStore.open created and full-scans per write', async () => {
      const store = await MirrorStore.open(config.mirrorPath);
      expect(store.schemaVersion().current).toBe(3);
      store.close();

      for (const plan of writePathPlans(config.mirrorPath)) {
        expect(plan).toMatch(/^SCAN paper_categories/);
      }
    });

    it('is built before the first page of a fresh init', async () => {
      // The first fetch fails, so only work done before the first page can
      // have built the index.
      serve({ body: 'Bad request', status: 400 });

      await expect(runHarvest(makeCtx(), { mode: 'init' })).rejects.toThrow(/HTTP 400/);

      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
    });

    it('is added to a populated schema-v3 file by the next refresh', async () => {
      const store = await MirrorStore.open(config.mirrorPath);
      store.applyBatch(
        [
          {
            paper_id: '2606.00001',
            identifier: 'oai:arXiv.org:2606.00001',
            datestamp: '2026-06-01',
            title: 'Existing paper',
            authors: 'A. Author',
            abstract: 'Already harvested.',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2026-06-01T00:00:00Z' }],
          },
        ],
        [],
      );
      store.writeHarvestState({
        status: 'complete',
        last_datestamp: '2026-06-01',
        completed_at: 'c',
      });
      store.close();
      serve(listRecords([]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
      expect((await openStore(config.mirrorPath)).schemaVersion().current).toBe(3);
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

    it('stops after a whole page once no further page cycle fits, leaving a resumable checkpoint', async () => {
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
      expect(state.resumption_token).toBe('tok-1');
      expect(state.last_datestamp).toBe('2026-06-01');
      expect(state.completed_at).toBe('2026-06-01T00:00:00.000Z');
      expect(store.countPapers()).toBe(1);
    });

    it('lets the next run continue from the checkpoint the stopped run left', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));
      await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(tokenOf)).toEqual([null, 'tok-1', 'tok-2']);
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

    it('reports a cancellation as a failure, never as a deadline stop', async () => {
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
      expect(state.resumption_token).toBe('tok-1');
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

    it('still fails a refresh after the page retries, with no wait', async () => {
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
        resumption_token: 'tok-1',
      });
      expect(ctx.log.warning).not.toHaveBeenCalled();
    });

    it('writes the transport cause and host into error_message when a refresh fails', async () => {
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
        resumption_token: 'tok-1',
        error_message:
          'arXiv OAI-PMH network error reaching oai.test: getaddrinfo ENOTFOUND oai.test (failed after 3 attempts)',
      });
    });

    it('ends a wait at once on a cancelled signal, leaving the checkpoint the next init resumes from', async () => {
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
        resumption_token: 'tok-1',
        last_datestamp: '2026-06-01',
        error_message: 'Aborted by SIGINT',
      });

      vi.useRealTimers();
      requests = [];
      serve(listRecords([record('2606.00002', '2026-06-02')]));
      const next = await runHarvest(makeCtx(), { mode: 'init' });

      expect(requests.map(tokenOf)).toEqual(['tok-1']);
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

    it('exits 1 at once on SIGTERM during an outage wait, and the next run resumes from the saved token', async () => {
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
        resumption_token: 'tok-1',
        last_datestamp: '2026-06-01',
      });
      resetStore();

      const resumeAt = served.length;
      respond = (_url, res) => res.end(listRecords([record('2606.00002', '2026-06-02')]));
      const second = await runInit();

      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Harvest complete');
      expect(served[resumeAt]?.searchParams.get('resumptionToken')).toBe('tok-1');
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
            `${label} did not run: Mirror file ${config.mirrorPath} is being migrated from schema v2 to v3 by another writer (pid 4242,`,
          );
          expect(stderr).toContain('Run it again once that migration finishes.');
          expect(served).toEqual([]);
          expect(fileState()).toEqual(UNCHANGED);
        },
        30_000,
      );
    });
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
