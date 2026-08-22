/**
 * @fileoverview Mirror harvest runner — orchestrates harvester + store for
 * full init and incremental refresh. Provides shared progress reporting and
 * persistence of harvest state.
 * @module services/arxiv/mirror/runner
 */

import { getServerConfig } from '@/config/server-config.js';
import { type HarvesterOptions, harvestPages, pickLatestDatestamp } from './harvester.js';
import { type MirrorStore, openStore } from './store.js';

/**
 * Logger shape shared by every harvest entry point — request-scoped
 * `ContextLogger`, framework `Logger`, or script console wrapper. Methods
 * take `(message, meta?)` so the runner can call them without knowing which
 * concrete logger is on the other side.
 */
export interface MirrorLogger {
  debug?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  notice?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warning?(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

/** Minimal context the harvest runner consumes — duck-typed logging + cancellation. */
export interface MirrorRunnerContext {
  log: MirrorLogger;
  signal: AbortSignal;
}

/** Outcome of a harvest run. */
export interface HarvestResult {
  pagesFetched: number;
  recordsApplied: number;
  tombstonesApplied: number;
  totalRecords: number;
}

/** Hook called periodically during a harvest. */
export type ProgressCallback = (info: {
  lastDatestamp?: string | undefined;
  pages: number;
  records: number;
  tombstones: number;
}) => void;

/**
 * Run a harvest cycle. When called with no checkpoint, performs a full init;
 * when called after a previous successful run, performs an incremental refresh
 * starting from the last datestamp + 1 day (OAI `from` is inclusive).
 *
 * Persists `harvest_state` progress and final status. Safe to interrupt — a
 * subsequent run resumes from the persisted resumption token, or recovers
 * from the last datestamp when the token has expired.
 */
export async function runHarvest(
  ctx: MirrorRunnerContext,
  options: { mode: 'init' | 'refresh'; onProgress?: ProgressCallback },
): Promise<HarvestResult> {
  const config = getServerConfig();
  const store = await openStore(config.mirrorPath);
  const existing = store.readHarvestState();

  const harvestOptions: HarvesterOptions = {
    baseUrl: config.mirrorOaiBaseUrl,
    requestDelayMs: config.mirrorOaiRequestDelayMs,
    requestTimeoutMs: config.apiTimeoutMs,
  };

  const isResuming = options.mode === 'init' && existing.status === 'in_progress';
  const startToken = isResuming ? existing.resumption_token : undefined;
  const from =
    options.mode === 'refresh' && existing.last_datestamp
      ? existing.last_datestamp
      : isResuming
        ? existing.last_datestamp
        : undefined;

  store.writeHarvestState({
    status: 'in_progress',
    started_at: new Date().toISOString(),
    last_datestamp: existing.last_datestamp,
    resumption_token: startToken,
  });

  let pagesFetched = 0;
  let recordsApplied = 0;
  let tombstonesApplied = 0;
  let lastDatestamp: string | undefined = existing.last_datestamp;
  let lastToken: string | undefined = startToken;

  try {
    for await (const page of harvestPages(startToken, from, harvestOptions, ctx)) {
      store.applyBatch(page.records, page.tombstones);
      pagesFetched += 1;
      recordsApplied += page.records.length;
      tombstonesApplied += page.tombstones.length;

      const pageStamp = pickLatestDatestamp(page);
      if (pageStamp && (!lastDatestamp || pageStamp > lastDatestamp)) lastDatestamp = pageStamp;
      lastToken = page.resumptionToken;

      store.writeHarvestState({
        status: 'in_progress',
        started_at: existing.started_at ?? new Date().toISOString(),
        last_datestamp: lastDatestamp,
        resumption_token: lastToken,
      });

      options.onProgress?.({
        pages: pagesFetched,
        records: recordsApplied,
        tombstones: tombstonesApplied,
        lastDatestamp,
      });
    }

    const totalRecords = store.countPapers();
    store.writeHarvestState({
      status: 'complete',
      started_at: existing.started_at,
      last_datestamp: lastDatestamp,
      completed_at: new Date().toISOString(),
      total_records: totalRecords,
    });

    return { pagesFetched, recordsApplied, tombstonesApplied, totalRecords };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.writeHarvestState({
      status: 'error',
      started_at: existing.started_at,
      last_datestamp: lastDatestamp,
      resumption_token: lastToken,
      error_message: message,
    });
    throw err;
  }
}

/** Convenience accessor for callers that only need the harvest status. */
export async function readHarvestStatus(): Promise<{
  status: 'pending' | 'in_progress' | 'complete' | 'error' | 'unavailable';
  totalRecords?: number;
}> {
  const config = getServerConfig();
  try {
    const store = await openStore(config.mirrorPath);
    const state = store.readHarvestState();
    return {
      status: state.status,
      ...(state.total_records !== undefined && { totalRecords: state.total_records }),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Cast a `MirrorStore` reference for downstream consumers that need typing. */
export type { MirrorStore };
