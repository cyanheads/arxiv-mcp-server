/**
 * @fileoverview Tests for the mirror reader (issue #58): `searchInWorker` runs
 * the match-cap probe and `MirrorStore.search` in one long-lived worker thread.
 * Covers its lifecycle (started by the first search, reused, never holding the
 * process open, replaced after a crash or a failed open, terminated on close),
 * cancellation, errors crossing the thread, and answers equal to the in-thread
 * search. Workers are real; `node:worker_threads` is wrapped only to record
 * each worker started and each message posted to one.
 * @module services/arxiv/mirror/reader.test
 */

import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { categorySubtree } from '@/services/arxiv/categories.js';
import {
  closeReaderWorker,
  fromWireError,
  type MirrorSearchOptions,
  type ReadyMirror,
  searchInThread,
  searchInWorker,
  toWireError,
} from '@/services/arxiv/mirror/reader.js';
import { MIRROR_SEARCH_MATCH_CAP, MirrorStore } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const tracked = vi.hoisted(() => ({ posts: [] as unknown[], workers: [] as Worker[] }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      tracked.workers.push(this);
    }
    override postMessage(...args: Parameters<Worker['postMessage']>): void {
      tracked.posts.push(args[0]);
      super.postMessage(...args);
    }
  }
  return { ...actual, default: { ...actual, Worker: TrackedWorker }, Worker: TrackedWorker };
});

const mkRecord = (overrides: Partial<ArxivRawRecord> = {}): ArxivRawRecord => ({
  paper_id: '2401.00001',
  identifier: 'oai:arXiv.org:2401.00001',
  datestamp: '2024-01-22',
  title: 'Default title',
  authors: 'Default Author',
  abstract: 'Default abstract.',
  categories: 'cs.LG',
  versions: [{ version: 'v1', date: '2024-01-22T00:00:00Z' }],
  ...overrides,
});

/** Twelve lattice papers across four categories, each submitted and revised on its own day. */
const LATTICE_RECORDS = Array.from({ length: 12 }, (_, i) =>
  mkRecord({
    paper_id: `2402.${String(i).padStart(5, '0')}`,
    title: `Lattice paper ${i}`,
    abstract: i % 3 === 0 ? 'Lattice lattice gauge theory.' : 'A lattice model.',
    categories: ['cs.LG', 'cs.AI', 'math.OC', 'astro-ph.GA'][i % 4] ?? 'cs.LG',
    versions: [
      { version: 'v1', date: `2024-02-${String(i + 1).padStart(2, '0')}T00:00:00Z` },
      { version: 'v2', date: `2024-03-${String(28 - i).padStart(2, '0')}T00:00:00Z` },
    ],
  }),
);

