/**
 * @fileoverview Off-loads the OAI-PMH mirror refresh into a separate OS process.
 *
 * The harvest's SQLite writes — `applyBatch()` per page plus the closing
 * `SELECT COUNT(*)` — are synchronous and uncancellable (both `bun:sqlite` and
 * `better-sqlite3` are synchronous drivers), so running them on the HTTP
 * server's event loop stalls `arxiv_search` / `arxiv_get_metadata` for the
 * harvest's duration. This module runs the refresh in a child process spawned
 * via `process.execPath`; the child opens its own SQLite connection and does
 * all synchronous work there, while WAL lets the server's reader connection
 * keep serving throughout. See issue #22.
 *
 * Dual role:
 *   - Imported by `src/index.ts` for {@link runRefreshSubprocess} — the parent
 *     spawn helper the in-process HTTP cron calls.
 *   - Run directly (`<runtime> dist/services/arxiv/mirror/refresh-subprocess.js`)
 *     as the child entry point — the bottom guard runs one refresh and exits.
 *     This is what {@link runRefreshSubprocess} spawns.
 *
 * @module services/arxiv/mirror/refresh-subprocess
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServerConfig } from '@/config/server-config.js';
import { type MirrorLogger, runHarvest } from './runner.js';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

/** Grace period after SIGTERM before escalating to SIGKILL (ms). */
const SIGKILL_GRACE_MS = 30_000;

/**
 * Tracks the in-flight refresh child so overlapping cron ticks (or a tick that
 * fires while a long harvest is still running) don't spawn a second writer.
 */
let activeChild: ChildProcess | undefined;

// ---------------------------------------------------------------------------
// Parent side — spawn + supervise the child
// ---------------------------------------------------------------------------

/**
 * Spawn one incremental mirror refresh in a child process and resolve when it
 * exits. Never rejects — a failed harvest is logged and swallowed so a cron
 * tick can't crash the server. A no-op (with a warning) when a refresh is
 * already running.
 *
 * @param opts.timeoutMs - Wall-clock budget. On overrun the child gets SIGTERM,
 *   then SIGKILL after {@link SIGKILL_GRACE_MS} — synchronous SQLite can't be
 *   interrupted by a signal mid-statement, so the hard kill is the real backstop.
 * @param opts.log - Logger for lifecycle events and forwarded child output.
 */
export function runRefreshSubprocess(opts: {
  timeoutMs: number;
  log: MirrorLogger;
}): Promise<void> {
  const { timeoutMs, log } = opts;
  if (activeChild) {
    log.warning?.('Mirror refresh already running; skipping this tick');
    return Promise.resolve();
  }

  const entry = fileURLToPath(new URL('./refresh-subprocess.js', import.meta.url));

  return new Promise<void>((resolvePromise) => {
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
      resolvePromise();
      return;
    }

    activeChild = child;
    log.info?.('Mirror refresh subprocess started', { pid: child.pid, timeoutMs });

    // The child emits one JSON object per stdout line; re-log at the matching
    // level so harvest detail flows through the server's structured logger.
    forwardLines(child.stdout, (line) => relayChildLine(log, line));
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

    const settle = () => {
      clearTimeout(sigterm);
      clearTimeout(sigkill);
      activeChild = undefined;
      resolvePromise();
    };

    child.on('error', (err) => {
      log.error?.('Mirror refresh subprocess error', { error: err.message });
      settle();
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        log.info?.('Mirror refresh subprocess completed', { code });
      } else if (timedOut) {
        log.error?.('Mirror refresh subprocess terminated on timeout', { code, signal });
      } else {
        log.error?.('Mirror refresh subprocess exited non-zero', { code, signal });
      }
      settle();
    });
  });
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
 * Run one incremental refresh with the given logger and cancellation. Exported
 * for tests; the entry guard below wires signals + the timeout and calls this.
 */
export async function runRefreshChild(log: MirrorLogger, signal: AbortSignal): Promise<void> {
  const result = await runHarvest({ log, signal }, { mode: 'refresh' });
  log.info?.('Mirror refresh complete', result);
}

/** Logger that emits one JSON object per line on stdout for the parent to relay. */
function makeChildLogger(): MirrorLogger {
  const emit = (level: LogLevel, msg: string, meta?: object): void => {
    process.stdout.write(`${JSON.stringify({ level, msg, ...(meta ?? {}) })}\n`);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    notice: (m, meta) => emit('notice', m, meta),
    warning: (m, meta) => emit('warning', m, meta),
    error: (m, meta) => emit('error', m, meta),
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
  // Self-timeout for a standalone `mirror:refresh` invocation; when spawned by
  // runRefreshSubprocess the parent's SIGTERM/SIGKILL watchdog also applies.
  const timer = setTimeout(
    () => controller.abort(new Error('Refresh timeout')),
    getServerConfig().mirrorRefreshTimeoutMs,
  );
  runRefreshChild(log, controller.signal)
    .then(() => {
      clearTimeout(timer);
      process.exit(0);
    })
    .catch((err: unknown) => {
      clearTimeout(timer);
      log.error?.('Mirror refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
