/**
 * @fileoverview Tests for PDF text extraction off the request thread (issue
 * #73): `extractInWorker` runs each extraction in a worker thread of its own.
 * Covers the text against the in-thread extraction, the transfer of the bytes,
 * termination on reply, on abort, and before start, the bound on workers
 * running at once and the order queued calls start in, a worker that dies or
 * crashes before replying, and extraction errors crossing the thread. Workers
 * are real; `node:worker_threads` is wrapped only to record each worker
 * started, its reply, and its exit.
 * @module services/arxiv/pdf-text.test
 */

import type { Worker } from 'node:worker_threads';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractInThread, extractInWorker, type PdfTextReply } from '@/services/arxiv/pdf-text.js';

const tracked = vi.hoisted(() => ({
  /** Workers started and not yet exited, and the most there have been at once. */
  alive: 0,
  mostAlive: 0,
  /** Every worker started, in order, with the text of its reply once it has one. */
  workers: [] as { exited: Promise<number>; replies: number; text?: string; worker: Worker }[],
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      tracked.alive += 1;
      tracked.mostAlive = Math.max(tracked.mostAlive, tracked.alive);
      const entry: (typeof tracked.workers)[number] = {
        worker: this,
        replies: 0,
        exited: new Promise<number>((resolve) =>
          this.once('exit', (code) => {
            tracked.alive -= 1;
            resolve(code);
          }),
        ),
      };
      this.on('message', (reply: PdfTextReply) => {
        entry.replies += 1;
        if (reply.kind === 'text') entry.text = reply.text;
      });
      tracked.workers.push(entry);
    }
  }
  return { ...actual, default: { ...actual, Worker: TrackedWorker }, Worker: TrackedWorker };
});

