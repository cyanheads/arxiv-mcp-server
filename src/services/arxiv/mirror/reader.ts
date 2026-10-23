/**
 * @fileoverview Mirror searches off the request thread (issue #58). The #49
 * match-cap probe and `MirrorStore.search` are synchronous SQLite reads.
 * {@link searchInWorker} runs both in one long-lived reader worker thread with
 * its own query-only connection, so a mirror search holds the request thread
 * no longer than posting the call and receiving its page; searches wait their
 * turn in the worker, one search at a time. {@link searchInThread} runs the
 * same two steps on the calling thread's own store.
 * @module services/arxiv/mirror/reader
 */

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { type JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorReaderOpen, MirrorSearchPage, MirrorStore } from './store.js';

/** What `MirrorStore.search` takes. */
export type MirrorSearchOptions = Parameters<MirrorStore['search']>[0];

/** The mirror a search runs against: its file, and the calling thread's open store for it. */
export interface ReadyMirror {
  path: string;
  store: MirrorStore;
}

/** Why a reader open could not serve the file, as `MirrorStore.openReader` reported it. */
export type MirrorNotReady = Exclude<MirrorReaderOpen, { status: 'open' }>;

/**
 * The probe-then-search answer: a page with its total and whether that total
 * stopped at the match cap (issue #78), or a term at the match cap.
 */
export type WithinCapOutcome = ({ status: 'searched' } & MirrorSearchPage) | { status: 'over_cap' };

/**
 * A mirror search's answer. `not_ready` means the worker's own open found the
 * file unservable, and `open_failed` that it threw, though the calling
 * thread's store had opened the file.
 */
export type MirrorSearchOutcome =
  | WithinCapOutcome
  | { reader: MirrorNotReady; status: 'not_ready' }
  | { error: Error; status: 'open_failed' };

/** Runs one mirror search: the match-cap probe, then the search. */
export type MirrorSearcher = (
  mirror: ReadyMirror,
  options: MirrorSearchOptions,
  signal: AbortSignal,
) => Promise<MirrorSearchOutcome>;

/**
 * Probe, then search — the one place that order lives. A free-text term that
 * reaches the match cap is not searched: the caller answers it from the live
 * API (issue #49). Category- and date-only searches skip the probe.
 */
export function searchWithinCap(
  store: MirrorStore,
  options: MirrorSearchOptions,
): WithinCapOutcome {
  if (options.matchExpr !== undefined && store.matchReachesCap(options.matchExpr)) {
    return { status: 'over_cap' };
  }
  return { status: 'searched', ...store.search(options) };
}

/** Search on the calling thread's own store. The statement runs to its end, whatever the signal. */
export const searchInThread: MirrorSearcher = (mirror, options) =>
  Promise.try(() => searchWithinCap(mirror.store, options));

/**
 * Search in the process's reader worker for `mirror.path`, started by the first
 * search and reused by the ones after it. A cancelled call settles at once with
 * the signal's reason; a call still queued is never posted, and a statement
 * already running finishes in the worker with its reply discarded.
 */
export const searchInWorker: MirrorSearcher = (mirror, options, signal) =>
  Promise.try(() => readerFor(mirror.path).search(options, signal));

/**
 * Terminate the reader worker, failing any search still waiting on it; the next
 * search starts a new one. The returned promise settles once the thread has
 * exited, which waits for a statement already running to end.
 */
export function closeReaderWorker(): Promise<void> {
  return current?.stop((reply) => reply.reject(closedError())) ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Errors across the thread boundary
// ---------------------------------------------------------------------------

/**
 * An error as it crosses from the worker. A posted `Error` keeps only its name,
 * message, and stack, so an `McpError`'s code and data, and any cause, travel
 * here explicitly.
 */
export interface WireError {
  cause?: WireError;
  code?: JsonRpcErrorCode;
  data?: Record<string, unknown>;
  message: string;
  name: string;
  stack?: string;
}

export function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack !== undefined && { stack: error.stack }),
    ...(error instanceof McpError && {
      code: error.code,
      ...(error.data !== undefined && { data: error.data }),
    }),
    ...(error.cause !== undefined && { cause: toWireError(error.cause) }),
  };
}