/** Write `count` cs.LG papers whose abstract is `term` straight into the mirror file at `path`. */
function seedBulk(path: string, count: number, term: string): void {
  const db = new Database(path);
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                        categories, published, updated, latest_version)
     SELECT 'bulk.' || i, '1', 'Bulk paper', 'Bulk Author', ?, 'cs.LG', 'cs.LG',
            '2023-06-01T00:00:00.000Z', '2023-06-01T00:00:00.000Z',
            '2023-06-01T00:00:00.000Z'
     FROM n`,
  ).run(count, term);
  db.prepare(
    `INSERT INTO paper_categories(category, paper_id, updated)
     SELECT 'cs.LG', id, updated FROM papers WHERE id LIKE 'bulk.%'`,
  ).run();
  db.close();
}

const page = (overrides: Partial<MirrorSearchOptions> = {}): MirrorSearchOptions => ({
  limit: 5,
  offset: 0,
  sortBy: 'relevance',
  sortOrder: 'descending',
  ...overrides,
});

/** A whole-archive search, run against the bulk mirror. */
const ARCHIVE_SEARCH = page({ categoryGroups: [categorySubtree('cs')], sortBy: 'published' });

const live = () => new AbortController().signal;

/** Settles when `worker` exits. */
const exited = (worker: Worker) =>
  new Promise<void>((resolve) => {
    worker.once('exit', () => resolve());
  });

describe('searchInWorker (#58)', () => {
  let dir: string;
  let small: ReadyMirror;
  let bulk: ReadyMirror;

  // Seeds a corpus the size of the match cap, so its timeout is sized for a loaded machine.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-reader-test-'));
    for (const name of ['small', 'bulk']) {
      const writer = await MirrorStore.open(join(dir, `${name}.db`));
      writer.applyBatch(LATTICE_RECORDS, []);
      writer.close();
    }
    seedBulk(join(dir, 'bulk.db'), MIRROR_SEARCH_MATCH_CAP, 'ubiquitous');
    const open = async (name: string): Promise<ReadyMirror> => {
      const path = join(dir, `${name}.db`);
      const opened = await MirrorStore.openReader(path);
      if (opened.status !== 'open') throw new Error(`${name} mirror did not open`);
      return { path, store: opened.store };
    };
    small = await open('small');
    bulk = await open('bulk');
  }, 30_000);

  afterEach(async () => {
    await closeReaderWorker();
    tracked.posts.length = 0;
  });

  afterAll(async () => {
    small.store.close();
    bulk.store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts one worker on the first search and reuses it for the searches after', async () => {
    const before = tracked.workers.length;
    const first = await searchInWorker(small, page({ matchExpr: 'lattice' }), live());
    expect(tracked.workers.length).toBe(before + 1);
    const second = await searchInWorker(small, page({ matchExpr: 'gauge' }), live());
    const third = await searchInWorker(small, page({ categoryGroups: [['cs.AI']] }), live());

    expect(tracked.workers.length).toBe(before + 1);
    expect(first).toMatchObject({ status: 'searched', total: 12 });
    expect(second).toMatchObject({ status: 'searched', total: 4 });
    expect(third).toMatchObject({ status: 'searched', total: 3 });
    expect(tracked.posts).toHaveLength(3);
  });

  it('answers with the papers, order, and total the in-thread search returns', async () => {
    const cases: [ReadyMirror, MirrorSearchOptions][] = [
      [small, page({ matchExpr: 'lattice', limit: 50 })],
      [small, page({ matchExpr: 'lattice', sortBy: 'published', sortOrder: 'ascending' })],
      [small, page({ matchExpr: 'lattice', sortBy: 'updated', offset: 4 })],
      [small, page({ categoryGroups: [['cs.LG', 'cs.AI']], sortBy: 'published' })],
      [small, page({ categoryGroups: [categorySubtree('cs'), ['cs.AI']] })],
      [small, page({ publishedFrom: '2024-02-03T00:00:00.000Z', sortBy: 'updated' })],
      [small, page({ matchExpr: 'lattice', offset: 100 })],
      [bulk, page({ matchExpr: 'ubiquitous' })],
      [bulk, page({ categoryGroups: [['cs.LG']], offset: 10_000, limit: 3 })],
    ];
    const answers = [];
    for (const [mirror, options] of cases) {
      const viaWorker = await searchInWorker(mirror, options, live());
      expect(viaWorker).toEqual(await searchInThread(mirror, options, live()));
      answers.push(viaWorker);
    }

    expect(answers[0]).toMatchObject({ status: 'searched', total: 12 });
    expect(answers[1]).toMatchObject({ status: 'searched' });
    expect(answers[6]).toEqual({ status: 'searched', papers: [], total: 12 });
    expect(answers[7]).toEqual({ status: 'over_cap' });
    expect(answers[8]).toMatchObject({ status: 'searched', total: MIRROR_SEARCH_MATCH_CAP + 3 });
    const ascending = answers[1]?.status === 'searched' ? answers[1].papers : [];
    expect(ascending).toHaveLength(5);
    expect(ascending.map((p) => p.published)).toEqual(
      [...ascending.map((p) => p.published)].sort(),
    );
  });

  it('carries an fts5 error raised in the worker with its message intact', async () => {
    const malformed = page({ matchExpr: 'title:' });
    const inThread = await searchInThread(small, malformed, live()).catch((err: Error) => err);
    const viaWorker = await searchInWorker(small, malformed, live()).catch((err: Error) => err);

    expect(viaWorker).toBeInstanceOf(Error);
    expect((viaWorker as Error).message).toMatch(/^fts5: /);
    expect((viaWorker as Error).message).toBe((inThread as Error).message);
    expect((viaWorker as Error).name).toBe((inThread as Error).name);
    // The worker survives a failed statement and answers the next search.
    await expect(
      searchInWorker(small, page({ matchExpr: 'gauge' }), live()),
    ).resolves.toMatchObject({ status: 'searched', total: 4 });
  });

  it('answers every search waiting on a failed worker open with the store error, never rejecting, and starts a new worker for the next search', async () => {
    const path = join(dir, 'garbage.db');
    await writeFile(path, 'not a database, only text '.repeat(400));
    const before = tracked.workers.length;
    const outcomes = await Promise.all([
      searchInWorker({ ...small, path }, page(), live()),
      searchInWorker({ ...small, path }, page({ matchExpr: 'lattice' }), live()),
    ]);

    expect(tracked.workers.length).toBe(before + 1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('open_failed');
      const failure = outcome.status === 'open_failed' ? outcome.error : undefined;
      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        message: `Failed to open mirror store at ${path}`,
        data: { path },
      });
      expect(String(failure?.cause)).toMatch(/not a database/);
    }
    expect(tracked.posts).toEqual([]);

    await rm(path);
    (await MirrorStore.open(path)).close();
    await expect(searchInWorker({ ...small, path }, page(), live())).resolves.toEqual({
      status: 'searched',
      papers: [],
      total: 0,
    });
    expect(tracked.workers.length).toBe(before + 2);
  });

  it("reports a file the worker's own open cannot serve as not ready, and keeps no worker for it", async () => {
    const missing = { ...small, path: join(dir, 'absent', 'mirror.db') };
    const before = tracked.workers.length;
    const outcome = await searchInWorker(missing, page(), live());
    await searchInWorker(missing, page(), live());

    expect(outcome).toEqual({ status: 'not_ready', reader: { status: 'missing_file' } });
    expect(tracked.workers.length).toBe(before + 2);
    expect(tracked.posts).toEqual([]);
  });

  it('rejects the search waiting on a worker that dies, and the next search starts a new one', async () => {
    const before = tracked.workers.length;
    const waiting = searchInWorker(small, page({ matchExpr: 'lattice' }), live());
    const worker = tracked.workers.at(-1)!;
    expect(tracked.workers.length).toBe(before + 1);
    // Killed before its open reports, so the search is still waiting on it.
    await worker.terminate();

    await expect(waiting).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The mirror reader stopped before answering this search; retry it.',
    });
    await expect(
      searchInWorker(small, page({ matchExpr: 'lattice' }), live()),
    ).resolves.toMatchObject({ status: 'searched', total: 12 });
    expect(tracked.workers.length).toBe(before + 2);
  });

  it('rejects the search posted to a worker that dies before replying, and the next search starts a new one', async () => {
    await searchInWorker(bulk, page(), live());
    const worker = tracked.workers.at(-1)!;
    const postsBefore = tracked.posts.length;
    let settled = false;
    const posted = searchInWorker(bulk, ARCHIVE_SEARCH, live()).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
      (err: unknown) => {
        settled = true;
        return err;
      },
    );
    // Killed in the same turn the search was posted, so no reply can precede the exit.
    const gone = exited(worker);
    void worker.terminate();
    expect(tracked.posts.slice(postsBefore)).toEqual([ARCHIVE_SEARCH]);
    await gone;

    // Settled by the exit itself: a dead worker never replies.
    expect(settled).toBe(true);
    expect(await posted).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The mirror reader stopped before answering this search; retry it.',
      data: { exitCode: expect.any(Number) },
    });
    await expect(searchInWorker(bulk, page(), live())).resolves.toMatchObject({
      status: 'searched',
      total: MIRROR_SEARCH_MATCH_CAP + 12,
    });
    expect(tracked.workers.at(-1)).not.toBe(worker);
  });

  it('rejects the search waiting on a worker that raises an uncaught error, keeping the error server-side', async () => {
    const before = tracked.workers.length;
    const waiting = searchInWorker(small, page({ matchExpr: 'lattice' }), live()).catch(
      (err: unknown) => err,
    );
    const worker = tracked.workers.at(-1)!;
    expect(tracked.workers.length).toBe(before + 1);
    const crash = new Error('uncaught in the worker');
    // What the thread reports for an exception nothing in the worker caught.
    worker.emit('error', crash);

    const failure = await waiting;
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The mirror reader failed before answering this search; retry it.',
      cause: crash,
    });
    expect((failure as McpError).data).toBeUndefined();
    await expect(
      searchInWorker(small, page({ matchExpr: 'lattice' }), live()),
    ).resolves.toMatchObject({ status: 'searched', total: 12 });
    expect(tracked.workers.length).toBe(before + 2);
  });

  it('starts a new worker after an idle one exits', async () => {
    await searchInWorker(small, page(), live());
    const first = tracked.workers.at(-1)!;
    await first.terminate();
    await searchInWorker(small, page(), live());
    expect(tracked.workers.at(-1)).not.toBe(first);
  });

  it('closes by failing every waiting search and terminating the thread', async () => {
    await searchInWorker(bulk, page(), live());
    const worker = tracked.workers.at(-1)!;
    const running = searchInWorker(bulk, ARCHIVE_SEARCH, live()).catch((err: unknown) => err);
    const queued = searchInWorker(bulk, ARCHIVE_SEARCH, live()).catch((err: unknown) => err);
    const gone = exited(worker);
    await closeReaderWorker();
    await gone;

    const closed = {
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The mirror reader closed before answering this search; retry it.',
    };
    expect(await running).toMatchObject(closed);
    expect(await queued).toMatchObject(closed);
    await searchInWorker(bulk, page(), live());
    expect(tracked.workers.at(-1)).not.toBe(worker);
  });

  describe('cancellation', () => {
    it('settles a cancelled search at once with its reason, leaving the running statement to finish behind it', async () => {
      await searchInWorker(bulk, page(), live());
      const ctrl = new AbortController();
      const order: string[] = [];
      let postsWhenSettled: number | undefined;
      const cancelled = searchInWorker(bulk, ARCHIVE_SEARCH, ctrl.signal).catch((err: unknown) => {
        postsWhenSettled = tracked.posts.length;
        order.push('cancelled');
        return err;
      });
      const next = searchInWorker(bulk, ARCHIVE_SEARCH, live()).then((outcome) => {
        order.push('next');
        return outcome;
      });
      const postsBeforeReply = tracked.posts.length;
      const reason = new Error('caller went away');
      ctrl.abort(reason);

      expect(await cancelled).toBe(reason);
      // Settled before the worker answered: the search queued behind it, posted
      // only once that answer arrives, had not been posted yet.
      expect(postsWhenSettled).toBe(postsBeforeReply);
      // The bulk papers, plus the cs.LG and cs.AI lattice papers.
      expect(await next).toMatchObject({ status: 'searched', total: MIRROR_SEARCH_MATCH_CAP + 6 });
      expect(order).toEqual(['cancelled', 'next']);
      // The cancelled search had been posted; the worker ran it, then the next one.
      expect(tracked.posts.slice(-2)).toEqual([ARCHIVE_SEARCH, ARCHIVE_SEARCH]);
    });

    it('never posts a search cancelled while it waits its turn', async () => {
      await searchInWorker(bulk, page(), live());
      const ctrl = new AbortController();
      const queuedSearch = page({ matchExpr: 'gauge' });
      const running = searchInWorker(bulk, ARCHIVE_SEARCH, live());
      const queued = searchInWorker(bulk, queuedSearch, ctrl.signal).catch((err: unknown) => err);
      const after = searchInWorker(bulk, page({ matchExpr: 'lattice' }), live());
      ctrl.abort('caller went away');

      expect(await queued).toBe('caller went away');
      await expect(running).resolves.toMatchObject({ status: 'searched' });
      await expect(after).resolves.toMatchObject({ status: 'searched', total: 12 });
      expect(tracked.posts).not.toContainEqual(queuedSearch);
      expect(tracked.posts.slice(-2)).toEqual([ARCHIVE_SEARCH, page({ matchExpr: 'lattice' })]);
    });

    it('never queues a search whose signal has already fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort('already gone');
      await expect(searchInWorker(small, page(), ctrl.signal)).rejects.toBe('already gone');
      expect(tracked.posts).toEqual([]);
    });
  });

  it('holds the process open only while a caller waits on the worker', async () => {
    const script = join(dir, 'liveness.ts');
    const source = (file: string) =>
      fileURLToPath(new URL(`../../../../src/services/arxiv/mirror/${file}`, import.meta.url));
    await writeFile(
      script,
      `import { searchInWorker } from ${JSON.stringify(source('reader.ts'))};
       import { MirrorStore } from ${JSON.stringify(source('store.ts'))};
       const path = process.env.MIRROR_PATH;
       const opened = await MirrorStore.openReader(path);
       const mirror = { path, store: opened.store };
       const search = ${JSON.stringify(ARCHIVE_SEARCH)};
       // The worker is up and idle once this answers.
       await searchInWorker(mirror, search, new AbortController().signal);
       // Not awaited: the waiting caller alone must keep the process alive for the answer.
       searchInWorker(mirror, search, new AbortController().signal)
         .then((outcome) => console.log('answered', outcome.status, outcome.total));
       opened.store.close();`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, MIRROR_PATH: bulk.path },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      const stuck = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 20_000);
      child.once('exit', (code) => {
        clearTimeout(stuck);
        resolve(code);
      });
    });

    expect(stdout.trim()).toBe(`answered searched ${MIRROR_SEARCH_MATCH_CAP + 6}`);
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe('errors across the worker boundary', () => {
  it('keeps an McpError’s code, data, and cause', () => {
    const original = new McpError(
      JsonRpcErrorCode.DatabaseError,
      'Failed to open mirror store at /x.db',
      { path: '/x.db' },
      { cause: Object.assign(new Error('file is not a database'), { name: 'SQLiteError' }) },
    );
    const rebuilt = fromWireError(structuredClone(toWireError(original)));

    expect(rebuilt).toBeInstanceOf(McpError);
    expect(rebuilt).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      message: original.message,
      data: { path: '/x.db' },
    });
    expect(rebuilt.cause).toMatchObject({ name: 'SQLiteError', message: 'file is not a database' });
    expect(rebuilt.stack).toBe(original.stack);
  });

  it('keeps a plain error plain, under its own name', () => {
    const original = Object.assign(new Error('fts5: syntax error near ""'), {
      name: 'SQLiteError',
    });
    const rebuilt = fromWireError(structuredClone(toWireError(original)));

    expect(rebuilt).not.toBeInstanceOf(McpError);
    expect(rebuilt).toMatchObject({ name: 'SQLiteError', message: 'fts5: syntax error near ""' });
  });

  it('carries a thrown non-error as its text', () => {
    expect(fromWireError(toWireError('disk I/O error'))).toMatchObject({
      name: 'Error',
      message: 'disk I/O error',
    });
  });
});
