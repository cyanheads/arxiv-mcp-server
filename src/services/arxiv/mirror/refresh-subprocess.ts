/**
 * @fileoverview Off-loads the OAI-PMH mirror refresh into a separate OS process.
 *
 * The harvest's SQLite writes — `applyBatch()` per page plus the closing
 * `SELECT COUNT(*)` — are synchronous and uncancellable (both `bun:sqlite` and
 * `better-sqlite3` are synchronous drivers), so running them on the HTTP
 * server's event loop stalls `arxiv_search_papers` / `arxiv_get_metadata` for the
 * harvest's duration. This module runs the refresh in a child process spawned
 * via `process.execPath`; the child opens its own SQLite connection and does
 * all synchronous work there, while WAL lets the server's reader connection
 * keep serving throughout. See issue #22.
 *
 * Dual role:
 *   - Imported by `src/index.ts` for {@link runRefreshSubprocess} — the parent
 *     spawn helper the in-process HTTP cron calls — and for
 *     {@link schemaUpgradeTrigger}, which starts one run at once when the
 *     server's reader finds the mirror on an older schema.
 *   - Run directly (`<runtime> dist/services/arxiv/mirror/refresh-subprocess.js`)
 *     as the child entry point — the bottom guard runs one refresh and exits.
 *     This is what {@link runRefreshSubprocess} spawns.
 *
 * The child owns its stop (issue #39). `mirrorRefreshTimeoutMs` is the
 * wall-clock budget measured from the child's start; the child stops starting
 * pages once one worst-case page cycle no longer fits inside it, finishes the
 * page in hand, checkpoints, reports `drained` or `partial` on its last stdout
 * line, and exits 0. The next run resumes from that checkpoint. The parent's
 * SIGTERM at the budget, and SIGKILL after {@link SIGKILL_GRACE_MS}, remain
 * only as the backstop for a child that overruns its deadline. A child whose
 * writer open finds another writer migrating the file reports `skipped` and
 * exits 0 having changed nothing (issue #71).
 *
 * @module services/arxiv/mirror/refresh-subprocess
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServerConfig } from '@/config/server-config.js';
import { type HarvestResult, type MirrorLogger, runHarvest } from './runner.js';
import { isMigrationConflict } from './store.js';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

/** Grace period after SIGTERM before escalating to SIGKILL (ms). */
const SIGKILL_GRACE_MS = 30_000;

/** Counts and checkpoint a finished refresh reports. */
export type RefreshCounts = Omit<HarvestResult, 'drained'>;

/**
 * How one scheduled refresh ended without failing: the OAI list `drained`,
 * the run `partial`ly applied it and stopped at its deadline, or the tick was
 * `skipped` — a refresh was already running in this process, or the child
 * found another writer migrating the mirror file and changed nothing.
 */
export type RefreshOutcome =
  | { outcome: 'skipped' }
  | ({ outcome: 'drained' } & RefreshCounts)
  | ({ outcome: 'partial' } & RefreshCounts);

/** `msg` of the child's final stdout line, which carries its {@link RefreshOutcome}. */
const OUTCOME_MSG = 'Mirror refresh outcome';

/**
 * Tracks the in-flight refresh child so overlapping cron ticks (or a tick that
 * fires while a long harvest is still running) don't spawn a second writer.
 */
let activeChild: ChildProcess | undefined;

// ---------------------------------------------------------------------------
// Parent side — spawn + supervise the child
// ---------------------------------------------------------------------------

/**
 * Spawn one incremental mirror refresh in a child process and resolve with its
 * outcome once it exits 0: `drained` (logged at info) or `partial` — stopped at
 * its deadline with a checkpoint the next run resumes from (logged at notice).
 * Resolves `skipped`, with a warning and no spawn, when a refresh is already
 * running, and `skipped` (logged at info) when the child found another writer
 * migrating the mirror file: that writer finishes the upgrade, so the tick is
 * no failure (issue #71).
 *
 * Rejects on spawn failure, a child `error` event, a non-zero exit, a timeout
 * kill, or an exit 0 that reported no outcome, so a harvest that never finished
 * isn't indistinguishable from one that did — `SchedulerService.schedule`
 * catches the rejection and logs the tick as failed without crashing the
 * server. See issue #31.
 *
 * @param opts.timeoutMs - Wall-clock budget. The child stops itself inside it;
 *   one that overruns gets SIGTERM at the budget, then SIGKILL after
 *   {@link SIGKILL_GRACE_MS} — synchronous SQLite can't be interrupted by a
 *   signal mid-statement, so the hard kill is the real backstop.
 * @param opts.log - Logger for lifecycle events and forwarded child output.
 */