export function fromWireError(wire: WireError): Error {
  const options = wire.cause === undefined ? undefined : { cause: fromWireError(wire.cause) };
  const error =
    wire.code === undefined
      ? new Error(wire.message, options)
      : new McpError(wire.code, wire.message, wire.data, options);
  error.name = wire.name;
  if (wire.stack !== undefined) error.stack = wire.stack;
  return error;
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

/**
 * What the worker posts: one report on its open, then one reply per search, in
 * the order the searches were posted. A worker whose open did not end in
 * `opened` posts nothing more and exits.
 */
export type ReaderWorkerReply =
  | { kind: 'opened' }
  | { kind: 'not_ready'; reader: MirrorNotReady }
  | { error: WireError; kind: 'open_failed' }
  | { kind: 'result'; outcome: WithinCapOutcome }
  | { error: WireError; kind: 'failed' };

/** The worker entry beside this module, in its extension: `.ts` from source, `.js` from `dist/`. */
const WORKER_ENTRY = new URL(
  `./reader-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

const closedError = () =>
  serviceUnavailable('The mirror reader closed before answering this search; retry it.');

/** A search whose caller may still be waiting. */
interface Waiter {
  /** Settled: by its reply, its signal, or the worker's end. */
  done: boolean;
  readonly onAbort: () => void;
  readonly options: MirrorSearchOptions;
  readonly reply: PromiseWithResolvers<MirrorSearchOutcome>;
  readonly signal: AbortSignal;
}

/** The worker serving one mirror file, and the searches waiting on it. */
class ReaderWorker {
  private readonly worker: Worker;
  private opened = false;
  private stopped: Promise<void> | undefined;
  /** Searches not yet posted, in arrival order. */
  private readonly queue: Waiter[] = [];
  /** The search posted to the worker, until its reply arrives, whether or not its caller still waits. */
  private posted: Waiter | undefined;

  constructor(readonly path: string) {
    this.worker = new Worker(WORKER_ENTRY, { workerData: { path } });
    // Only a waiting caller holds the process open; an idle reader never does.
    this.worker.unref();
    this.worker.on('message', (reply: ReaderWorkerReply) => this.onReply(reply));
    this.worker.on('error', (error) => {
      void this.stop((reply) =>
        reply.reject(
          serviceUnavailable(
            'The mirror reader failed before answering this search; retry it.',
            undefined,
            { cause: error },
          ),
        ),
      );
    });
    this.worker.on('exit', (exitCode) => {
      void this.stop((reply) =>
        reply.reject(
          serviceUnavailable('The mirror reader stopped before answering this search; retry it.', {
            exitCode,
          }),
        ),
      );
    });
  }

  search(options: MirrorSearchOptions, signal: AbortSignal): Promise<MirrorSearchOutcome> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const waiter: Waiter = {
      done: false,
      options,
      reply: Promise.withResolvers(),
      signal,
      onAbort: () => {
        const queued = this.queue.indexOf(waiter);
        if (queued !== -1) this.queue.splice(queued, 1);
        this.settle(waiter, (reply) => reply.reject(signal.reason));
      },
    };
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    this.queue.push(waiter);
    this.pump();
    return waiter.reply.promise;
  }

  /**
   * Retire this worker: settle every search still waiting with `settle`,
   * terminate the thread, and leave the next search to start a new worker.
   * Terminating cannot interrupt a running statement; the thread exits after it.
   */
  stop(settle: (reply: PromiseWithResolvers<MirrorSearchOutcome>) => void): Promise<void> {
    if (this.stopped) return this.stopped;
    if (current === this) current = undefined;
    const waiting = [...(this.posted ? [this.posted] : []), ...this.queue];
    this.posted = undefined;
    this.queue.length = 0;
    // A statement still running holds the thread past `terminate()`; it must not
    // hold the process too.
    this.worker.unref();
    this.stopped = this.worker.terminate().then(() => undefined);
    for (const waiter of waiting) this.settle(waiter, settle);
    return this.stopped;
  }

  private onReply(reply: ReaderWorkerReply): void {
    switch (reply.kind) {
      case 'opened':
        this.opened = true;
        this.pump();
        return;
      case 'not_ready':
        void this.stop((pending) => pending.resolve({ status: 'not_ready', reader: reply.reader }));
        return;
      case 'open_failed': {
        const error = fromWireError(reply.error);
        void this.stop((pending) => pending.resolve({ status: 'open_failed', error }));
        return;
      }
      case 'result':
      case 'failed': {
        const waiter = this.posted;
        this.posted = undefined;
        if (waiter) {
          this.settle(waiter, (pending) =>
            reply.kind === 'result'
              ? pending.resolve(reply.outcome)
              : pending.reject(fromWireError(reply.error)),
          );
        }
        this.pump();
      }
    }
  }

  /** Post the next queued search once the store is open and no statement is running. */
  private pump(): void {
    if (this.opened && !this.posted && !this.stopped) {
      this.posted = this.queue.shift();
      if (this.posted) this.worker.postMessage(this.posted.options);
    }
    this.syncRef();
  }

  /** Settle `waiter` once, and drop its hold on the process. */
  private settle(
    waiter: Waiter,
    settle: (reply: PromiseWithResolvers<MirrorSearchOutcome>) => void,
  ): void {
    if (waiter.done) return;
    waiter.done = true;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    settle(waiter.reply);
    this.syncRef();
  }

  /** Hold the process open while a caller waits on this worker, and only then. */
  private syncRef(): void {
    if (this.stopped) return;
    const waiting = this.queue.length > 0 || (this.posted !== undefined && !this.posted.done);
    if (waiting) this.worker.ref();
    else this.worker.unref();
  }
}

let current: ReaderWorker | undefined;

/** The process's reader worker for `path`, started on first use; a new file retires the old one. */
function readerFor(path: string): ReaderWorker {
  if (current?.path !== path) {
    void current?.stop((reply) => reply.reject(closedError()));
    current = new ReaderWorker(path);
  }
  return current;
}