/** A parseable PDF of `pages` pages, each holding `lines` lines that name their page. */
function pdfBytes(pages: number, lines = 1): Uint8Array<ArrayBuffer> {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const kids: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const stream = Array.from(
      { length: lines },
      (_, line) => `BT /F1 10 Tf 40 ${760 - line * 18} Td (Page ${page} line ${line}) Tj ET`,
    ).join('\n');
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${objects.length} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** A page with no text layer, as a scanned PDF has. */
function imageOnlyPdfBytes(): Uint8Array<ArrayBuffer> {
  return pdfBytes(1, 0);
}

const live = () => new AbortController().signal;

beforeEach(() => {
  tracked.workers.length = 0;
  tracked.mostAlive = 0;
});

// A worker still exiting holds one of the two slots, so each test starts with none running.
afterEach(async () => {
  await Promise.all(tracked.workers.map(({ exited }) => exited));
});

describe('extractInWorker (#73)', () => {
  it('returns the text the in-thread extraction returns, every page merged in order', async () => {
    const inThread = await extractInThread(pdfBytes(5, 3), live());

    const inWorker = await extractInWorker(pdfBytes(5, 3), live());

    expect(inWorker).toBe(inThread);
    expect(inWorker.indexOf('Page 5 line 2')).toBeGreaterThan(inWorker.indexOf('Page 1 line 0'));
    expect(inWorker.indexOf('Page 1 line 0')).toBeGreaterThanOrEqual(0);
  });

  it('returns the empty text of a page with no text layer, as the in-thread extraction does', async () => {
    const inThread = await extractInThread(imageOnlyPdfBytes(), live());

    await expect(extractInWorker(imageOnlyPdfBytes(), live())).resolves.toBe(inThread);
    expect(inThread.trim()).toBe('');
  });

  it('hands the bytes to the worker rather than copying them, and ends the worker once it replies', async () => {
    const bytes = pdfBytes(2);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const text = extractInWorker(bytes, live());

    // Transferred: the caller's view is detached the moment the PDF is posted.
    expect(bytes.byteLength).toBe(0);
    await expect(text).resolves.toContain('Page 2 line 0');
    expect(tracked.workers).toHaveLength(1);
    await tracked.workers[0]?.exited;
  });

  it('starts one worker per extraction', async () => {
    const texts = await Promise.all([
      extractInWorker(pdfBytes(1), live()),
      extractInWorker(pdfBytes(2), live()),
    ]);

    expect(texts[1]).toContain('Page 2 line 0');
    expect(texts[0]).not.toContain('Page 2');
    expect(tracked.workers).toHaveLength(2);
    expect(tracked.workers[0]?.worker).not.toBe(tracked.workers[1]?.worker);
    await Promise.all(tracked.workers.map(({ exited }) => exited));
  });

  it('runs at most two extractions at once, starting each queued one in arrival order as a worker exits', async () => {
    const texts = await Promise.all(
      [1, 2, 3, 4, 5].map((pages) => extractInWorker(pdfBytes(pages), live())),
    );

    texts.forEach((text, i) => {
      expect(text).toContain(`Page ${i + 1} line 0`);
    });
    expect(tracked.workers).toHaveLength(5);
    expect(tracked.mostAlive).toBe(2);
    // The nth worker started ran the nth call's PDF.
    expect(tracked.workers.map(({ text }) => text)).toEqual(texts);
    await Promise.all(tracked.workers.map(({ exited }) => exited));
  }, 30_000);

  it('rejects a queued extraction whose signal aborts with its reason, starting no worker for it', async () => {
    const running = [extractInWorker(pdfBytes(1), live()), extractInWorker(pdfBytes(2), live())];
    const controller = new AbortController();
    const queued = extractInWorker(pdfBytes(1), controller.signal);
    controller.abort('gave up waiting');

    await expect(queued).rejects.toBe('gave up waiting');
    await Promise.all(running);
    await Promise.all(tracked.workers.map(({ exited }) => exited));
    expect(tracked.workers).toHaveLength(2);
  });

  it('rejects at once with the reason of a signal that aborts before the reply, ending its worker', async () => {
    const controller = new AbortController();
    const reason = new Error('caller went away');
    const text = extractInWorker(pdfBytes(300, 20), controller.signal);
    // The PDF is posted; the worker has not had a turn to answer.
    controller.abort(reason);

    await expect(text).rejects.toBe(reason);
    expect(tracked.workers).toHaveLength(1);
    await tracked.workers[0]?.exited;
    // Terminated mid-extraction: the worker never got as far as replying.
    expect(tracked.workers[0]?.replies).toBe(0);
  });

  it('starts no worker for a signal that has already aborted', async () => {
    const controller = new AbortController();
    controller.abort('already gone');

    await expect(extractInWorker(pdfBytes(1), controller.signal)).rejects.toBe('already gone');
    expect(tracked.workers).toHaveLength(0);
  });

  it('fails with ServiceUnavailable when its worker exits before replying', async () => {
    const text = extractInWorker(pdfBytes(300, 20), live()).catch((err: unknown) => err);
    const started = tracked.workers[0];
    // Killed in the turn the PDF was posted, so no reply can precede the exit.
    void started?.worker.terminate();

    const failure = await text;
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The PDF text extraction worker stopped before replying; retry the read.',
      data: { exitCode: expect.any(Number) },
    });
    // The next extraction gets a worker of its own.
    await expect(extractInWorker(pdfBytes(1), live())).resolves.toContain('Page 1 line 0');
    expect(tracked.workers).toHaveLength(2);
  });

  it('fails with ServiceUnavailable, keeping the error server-side, when its worker raises an uncaught error', async () => {
    const text = extractInWorker(pdfBytes(300, 20), live()).catch((err: unknown) => err);
    const crash = new Error('uncaught in the worker');
    // What the thread reports for an exception nothing in the worker caught.
    tracked.workers[0]?.worker.emit('error', crash);

    const failure = await text;
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The PDF text extraction worker failed before replying; retry the read.',
      cause: crash,
    });
    expect((failure as McpError).data).toBeUndefined();
    await tracked.workers[0]?.exited;
  });

  it('carries the error pdf.js raises for a malformed PDF across the thread, as the in-thread extraction raises it', async () => {
    const malformed = () => new TextEncoder().encode('%PDF-1.4\nnot a document\n%%EOF\n');
    const inThread = await extractInThread(malformed(), live()).catch((err: unknown) => err);

    const inWorker = await extractInWorker(malformed(), live()).catch((err: unknown) => err);

    expect(inThread).toBeInstanceOf(McpError);
    expect(inWorker).toBeInstanceOf(McpError);
    const shape = (err: unknown) => {
      const { code, message, data, cause } = err as McpError & { cause: Error };
      return { code, message, data, cause: { name: cause.name, message: cause.message } };
    };
    expect(shape(inWorker)).toEqual(shape(inThread));
    // pdf.js names bytes it cannot read InvalidPDFException, which the parser raises as ValidationError.
    expect(inWorker).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to extract text from PDF: Invalid PDF structure.',
      data: { reason: 'pdf_text_extract_failed' },
    });
    await tracked.workers[0]?.exited;
  });
});