export function runRefreshSubprocess(opts: {
  timeoutMs: number;
  log: MirrorLogger;
}): Promise<RefreshOutcome> {
  const { timeoutMs, log } = opts;
  if (activeChild) {
    log.warning?.('Mirror refresh already running; skipping this tick');
    return Promise.resolve({ outcome: 'skipped' });
  }

  const entry = fileURLToPath(new URL('./refresh-subprocess.js', import.meta.url));

  return new Promise<RefreshOutcome>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.error?.('Mirror refresh subprocess failed to spawn', {
        error: err instanceof Error ? err.message : String(err),
      });
      rejectPromise(
        new Error('Mirror refresh subprocess failed to spawn', {
          cause: err,
        }),
      );
      return;
    }

    activeChild = child;
    log.info?.('Mirror refresh subprocess started', { childPid: child.pid, timeoutMs });

    // The child emits one JSON object per stdout line; re-log at the matching
    // level so harvest detail flows through the server's structured logger.
    // Its final line carries the outcome and is kept rather than relayed.
    let reported: RefreshOutcome | undefined;
    forwardLines(child.stdout, (line) => {
      const outcome = parseOutcomeLine(line);
      if (outcome) reported = outcome;
      else relayChildLine(log, line);
    });
    forwardLines(child.stderr, (line) => log.error?.(line));

    let timedOut = false;
    const sigterm = setTimeout(() => {
      timedOut = true;
      log.warning?.('Mirror refresh exceeded timeout; sending SIGTERM', { timeoutMs });
      child.kill('SIGTERM');
    }, timeoutMs);
    const sigkill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.error?.('Mirror refresh did not exit after SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, timeoutMs + SIGKILL_GRACE_MS);

    // A failed spawn can emit both `error` and `close`; the first one decides.
    let settled = false;
    const settle = (result: RefreshOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(sigterm);
      clearTimeout(sigkill);
      activeChild = undefined;
      if (result instanceof Error) rejectPromise(result);
      else resolvePromise(result);
    };

    child.on('error', (err) => {
      log.error?.('Mirror refresh subprocess error', { error: err.message });
      settle(new Error(`Mirror refresh subprocess error: ${err.message}`, { cause: err }));
    });
    // `close`, not `exit`: it fires after the child's stdio has drained, so the
    // outcome line has been read by the time the exit code is.
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        if (!reported) {
          log.error?.('Mirror refresh subprocess exited without reporting an outcome');
          settle(new Error('Mirror refresh subprocess exited 0 without reporting an outcome'));
          return;
        }
        logOutcome(log, reported);
        settle(reported);
        return;
      }
      if (timedOut) {
        log.error?.('Mirror refresh subprocess terminated on timeout', { code, signal });
        settle(
          new Error(
            `Mirror refresh subprocess terminated on timeout after ${timeoutMs}ms (signal ${signal})`,
          ),
        );
        return;
      }
      log.error?.('Mirror refresh subprocess exited non-zero', { code, signal });
      settle(new Error(`Mirror refresh subprocess exited with code ${code} (signal ${signal})`));
    });
  });
}

/**
 * A trigger for the server's reader to call when it finds the mirror on an
 * older schema version (issue #55). The first call made while no refresh is
 * running starts one refresh child, whose writer open migrates the file, so
 * the mirror serves again without waiting for the next cron tick. Every later
 * call does nothing: a run that fails is left to the cron, and a run skipped
 * because another writer is migrating the file leaves the upgrade to that
 * writer. The reader makes no call at all while a writer is migrating the file
 * (issue #71). The run's outcome is logged by {@link runRefreshSubprocess}.
 */
export function schemaUpgradeTrigger(opts: { timeoutMs: number; log: MirrorLogger }): () => void {
  let started = false;
  return () => {
    if (started || activeChild) return;
    started = true;
    opts.log.notice?.('Mirror file has an older schema; starting a refresh to migrate it');
    runRefreshSubprocess(opts).catch(() => undefined);
  };
}

/**
 * Log a refresh the child reported: info when the list drained or another
 * writer's migration skipped it, notice when it stopped at its deadline.
 */
function logOutcome(log: MirrorLogger, reported: RefreshOutcome): void {
  if (reported.outcome === 'skipped') {
    log.info?.('Mirror refresh skipped: another writer is migrating the mirror file');
    return;
  }
  const { outcome, ...counts } = reported;
  if (outcome === 'drained') log.info?.('Mirror refresh drained', counts);
  else log.notice?.('Mirror refresh stopped at its deadline; the next run resumes', counts);
}

