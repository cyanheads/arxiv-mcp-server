/**
 * @fileoverview Mirror harvest runner — orchestrates harvester + store for
 * full init and incremental refresh. Provides shared progress reporting and
 * persistence of harvest state.
 * @module services/arxiv/mirror/runner
 */

import { getServerConfig } from '@/config/server-config.js';
import {
  type HarvesterOptions,
  harvestPages,
  pickLatestDatestamp,
  worstCasePageFetchMs,
} from './harvester.js';
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
  /**
   * `true` when the OAI list ran out and `complete` was written; `false` when
   * the run stopped at its deadline, leaving an `in_progress` checkpoint the
   * next run resumes from.
   */
  drained: boolean;
  /** Latest OAI datestamp applied so far (`YYYY-MM-DD`). */
  lastDatestamp?: string | undefined;
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
 * Run a harvest cycle.
 *
 * Where it starts: a previous run that stopped before draining (`in_progress`
 * or `error` with a saved resumption token) resumes from that token, which
 * carries the position inside its datestamp. Otherwise a refresh, or an init
 * after an interrupted one, starts at `from=last_datestamp` (OAI `from` is
 * inclusive, so the boundary day is re-read), and an init with no checkpoint
 * harvests from the beginning. A rejected token falls back to the datestamp
 * checkpoint inside the harvester, once per checkpoint: a second rejection
 * before the checkpoint advances fails the run (issue #59).
 *
 * Before the first page it ensures the write-path index on
 * `paper_categories(paper_id)` (issue #50).
 *
 * Persists `harvest_state` after every page; `complete` (with `completed_at`)
 * is written only when the list drains. With `deadline`, the run stops after a
 * whole page once one worst-case page cycle no longer fits before it (issue
 * #39).
 *
 * A token is an offset into a list arXiv recomputes on every request, so one
 * resumed after arXiv re-modified a record it had already returned skips a
 * record. A write therefore keeps the token only while the checkpoint is still
 * on the datestamp the run started on, and only when the run stopped at its
 * deadline there or had itself resumed a saved token: inside a datestamp one
 * run could not clear. Every other write stores none, and the next run
 * restarts at the checkpoint (issue #62).
 *
 * An `init` run waits out an upstream outage and re-sends the same request
 * (`HarvesterOptions.waitOutOutages`, issue #61); a refresh fails once a page
 * exhausts its retries. A cancelled `ctx.signal` always ends the run as a
 * failure, never as a deadline stop, and ends an outage wait at once.
 *
 * @param options.deadline - Epoch ms the run must have ended by.
 */
export async function runHarvest(
  ctx: MirrorRunnerContext,
  options: { deadline?: number; mode: 'init' | 'refresh'; onProgress?: ProgressCallback },
): Promise<HarvestResult> {
  const config = getServerConfig();
  const store = await openStore(config.mirrorPath);
  store.ensureWriteIndex();
  const existing = store.readHarvestState();

  const harvestOptions: HarvesterOptions = {
    baseUrl: config.mirrorOaiBaseUrl,
    requestDelayMs: config.mirrorOaiRequestDelayMs,
    requestTimeoutMs: config.apiTimeoutMs,
    waitOutOutages: options.mode === 'init',
  };

  const interrupted = existing.status === 'in_progress' || existing.status === 'error';
  const startToken = interrupted ? existing.resumption_token : undefined;
  const from = options.mode === 'refresh' || interrupted ? existing.last_datestamp : undefined;
  const startedAt = new Date().toISOString();

  store.writeHarvestState({
    status: 'in_progress',
    started_at: startedAt,
    last_datestamp: existing.last_datestamp,
    resumption_token: startToken,
  });

  let pagesFetched = 0;
  let recordsApplied = 0;
  let tombstonesApplied = 0;
  let lastDatestamp: string | undefined = existing.last_datestamp;
  let lastToken: string | undefined = startToken;
  let drained = true;
  /** The token a write keeps for a later run, or none (issue #62; see above). */
  const tokenToKeep = (atDeadline: boolean): string | undefined =>
    lastDatestamp === existing.last_datestamp && (atDeadline || startToken !== undefined)
      ? lastToken
      : undefined;
  // One page cycle: the fetch at its worst plus the slowest apply seen so far.
  const fetchReserveMs = worstCasePageFetchMs(harvestOptions);
  let slowestApplyMs = 0;

  try {
    for await (const page of harvestPages(startToken, from, harvestOptions, ctx)) {
      const applyStart = performance.now();
      store.applyBatch(page.records, page.tombstones);
      slowestApplyMs = Math.max(slowestApplyMs, performance.now() - applyStart);
      pagesFetched += 1;
      recordsApplied += page.records.length;
      tombstonesApplied += page.tombstones.length;

      const pageStamp = pickLatestDatestamp(page);
      if (pageStamp && (!lastDatestamp || pageStamp > lastDatestamp)) lastDatestamp = pageStamp;
      lastToken = page.resumptionToken;
      const atDeadline =
        lastToken !== undefined &&
        options.deadline !== undefined &&
        Date.now() + fetchReserveMs + slowestApplyMs > options.deadline;

      store.writeHarvestState({
        status: 'in_progress',
        started_at: startedAt,
        last_datestamp: lastDatestamp,
        resumption_token: tokenToKeep(atDeadline),
      });

      options.onProgress?.({
        pages: pagesFetched,
        records: recordsApplied,
        tombstones: tombstonesApplied,
        lastDatestamp,
      });

      // A signal that fired during the synchronous apply is only seen here.
      ctx.signal.throwIfAborted();
      if (atDeadline) {
        drained = false;
        break;
      }
    }

    const totalRecords = store.countPapers();
    if (drained) {
      store.writeHarvestState({
        status: 'complete',
        started_at: startedAt,
        last_datestamp: lastDatestamp,
        completed_at: new Date().toISOString(),
        total_records: totalRecords,
      });
    }

    return {
      drained,
      lastDatestamp,
      pagesFetched,
      recordsApplied,
      tombstonesApplied,
      totalRecords,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.writeHarvestState({
      status: 'error',
      started_at: startedAt,
      last_datestamp: lastDatestamp,
      resumption_token: tokenToKeep(false),
      error_message: message,
    });
    throw err;
  }
}

/** Cast a `MirrorStore` reference for downstream consumers that need typing. */
export type { MirrorStore };
