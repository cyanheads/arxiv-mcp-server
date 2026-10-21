/**
 * @fileoverview Entry of a PDF text-extraction worker (issue #73): extracts the
 * text of the one PDF `extractInWorker` posts to it with the framework's
 * `pdfParser`, and replies with the text or the error the extraction threw. It
 * keeps listening until `extractInWorker` terminates it, so it never exits
 * ahead of its reply.
 *
 * Imports package specifiers only (its relative imports are type-only): under
 * Vitest on Node this entry loads from source through Node's type stripping,
 * which does not resolve a relative `./x.js` to `x.ts`.
 * @module services/arxiv/pdf-text-worker
 */

import { parentPort } from 'node:worker_threads';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { pdfParser } from '@cyanheads/mcp-ts-core/utils';
import type { WireError } from './mirror/index.js';
import type { PdfTextReply } from './pdf-text.js';

if (!parentPort) throw new Error('pdf-text-worker runs only as a worker thread.');
const port = parentPort;

/** The mirror reader's `toWireError`, which this entry cannot import: an error as it crosses the thread. */
function toWireError(error: unknown): WireError {
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

port.on('message', async (bytes: Uint8Array) => {
  let reply: PdfTextReply;
  try {
    const { text } = await pdfParser.extractText(bytes, { mergePages: true });
    reply = { kind: 'text', text: typeof text === 'string' ? text : text.join('\n\n') };
  } catch (error) {
    reply = { kind: 'failed', error: toWireError(error) };
  }
  port.postMessage(reply);
});