/** The outcome carried by the child's final stdout line, or `undefined` for any other line. */
function parseOutcomeLine(line: string): RefreshOutcome | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const { level: _level, msg, ...rest } = parsed as Record<string, unknown>;
  if (msg !== OUTCOME_MSG) return;
  if (rest.outcome === 'skipped') return { outcome: 'skipped' };
  if (rest.outcome !== 'drained' && rest.outcome !== 'partial') return;
  return rest as RefreshOutcome;
}

/** Forward a child stream's complete lines to `sink`, holding a partial tail across chunks. */
function forwardLines(stream: NodeJS.ReadableStream | null, sink: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) sink(line);
  });
  stream.on('end', () => {
    if (buffer.trim()) sink(buffer);
  });
}

/** Re-emit a child stdout line through the parent logger at its original level. */
function relayChildLine(log: MirrorLogger, line: string): void {
  let level: LogLevel = 'info';
  let message = line;
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed && typeof parsed.msg === 'string') {
      message = parsed.msg;
      if (isLogLevel(parsed.level)) level = parsed.level;
      const { level: _level, msg: _msg, ...rest } = parsed;
      if (Object.keys(rest).length > 0) meta = rest;
    }
  } catch {
    // Not JSON (e.g. a raw runtime line) — forward verbatim at info.
  }
  const sink =
    level === 'error'
      ? log.error
      : level === 'warning'
        ? log.warning
        : level === 'notice'
          ? log.notice
          : level === 'debug'
            ? log.debug
            : log.info;
  sink?.(message, meta);
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'notice' ||
    value === 'warning' ||
    value === 'error'
  );
}

// ---------------------------------------------------------------------------
// Child side — run exactly one refresh, then exit
// ---------------------------------------------------------------------------

/**
 * Run one incremental refresh that stops by `deadline` (epoch ms) and report
 * how it ended. A writer open that finds another writer migrating the file
 * (`isMigrationConflict`) is logged at notice and reported `skipped`: the run
 * changed nothing, and that writer finishes the upgrade. Exported for tests;
 * the entry guard below wires signals and the deadline, then calls this.
 */
export async function runRefreshChild(
  log: MirrorLogger,
  signal: AbortSignal,
  deadline: number,
): Promise<RefreshOutcome> {
  try {
    const { drained, ...counts } = await runHarvest({ log, signal }, { mode: 'refresh', deadline });
    return { outcome: drained ? 'drained' : 'partial', ...counts };
  } catch (err) {
    if (!isMigrationConflict(err)) throw err;
    log.notice?.(err.message, err.data);
    return { outcome: 'skipped' };
  }
}

/** One JSON object per line on stdout, for the parent to relay; `done` runs once it is written. */
function emitLine(
  level: LogLevel,
  msg: string,
  meta?: Readonly<Record<string, unknown>>,
  done?: () => void,
): void {
  process.stdout.write(`${JSON.stringify({ level, msg, ...(meta ?? {}) })}\n`, done);
}

/** Logger that emits one JSON object per line on stdout for the parent to relay. */
function makeChildLogger(): MirrorLogger {
  return {
    debug: (m, meta) => emitLine('debug', m, meta),
    info: (m, meta) => emitLine('info', m, meta),
    notice: (m, meta) => emitLine('notice', m, meta),
    warning: (m, meta) => emitLine('warning', m, meta),
    error: (m, meta) => emitLine('error', m, meta),
  };
}

/** True when this module is the process entry point (spawned directly), not an import. */
function isMainEntry(): boolean {
  const entryArg = process.argv[1];
  return entryArg != null && fileURLToPath(import.meta.url) === resolve(entryArg);
}

if (isMainEntry()) {
  const log = makeChildLogger();
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log.warning?.(`Received ${sig}; aborting refresh`);
      controller.abort(new Error(`Aborted by ${sig}`));
    });
  }
  // The budget runs from this process's start, which trails the parent's spawn
  // (and its SIGTERM timer) by only the exec itself.
  const deadline = performance.timeOrigin + getServerConfig().mirrorRefreshTimeoutMs;
  // Each exit waits for its last line to be written: stdout is a pipe, and the
  // parent reads the outcome from it.
  runRefreshChild(log, controller.signal, deadline)
    .then((outcome) => emitLine('info', OUTCOME_MSG, outcome, () => process.exit(0)))
    .catch((err: unknown) => {
      emitLine(
        'error',
        'Mirror refresh failed',
        { error: err instanceof Error ? err.message : String(err) },
        () => process.exit(1),
      );
    });
}
