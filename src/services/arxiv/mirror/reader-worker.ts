/**
 * @fileoverview Entry of the mirror reader worker (issue #58). Opens its own
 * query-only connection to the mirror file named in `workerData.path` through
 * `MirrorStore.openReader`, reports the open, then answers each search
 * `searchInWorker` posts with {@link searchWithinCap}, one at a time. A worker
 * whose open did not succeed reports why and exits.
 * @module services/arxiv/mirror/reader-worker
 */

import { parentPort, workerData } from 'node:worker_threads';
import {
  type MirrorSearchOptions,
  type ReaderWorkerReply,
  searchWithinCap,
  toWireError,
} from './reader.js';
import { MirrorStore } from './store.js';

if (!parentPort) throw new Error('reader-worker runs only as a worker thread.');
const port = parentPort;
const { path } = workerData as { path: string };
const reply = (message: ReaderWorkerReply) => port.postMessage(message);

try {
  const opened = await MirrorStore.openReader(path);
  if (opened.status === 'open') {
    const { store } = opened;
    port.on('message', (options: MirrorSearchOptions) => {
      try {
        reply({ kind: 'result', outcome: searchWithinCap(store, options) });
      } catch (error) {
        reply({ kind: 'failed', error: toWireError(error) });
      }
    });
    reply({ kind: 'opened' });
  } else {
    reply({ kind: 'not_ready', reader: opened });
  }
} catch (error) {
  reply({ kind: 'open_failed', error: toWireError(error) });
}
