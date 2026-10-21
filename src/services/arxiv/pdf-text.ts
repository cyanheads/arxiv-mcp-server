/**
 * @fileoverview PDF text extraction off the request thread (issue #73). The
 * framework's `pdfParser` runs pdf.js, which is JavaScript: on the thread that
 * calls it, an extraction holds every other request until it ends, and no
 * signal stops it. {@link extractInWorker} runs each extraction in a worker
 * thread of its own, transfers the PDF's bytes to it, and terminates it once
 * the text arrives or the call's signal aborts; terminating interrupts pdf.js
 * mid-document. At most two such workers run at once, since each holds a
 * document's worth of memory; later calls wait their turn. {@link extractInThread}
 * runs the same extraction on the calling thread.
 * @module services/arxiv/pdf-text
 */

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { pdfParser } from '@cyanheads/mcp-ts-core/utils';
import { fromWireError, type WireError } from './mirror/index.js';

/**
 * Extracts a PDF's text, its pages merged into one string. Takes ownership of
 * `bytes`. Once `signal` aborts, the call rejects with its reason.
 */
export type PdfTextExtractor = (
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
) => Promise<string>;

/** What the worker posts back: the text, or the error the extraction threw. */
export type PdfTextReply = { kind: 'text'; text: string } | { error: WireError; kind: 'failed' };

/** Extract on the calling thread. The extraction runs to its end, whatever the signal. */
export const extractInThread: PdfTextExtractor = async (bytes) => {
  const { text } = await pdfParser.extractText(bytes, { mergePages: true });
  return typeof text === 'string' ? text : text.join('\n\n');
};

/** The worker entry beside this module, in its extension: `.ts` from source, `.js` from `dist/`. */
const WORKER_ENTRY = new URL(
  `./pdf-text-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/**
 * How many extraction workers run at once. Each holds its own pdf.js and the
 * document it parses, so memory grows with every extraction running; a call
 * past this waits for a worker to exit.
 */
const MAX_EXTRACTION_WORKERS = 2;
let workersRunning = 0;
/** Calls waiting for a worker, in arrival order. */
const waiting: (() => void)[] = [];

/** A worker has exited: start the call that has waited longest. */
function releaseWorkerSlot(): void {
  workersRunning -= 1;
  waiting.shift()?.();
}

/**
 * Extract in a worker started for this call alone, once fewer than
 * `MAX_EXTRACTION_WORKERS` are running; a call that waits for one still ends
 * when `signal` aborts, and starts no worker. The worker holds the process
 * open only while the call waits on it: it is terminated once its reply
 * arrives or `signal` aborts. A worker that exits or crashes before replying
 * fails the call with `ServiceUnavailable`.
 */
export const extractInWorker: PdfTextExtractor = (bytes, signal) => {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (workersRunning < MAX_EXTRACTION_WORKERS) return extractInNewWorker(bytes, signal);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const start = () => {
    signal.removeEventListener('abort', onAbort);
    extractInNewWorker(bytes, signal).then(resolve, reject);
  };
  const onAbort = () => {
    waiting.splice(waiting.indexOf(start), 1);
    reject(signal.reason);
  };
  waiting.push(start);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
};

/** Start a worker, holding one of the `MAX_EXTRACTION_WORKERS` slots until it exits, and extract in it. */
function extractInNewWorker(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  workersRunning += 1;
  let worker: Worker;
  try {
    worker = new Worker(WORKER_ENTRY);
  } catch (error) {
    releaseWorkerSlot();
    return Promise.reject(error);
  }
  worker.once('exit', releaseWorkerSlot);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let settled = false;
  const settle = (outcome: () => void) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    void worker.terminate();
    outcome();
  };
  const onAbort = () => settle(() => reject(signal.reason));
  signal.addEventListener('abort', onAbort, { once: true });
  worker.on('message', (reply: PdfTextReply) =>
    settle(() =>
      reply.kind === 'text' ? resolve(reply.text) : reject(fromWireError(reply.error)),
    ),
  );
  worker.on('error', (error) =>
    settle(() =>
      reject(
        serviceUnavailable(
          'The PDF text extraction worker failed before replying; retry the read.',
          undefined,
          { cause: error },
        ),
      ),
    ),
  );
  worker.on('exit', (exitCode) =>
    settle(() =>
      reject(
        serviceUnavailable(
          'The PDF text extraction worker stopped before replying; retry the read.',
          {
            exitCode,
          },
        ),
      ),
    ),
  );
  worker.postMessage(bytes, [bytes.buffer]);
  return promise;
}
