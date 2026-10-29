/**
 * @fileoverview Additional error-path tests for ArxivService — network errors,
 * content-type edge cases, empty inputs, and ar5iv error handling.
 * @module services/arxiv/arxiv-service-errors.test
 */

import { readFileSync } from 'node:fs';
import type { Worker } from 'node:worker_threads';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { pdfParser } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';
import { extractInThread } from '@/services/arxiv/pdf-text.js';

/**
 * Every PDF extraction worker started, with a promise of its exit. With
 * `killOnPost`, a worker is terminated in the turn its PDF is posted to it, so
 * it dies before it can reply. Workers are real; only their construction and
 * the post are observed.
 */
const tracked = vi.hoisted(() => ({
  killOnPost: false,
  workers: [] as { exited: Promise<number>; worker: Worker }[],
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      tracked.workers.push({
        worker: this,
        exited: new Promise<number>((resolve) => this.once('exit', resolve)),
      });
    }
    override postMessage(...args: Parameters<Worker['postMessage']>): void {
      super.postMessage(...args);
      if (tracked.killOnPost) void this.terminate();
    }
  }
  return { ...actual, default: { ...actual, Worker: TrackedWorker }, Worker: TrackedWorker };
});

/** The config every test reads. Suites that need other values assign them and restore. */
const testConfig = vi.hoisted(() => ({
  apiBaseUrl: 'https://export.arxiv.org/api',
  requestDelayMs: 0,
  contentTimeoutMs: 5000,
  apiTimeoutMs: 5000,
  readTimeoutMs: 50_000,
  mirrorEnabled: false,
  mirrorPath: '',
  mirrorFallbackLive: false,
  mirrorRecentDaysLive: 0,
  mirrorOaiBaseUrl: 'https://oaipmh.arxiv.org/oai',
  mirrorOaiRequestDelayMs: 0,
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => testConfig }));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

const ATOM_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper</title>
    <summary>Abstract text.</summary>
    <author><name>Alice</name></author>
    <arxiv:primary_category term="cs.AI" />
    <category term="cs.AI" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html" />
    <link href="http://arxiv.org/pdf/2401.12345v1" title="pdf" type="application/pdf" />
  </entry>
</feed>`;

const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

function atomResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  // A request no test mocked is refused rather than answered with `undefined`.
  mockFetch.mockImplementation(async (url) => {
    throw new Error(`Unmocked request: ${url}`);
  });
  initArxivService();
  tracked.workers.length = 0;
  tracked.killOnPost = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// search() — additional error paths
// ---------------------------------------------------------------------------

describe('ArxivService.search — error paths', () => {
  it('classifies raw network error as ServiceUnavailable', async () => {
    // withRetry retries non-McpErrors once (maxRetries=1), so provide two rejections.
    const networkErr = Object.assign(new Error('ECONNREFUSED'), { name: 'Error' });
    mockFetch.mockRejectedValueOnce(networkErr).mockRejectedValueOnce(networkErr);

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('classifies 503 as ServiceUnavailable (retryable path)', async () => {
    // Two 503s to exhaust maxRetries=1 (first attempt + one retry).
    mockFetch
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 503,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 503,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('classifies 500 as ServiceUnavailable', async () => {
    // Two 500s — exhaust retry
    mockFetch
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 500,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 500,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  }, 30_000);

  it('classifies unexpected JSON content-type as SerializationError (non-transient)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    // SerializationError is permanent — fetch called exactly once
    await expect(service.search('all:test', {}, ctx)).rejects.toThrow(/unexpected content-type/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries an empty upstream body while the soft-throttle body still fails fast (#30)', async () => {
    // An empty body and a 200 + "Rate exceeded." body reach the same non-XML
    // branch, and only the empty one is a transport symptom. Both halves are
    // asserted together: widening the empty-body classification far enough to
    // swallow the throttle body would reintroduce the retry storm #8 removed.
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const ctx = createMockContext();
    const service = getArxivService();

    const result = await service.search('all:test', {}, ctx);
    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('names the empty-response condition rather than trailing off after a content-type (#30)', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('empty response'),
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('classifies a non-XML 5xx error page by its status, not its content-type (#30)', async () => {
    // A proxy's HTML 502 used to land in the content-type branch and surface as
    // a non-retryable serialization error. Status classification runs first now.
    const badGateway = (): Response =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    mockFetch.mockResolvedValueOnce(badGateway()).mockResolvedValueOnce(badGateway());

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('empty result set does not throw, returns total_results=0', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:nothing_should_match_xyzzy', {}, ctx);
    expect(result.total_results).toBe(0);
    expect(result.papers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPapers() — additional error paths
// ---------------------------------------------------------------------------

describe('ArxivService.getPapers — additional cases', () => {
  it('returns empty papers array when arXiv returns no entries for given IDs', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2312.99999'], ctx);
    expect(result.papers).toHaveLength(0);
    expect(result.not_found).toEqual([{ id: '2312.99999', reason: 'not_in_arxiv' }]);
  });

  it('classifies 400 from getPapers as InvalidRequest', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 400,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(service.getPapers(['malformed!id'], ctx)).rejects.toThrow(/HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies network error in getPapers as ServiceUnavailable', async () => {
    // withRetry retries non-McpErrors once (maxRetries=1), so provide two rejections.
    const networkErr = Object.assign(new Error('ETIMEDOUT'), { name: 'Error' });
    mockFetch.mockRejectedValueOnce(networkErr).mockRejectedValueOnce(networkErr);
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(service.getPapers(['2401.12345'], ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

// ---------------------------------------------------------------------------
// getPapers() — HTTP 5xx on a lookup (#53)
// ---------------------------------------------------------------------------

describe('ArxivService.getPapers — HTTP 5xx on a lookup (#53)', () => {
  /** arXiv's captured HTTP 500 body: an Atom feed holding its internal-error notice. */
  const HTTP_500_BODY = readFileSync(
    new URL('../../fixtures/arxiv-api/http-500.xml', import.meta.url),
    'utf8',
  );
  const status5xx = (status: number): Response =>
    new Response(status === 500 ? HTTP_500_BODY : '<feed/>', {
      status,
      headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
    });
  const rateExceeded = (): Response =>
    new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } });
  const idLists = (): (string | null)[] =>
    mockFetch.mock.calls.map(([request]) => new URL(String(request)).searchParams.get('id_list'));

  it('keeps the single identical retry for a 500 on a lookup holding no old-style pin', async () => {
    // An unversioned old-style ID and a new-style pin are not what arXiv fails on.
    const ids = ['1706.03762', 'hep-th/9901001', '2401.12345v2'];
    mockFetch.mockResolvedValueOnce(status5xx(500)).mockResolvedValueOnce(status5xx(500));

    await expect(getArxivService().getPapers(ids, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'arXiv API returned HTTP 500 (failed after 2 attempts)',
    });
    expect(idLists()).toEqual([ids.join(','), ids.join(',')]);
  }, 30_000);

  it.each([502, 503])(
    'keeps the single identical retry for a %i on a lookup holding an old-style pin',
    async (status) => {
      const ids = ['1706.03762', 'hep-th/9901001v1'];
      mockFetch.mockResolvedValueOnce(status5xx(status)).mockResolvedValueOnce(status5xx(status));

      await expect(getArxivService().getPapers(ids, createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `arXiv API returned HTTP ${status} (failed after 2 attempts)`,
      });
      expect(idLists()).toEqual([ids.join(','), ids.join(',')]);
    },
    30_000,
  );

  it('stays at two requests when the identical retry after a 503 answers 500', async () => {
    mockFetch.mockResolvedValueOnce(status5xx(503)).mockResolvedValueOnce(status5xx(500));

    await expect(
      getArxivService().getPapers(['hep-th/9901001v1'], createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'arXiv API returned HTTP 500 (failed after 2 attempts)',
    });
    expect(idLists()).toEqual(['hep-th/9901001v1', 'hep-th/9901001v1']);
  }, 30_000);

  it.each([
    ['HTTP 500', () => status5xx(500), JsonRpcErrorCode.ServiceUnavailable, 'HTTP 500'],
    ['HTTP 503', () => status5xx(503), JsonRpcErrorCode.ServiceUnavailable, 'HTTP 503'],
    ['a rate limit', rateExceeded, JsonRpcErrorCode.RateLimited, 'rate limit exceeded'],
  ])(
    'fails the call with the unversioned request’s own error when it answers %s',
    async (_label, second, code, text) => {
      mockFetch.mockResolvedValueOnce(status5xx(500)).mockResolvedValueOnce(second());

      const failure = await getArxivService()
        .getPapers(['1706.03762', 'hep-th/9901001v1'], createMockContext())
        .then(
          () => undefined,
          (err: unknown) => err as { code: number; message: string },
        );

      expect(failure?.code).toBe(code);
      expect(failure?.message).toContain(text);
      // Never retried: the unversioned request is the only second request.
      expect(failure?.message).not.toContain('attempts');
      expect(idLists()).toEqual(['1706.03762,hep-th/9901001v1', '1706.03762,hep-th/9901001']);
    },
  );

  it('sends no unversioned request once the caller has cancelled', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('The client cancelled the call.', 'AbortError');
    mockFetch.mockImplementationOnce(async () => {
      controller.abort(cancelled);
      return status5xx(500);
    });

    // The caller's own reason, so its name and message reach the caller unchanged.
    await expect(
      getArxivService().getPapers(
        ['1706.03762', 'hep-th/9901001v1'],
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(cancelled);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// readContent() — ar5iv 500 error path
// ---------------------------------------------------------------------------

describe('ArxivService.readContent — additional error paths', () => {
  it('throws ServiceUnavailable when arxiv.org/html returns 500', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      // Two 500s from arxiv.org/html to exhaust maxRetries=1
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  }, 30_000);

  it('re-raises an ar5iv 500 when the PDF cannot cover for it', async () => {
    // The chain continues past an ar5iv 500 to the PDF, but a paper arXiv
    // serves no PDF for leaves ar5iv's outage as what actually happened —
    // retryable, and not a content_unavailable verdict about a render ar5iv
    // never answered for.
    const attempt = (): Response[] => [
      new Response('Not Found', { status: 404 }), // arxiv.org/html
      new Response('Server Error', { status: 500 }), // ar5iv
      new Response('Not Found', { status: 404 }), // arxiv.org/pdf
    ];
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    // Two attempts — withRetry replays the whole chain once (maxRetries=1).
    for (const response of [...attempt(), ...attempt()]) mockFetch.mockResolvedValueOnce(response);

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('ar5iv'),
    });
    // Both attempts reached the PDF — the 500 no longer ends the chain.
    expect(mockFetch).toHaveBeenCalledTimes(7);
  }, 30_000);

  it('ar5iv 404 falls through to the PDF rung, then notFound — not ServiceUnavailable', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'content_unavailable' },
    });
  });

  it('returns correct source label "ar5iv" when falling back', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<article><p>ar5iv content</p></article>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('ar5iv');
    expect(result.content).toContain('ar5iv content');
  });

  it('returns correct source label "arxiv_html" when first source succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<article><p>native content</p></article>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('arxiv_html');
    expect(result.content).toContain('native content');
  });

  it('content is not truncated when body fits within max_characters', async () => {
    const body = 'a'.repeat(50);
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(`<article>${body}</article>`));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 200 }, ctx);

    expect(result.truncated).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Stalled bodies (#70) and one deadline for the whole read (#69), on a fake clock
// ---------------------------------------------------------------------------

/** The timeouts a default deployment runs with. */
const SHIPPED_TIMEOUTS = {
  requestDelayMs: 3000,
  apiTimeoutMs: 15_000,
  contentTimeoutMs: 30_000,
  readTimeoutMs: 50_000,
};

/** The request timeout of MCP SDK clients that set none of their own. */
const CLIENT_REQUEST_TIMEOUT_MS = 60_000;

/** How a read that ran out of time names itself, before it says what was pending. */
const DEADLINE_PREFIX = "Reading arXiv paper '2401.12345' timed out after 50000ms; ";

/**
 * Put every clock a read runs on — each request's timeout, the read's deadline,
 * `withRetry`'s backoff, the API queue's etiquette delay — on vitest's fake
 * `setTimeout`. `AbortSignal.timeout` runs on a timer vitest cannot fake, so it
 * is replaced with one that aborts with the same `TimeoutError` on the fake clock.
 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      ms,
    );
    return controller.signal;
  });
}

interface Settled<T> {
  /** Fake milliseconds from the call to its settling (or to the give-up point). */
  elapsedMs: number;
  error?: unknown;
  settled: boolean;
  value?: T;
}

/** Drive `call` on the fake clock until it settles or `limitMs` of fake time has passed. */
async function settle<T>(call: () => Promise<T>, limitMs = 150_000): Promise<Settled<T>> {
  const startedAt = Date.now();
  const outcome: Settled<T> = { settled: false, elapsedMs: 0 };
  call().then(
    (value) => Object.assign(outcome, { settled: true, value, elapsedMs: Date.now() - startedAt }),
    (error: unknown) =>
      Object.assign(outcome, { settled: true, error, elapsedMs: Date.now() - startedAt }),
  );
  while (!outcome.settled && Date.now() - startedAt < limitMs) {
    await vi.advanceTimersByTimeAsync(100);
    // A real turn of the event loop for the work no timer drives (PDF text extraction).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!outcome.settled) outcome.elapsedMs = Date.now() - startedAt;
  return outcome;
}

/** Fail with `signal`'s reason once it aborts, as `fetch` does for a request or body in flight. */
function onAbort(signal: AbortSignal | null | undefined, fail: (reason: unknown) => void): void {
  if (!signal) return;
  if (signal.aborted) fail(signal.reason);
  else signal.addEventListener('abort', () => fail(signal.reason), { once: true });
}

/** A response whose headers arrive and whose body sends `head`, then nothing until the request is aborted. */
function stalledResponse(
  signal: AbortSignal | null | undefined,
  status: number,
  contentType: string,
  head: string,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      onAbort(signal, (reason) => controller.error(reason));
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** A response whose body sends `head` and then drops, as a reset connection does mid-body. */
function droppedResponse(contentType: string, head: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

/** A minimal single-page PDF carrying `text`; an empty string makes an image-only page. */
function pdfResponse(text: string): Response {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
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
  return new Response(new TextEncoder().encode(pdf), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

/** A parseable PDF of `pages` pages of text: long enough that its extraction is still running a few turns after it starts. */
function bookPdfBytes(pages: number): Uint8Array {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const kids: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const stream = Array.from(
      { length: 20 },
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

/** A PDF response that calls `onRead` once its whole body has been read, the moment extraction can begin. */
function watchedPdfResponse(bytes: Uint8Array, onRead: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
      controller.close();
      onRead();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } });
}

/** Let pending work run, without moving the fake clock, until `done()` holds. */
async function untilTrue(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; !done(); turn += 1) {
    if (turn === 10_000) throw new Error(`Never happened: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Host = 'api' | 'html' | 'ar5iv' | 'pdf';

/**
 * How a host answers: hangs before its headers, stalls after them, has no copy
 * (404; a 307 on ar5iv), is down (503), serves a copy holding none of the paper
 * (an empty article; an image-only PDF), serves the paper, or (the PDF host
 * only) serves a file the PDF parser cannot read.
 */
type HostBehavior = 'hang' | 'stall' | 'miss' | '503' | 'placeholder' | 'ok' | 'unparseable';

const MATRIX_BEHAVIORS = ['hang', 'stall', 'miss', '503', 'placeholder'] as const;

/** A file that starts like a PDF and has none of its structure: the PDF parser rejects it. */
const UNPARSEABLE_PDF = '%PDF-1.4\nnot a document\n%%EOF\n';

const SECTIONED_PAGE =
  '<html><body><article class="ltx_document"><h2 class="ltx_title ltx_title_section">1 Introduction</h2><p class="ltx_p">Paper text.</p></article></body></html>';

function answer(
  host: Host,
  behavior: HostBehavior,
  signal: AbortSignal | null | undefined,
): Promise<Response> | Response {
  const contentType =
    host === 'api' ? 'application/atom+xml' : host === 'pdf' ? 'application/pdf' : 'text/html';
  switch (behavior) {
    case 'hang':
      return new Promise<Response>((_resolve, reject) => onAbort(signal, reject));
    case 'stall':
      return stalledResponse(signal, 200, contentType, host === 'pdf' ? '%PDF-1.4\n' : '<');
    case 'miss':
      return host === 'ar5iv'
        ? new Response(null, {
            status: 307,
            headers: { location: 'https://arxiv.org/abs/2401.12345v1' },
          })
        : new Response('Not Found', { status: 404 });
    case '503':
      return new Response('Service Unavailable', { status: 503 });
    case 'placeholder':
      return host === 'pdf'
        ? pdfResponse('')
        : htmlResponse('<html><body><article class="ltx_document"></article></body></html>');
    case 'ok':
      if (host === 'api') return atomResponse(ATOM_SINGLE);
      return host === 'pdf' ? pdfResponse('served from the PDF') : htmlResponse(SECTIONED_PAGE);
    case 'unparseable':
      return new Response(new TextEncoder().encode(UNPARSEABLE_PDF), {
        status: 200,
        headers: { 'content-type': contentType },
      });
  }
}

type Answer =
  | HostBehavior
  | ((signal: AbortSignal | null | undefined) => Promise<Response> | Response);

/** The host a request went to, told apart by hostname and, on arxiv.org, by path. */
function hostOf(request: string): Host {
  const url = new URL(request);
  if (url.hostname === 'export.arxiv.org') return 'api';
  if (url.hostname === 'ar5iv.labs.arxiv.org') return 'ar5iv';
  if (url.hostname === 'arxiv.org' && url.pathname.startsWith('/html/')) return 'html';
  if (url.hostname === 'arxiv.org' && url.pathname.startsWith('/pdf/')) return 'pdf';
  throw new Error(`Unmocked request: ${request}`);
}

/** Answer every request by host; the API serves one paper unless told otherwise. */
function stubHosts(hosts: Partial<Record<Host, Answer>>): void {
  mockFetch.mockImplementation(async (request, init) => {
    const host = hostOf(String(request));
    const behavior = hosts[host] ?? (host === 'api' ? 'ok' : undefined);
    if (behavior === undefined) throw new Error(`Unmocked request: ${request}`);
    return typeof behavior === 'function'
      ? behavior(init?.signal)
      : answer(host, behavior, init?.signal);
  });
}

/** The hosts requested so far, in order. */
const requestedHosts = (): Host[] =>
  mockFetch.mock.calls.map(([request]) => hostOf(String(request)));

/** Let pending work run, without moving the fake clock, until `count` requests have gone out. */
async function untilRequested(count: number): Promise<void> {
  for (let turn = 0; mockFetch.mock.calls.length < count; turn += 1) {
    if (turn === 1000) throw new Error(`Only ${mockFetch.mock.calls.length} requests went out`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const readPaper = () => getArxivService().readContent('2401.12345', {}, createMockContext());

describe('fake clock suites', () => {
  let saved: typeof testConfig;

  beforeAll(async () => {
    // Load the PDF parser on the real clock, so no test's fake time pays for it.
    await pdfParser.extractText(new Uint8Array(await pdfResponse('warm').arrayBuffer()), {
      mergePages: true,
    });
  });

  beforeEach(() => {
    saved = { ...testConfig };
    Object.assign(testConfig, SHIPPED_TIMEOUTS);
    useFakeClock();
    // A worker's reply arrives on the real clock, which these tests do not move.
    initArxivService({ pdfTextExtractor: extractInThread });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(testConfig, saved);
  });

  describe('ArxivService — a body that stalls after its headers (#70)', () => {
    beforeEach(() => {
      testConfig.contentTimeoutMs = 2000;
    });

    it.each([
      ['ar5iv stalls after its headers and the PDF hangs', 'stall', 'hang', 4000],
      ['ar5iv has no render and the PDF stalls after its headers', 'miss', 'stall', 2000],
      ['ar5iv has no render and the PDF hangs before its headers', 'miss', 'hang', 2000],
    ] as const)(
      'fails once with the classified Timeout when %s',
      async (_label, ar5iv, pdf, ms) => {
        stubHosts({ html: 'miss', ar5iv, pdf });

        const read = await settle(readPaper);

        expect(read.error).toBeInstanceOf(McpError);
        expect(read.error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          message: 'arXiv PDF timed out after 2000ms',
        });
        // The ar5iv stall was held while the PDF was tried, and nothing was replayed.
        expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
        expect(read.elapsedMs).toBe(ms);
      },
    );

    it('fails with Timeout, never replayed, when arxiv.org/html stalls after its headers', async () => {
      stubHosts({ html: 'stall' });

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'arxiv.org HTML timed out after 2000ms',
        data: { paperId: '2401.12345v1', timeoutMs: 2000 },
      });
      expect(requestedHosts()).toEqual(['api', 'html']);
      expect(read.elapsedMs).toBe(2000);
    });

    it('holds an ar5iv stall and serves the paper from the PDF', async () => {
      stubHosts({ html: 'miss', ar5iv: 'stall', pdf: 'ok' });

      const read = await settle(readPaper);

      expect(read.error).toBeUndefined();
      expect(read.value).toMatchObject({ source: 'pdf_text' });
      expect(read.value?.content).toContain('served from the PDF');
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
    });

    it('re-raises the held ar5iv stall when the PDF cannot cover for it', async () => {
      stubHosts({ html: 'miss', ar5iv: 'stall', pdf: 'miss' });

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'ar5iv timed out after 2000ms',
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
      expect(read.elapsedMs).toBe(2000);
    });

    it.each([
      ['arxiv.org/html', { html: 503 }, ['api', 'html'], 'arxiv.org HTML timed out after 2000ms'],
      [
        'ar5iv',
        { html: 'miss', ar5iv: 503, pdf: 'miss' },
        ['api', 'html', 'ar5iv', 'pdf'],
        'ar5iv timed out after 2000ms',
      ],
      [
        'the PDF host',
        { html: 'miss', ar5iv: 'miss', pdf: 503 },
        ['api', 'html', 'ar5iv', 'pdf'],
        'arXiv PDF timed out after 2000ms',
      ],
    ] as const)(
      'fails with Timeout, never replayed, when %s answers 503 and its error body stalls',
      async (_label, statuses, hosts, message) => {
        const stub: Partial<Record<Host, Answer>> = {};
        for (const [host, status] of Object.entries(statuses) as [Host, HostBehavior | number][]) {
          stub[host] =
            typeof status === 'number'
              ? (signal) => stalledResponse(signal, status, 'text/html', '<')
              : status;
        }
        stubHosts(stub);

        const read = await settle(readPaper);

        expect(read.error).toMatchObject({ code: JsonRpcErrorCode.Timeout, message });
        expect(requestedHosts()).toEqual(hosts);
        expect(read.elapsedMs).toBe(2000);
      },
    );

    it('classifies an API body that drops mid-read as a network error', async () => {
      stubHosts({ api: () => droppedResponse('application/atom+xml', '<?xml') });

      const read = await settle(readPaper);

      // A network error is retried once, as one before the headers is.
      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'arXiv API network error (failed after 2 attempts)',
      });
      expect(requestedHosts()).toEqual(['api', 'api']);
    });

    it('fails a read whose metadata body stalls with Timeout, sending one request', async () => {
      stubHosts({ api: 'stall' });

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'arXiv API timed out after 15000ms',
      });
      expect(requestedHosts()).toEqual(['api']);
      expect(read.elapsedMs).toBe(15_000);
    });

    it.each<[string, () => Promise<unknown>]>([
      ['search', () => getArxivService().search('all:test', {}, createMockContext())],
      ['getPapers', () => getArxivService().getPapers(['2401.12345'], createMockContext())],
    ])('fails a %s whose API body stalls with Timeout, sending one request', async (_l, call) => {
      stubHosts({ api: 'stall' });

      const outcome = await settle(call);

      expect(outcome.error).toBeInstanceOf(McpError);
      expect(outcome.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'arXiv API timed out after 15000ms',
      });
      expect(requestedHosts()).toEqual(['api']);
      expect(outcome.elapsedMs).toBe(15_000);
    });

    it('fails as cancelled, trying nothing more, when the caller cancels during a stalled body', async () => {
      stubHosts({ html: 'miss', ar5iv: 'stall', pdf: 'ok' });
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The client cancelled the call.', 'AbortError')),
        1000,
      );

      const read = await settle(() =>
        getArxivService().readContent(
          '2401.12345',
          {},
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(read.error).toMatchObject({
        name: 'AbortError',
        message: 'The client cancelled the call.',
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv']);
      expect(read.elapsedMs).toBe(1000);
    });

    it('fails as cancelled, never as a Timeout, when the caller cancels during the backoff', async () => {
      stubHosts({ html: '503' });
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The client cancelled the call.', 'AbortError')),
        1000,
      );

      const read = await settle(() =>
        getArxivService().readContent(
          '2401.12345',
          {},
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(read.error).toMatchObject({
        name: 'AbortError',
        message: 'The client cancelled the call.',
      });
      expect(requestedHosts()).toEqual(['api', 'html']);
      expect(read.elapsedMs).toBe(1000);
    });

    it('reports a call cancelled during a stalled body as cancelled on both surfaces', async () => {
      stubHosts({ html: 'stall' });
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The client cancelled the call.', 'AbortError')),
        1000,
      );

      const call = await settle(() =>
        runToolContract(
          arxivReadPaper,
          { paper_id: '2401.12345' },
          { context: { signal: controller.signal } },
        ),
      );

      const result = call.value;
      if (!result) throw new Error('arxiv_read_paper did not settle');
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.message).toBe('The client cancelled the call.');
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('The client cancelled the call.');
      expect(requestedHosts()).toEqual(['api', 'html']);
    });
  });

  describe('ArxivService.readContent — one deadline for the whole read (#69)', () => {
    it('runs on the timeouts the server ships with', async () => {
      const actual = await vi.importActual<typeof import('@/config/server-config.js')>(
        '@/config/server-config.js',
      );
      actual.resetServerConfig();
      expect(actual.getServerConfig()).toMatchObject(SHIPPED_TIMEOUTS);
    });

    it('settles at the deadline with Timeout when ar5iv and the PDF both hang', async () => {
      stubHosts({ html: 'miss', ar5iv: 'hang', pdf: 'hang' });

      const read = await settle(readPaper);

      expect(read.error).toBeInstanceOf(McpError);
      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}the request to arXiv PDF was still open.`,
        data: { paperId: '2401.12345', timeoutMs: 50_000 },
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
      expect(read.elapsedMs).toBe(50_000);
    });

    it('stops the replay at the deadline when ar5iv hangs and the PDF answers 503', async () => {
      stubHosts({ html: 'miss', ar5iv: 'hang', pdf: '503' });

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}the request to ar5iv was still open.`,
      });
      // The replay ran on the time left, and the deadline ended it inside ar5iv.
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf', 'html', 'ar5iv']);
      expect(read.elapsedMs).toBe(50_000);
    });

    it('settles every combination of hung, stalled, absent, unavailable, and placeholder hosts, and an unparseable PDF, by the deadline', async () => {
      const { Timeout, ServiceUnavailable, NotFound } = JsonRpcErrorCode;
      const slow = (behavior: HostBehavior) => behavior === 'hang' || behavior === 'stall';
      /**
       * What each combination fails with, and when: a slow rung times out at the
       * content timeout (an ar5iv one is held for the PDF), a 503 is replayed once
       * after a 1.5–2.5 s backoff, and an ar5iv timeout followed by a slow or
       * unavailable PDF runs into the deadline. A PDF the parser cannot read ends
       * the chain as an image-only one does (#81).
       */
      const expected = (
        html: HostBehavior,
        ar5iv: HostBehavior,
        pdf: HostBehavior,
      ): [code: number, ms: number | 'backoff', reason?: string] => {
        if (slow(html)) return [Timeout, 30_000];
        if (html === '503') return [ServiceUnavailable, 'backoff'];
        if (slow(ar5iv)) return slow(pdf) || pdf === '503' ? [Timeout, 50_000] : [Timeout, 30_000];
        if (slow(pdf)) return [Timeout, 30_000];
        if (ar5iv === '503' || pdf === '503') return [ServiceUnavailable, 'backoff'];
        return [NotFound, 0, pdf === 'miss' ? 'content_unavailable' : 'pdf_extraction_failed'];
      };

      let combinations = 0;
      for (const html of MATRIX_BEHAVIORS) {
        for (const ar5iv of MATRIX_BEHAVIORS) {
          for (const pdf of [...MATRIX_BEHAVIORS, 'unparseable'] as const) {
            mockFetch.mockClear();
            initArxivService({ pdfTextExtractor: extractInThread });
            stubHosts({ html, ar5iv, pdf });
            const read = await settle(readPaper);
            const label = `${html}/${ar5iv}/${pdf}`;
            const [code, ms, reason] = expected(html, ar5iv, pdf);

            expect(read.settled, label).toBe(true);
            expect(read.error, label).toBeInstanceOf(McpError);
            expect((read.error as McpError).code, label).toBe(code);
            if (reason) expect((read.error as McpError).data?.reason, label).toBe(reason);
            if (ms === 'backoff') {
              expect(read.elapsedMs, label).toBeGreaterThanOrEqual(1500);
              expect(read.elapsedMs, label).toBeLessThanOrEqual(2500);
            } else {
              expect(read.elapsedMs, label).toBe(ms);
            }
            expect(read.elapsedMs, label).toBeLessThanOrEqual(SHIPPED_TIMEOUTS.readTimeoutMs);
            combinations += 1;
          }
        }
      }
      expect(combinations).toBe(150);
    }, 180_000);

    it('fails with the deadline, not pdf_extraction_failed, when the extraction it cut short rejects as unparseable', async () => {
      stubHosts({ html: 'miss', ar5iv: 'miss', pdf: 'ok' });
      // An extraction that answers the deadline's abort with the parser's own failure.
      initArxivService({
        pdfTextExtractor: (_bytes, signal) =>
          new Promise<string>((_resolve, reject) =>
            onAbort(signal, () =>
              reject(
                new McpError(
                  JsonRpcErrorCode.ValidationError,
                  'Failed to extract text from PDF: Invalid PDF structure.',
                  { reason: 'pdf_text_extract_failed' },
                ),
              ),
            ),
          ),
      });

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}its PDF text extraction had not finished.`,
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
      expect(read.elapsedMs).toBe(50_000);
    });

    it('serves a healthy read with its two requests and leaves nothing behind to fire', async () => {
      stubHosts({ html: 'ok' });

      const read = await settle(readPaper);

      expect(read.error).toBeUndefined();
      expect(read.value).toMatchObject({ source: 'arxiv_html' });
      expect(requestedHosts()).toEqual(['api', 'html']);
      expect(read.elapsedMs).toBe(0);
      await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
      expect(requestedHosts()).toEqual(['api', 'html']);
    });

    it('counts the wait for the API queue against the deadline', async () => {
      // Four searches ahead of the read, each hanging to the API timeout and then
      // waiting out the etiquette delay, hold the queue for 72 s.
      stubHosts({ api: 'hang', html: 'ok' });
      const service = getArxivService();
      const searches = Array.from({ length: 4 }, () =>
        service.search('all:test', {}, createMockContext()).catch(() => undefined),
      );
      await untilRequested(1);

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}its arXiv API lookup had not finished.`,
      });
      // The read's turn never came: only the searches' requests went out.
      expect(requestedHosts()).toEqual(['api', 'api', 'api']);
      expect(read.elapsedMs).toBe(50_000);
      await settle(() => Promise.all(searches));
    });

    it('fails a read cancelled while it waits for the API queue at once', async () => {
      stubHosts({ api: 'hang', html: 'ok' });
      const service = getArxivService();
      const search = service.search('all:test', {}, createMockContext()).catch(() => undefined);
      await untilRequested(1);
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The client cancelled the call.', 'AbortError')),
        1000,
      );

      const read = await settle(() =>
        service.readContent('2401.12345', {}, createMockContext({ signal: controller.signal })),
      );

      expect(read.error).toMatchObject({
        name: 'AbortError',
        message: 'The client cancelled the call.',
      });
      expect(read.elapsedMs).toBe(1000);
      await settle(() => search);
      // Its slot was skipped: the read never sent its lookup.
      expect(requestedHosts()).toEqual(['api']);
    });

    it('ends a backoff before the replay at the deadline', async () => {
      // One hung search holds the queue for 18 s; ar5iv then hangs to 48 s, and
      // the PDF's 503 asks for a backoff that would end past the deadline.
      vi.spyOn(Math, 'random').mockReturnValue(0.99);
      let apiRequests = 0;
      stubHosts({
        api: (signal) => {
          apiRequests += 1;
          return answer('api', apiRequests === 1 ? 'hang' : 'ok', signal);
        },
        html: 'miss',
        ar5iv: 'hang',
        pdf: '503',
      });
      const service = getArxivService();
      const search = service.search('all:test', {}, createMockContext()).catch(() => undefined);
      await untilRequested(1);

      const read = await settle(readPaper);

      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}it was waiting to retry its content requests.`,
      });
      expect(requestedHosts()).toEqual(['api', 'api', 'html', 'ar5iv', 'pdf']);
      expect(read.elapsedMs).toBe(50_000);
      await settle(() => search);
    });

    it('reports the deadline as a Timeout on both surfaces of arxiv_read_paper', async () => {
      stubHosts({ html: 'miss', ar5iv: 'hang', pdf: 'hang' });

      const call = await settle(() => runToolContract(arxivReadPaper, { paper_id: '2401.12345' }));

      const result = call.value;
      if (!result) throw new Error('arxiv_read_paper did not settle');
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toBe(`${DEADLINE_PREFIX}the request to arXiv PDF was still open.`);
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain(error.message);
      expect(text).not.toContain('not retryable');
      expect(call.elapsedMs).toBe(50_000);
    });

    /**
     * Read with the PDF as the only rung that serves, its extraction in a
     * worker, and let the deadline pass mid-extraction: no fake time passes
     * until the PDF has been read and its extraction has begun.
     */
    async function readPastTheDeadlineDuringExtraction(read: () => Promise<unknown>) {
      let pdfRead = false;
      stubHosts({
        html: 'miss',
        ar5iv: 'miss',
        pdf: () =>
          watchedPdfResponse(bookPdfBytes(300), () => {
            pdfRead = true;
          }),
      });
      const outcome: { error?: unknown; settled: boolean; value?: unknown } = { settled: false };
      const done = read().then(
        (value) => Object.assign(outcome, { settled: true, value }),
        (error: unknown) => Object.assign(outcome, { settled: true, error }),
      );
      await untilTrue(() => pdfRead, 'the PDF was read');
      // The turn the extraction starts in.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(SHIPPED_TIMEOUTS.readTimeoutMs);
      await done;
      return outcome;
    }

    it('ends an extraction that outlasts the deadline with Timeout naming it, never replayed (#73)', async () => {
      initArxivService();

      const read = await readPastTheDeadlineDuringExtraction(readPaper);

      expect(read.value).toBeUndefined();
      expect(read.error).toBeInstanceOf(McpError);
      expect(read.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `${DEADLINE_PREFIX}its PDF text extraction had not finished.`,
        data: { paperId: '2401.12345', timeoutMs: 50_000 },
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
      // The worker the extraction ran in is gone with it.
      expect(tracked.workers).toHaveLength(1);
      await tracked.workers[0]?.exited;
    });

    it('reports an extraction past the deadline as a Timeout on both surfaces of arxiv_read_paper (#73)', async () => {
      initArxivService();

      const call = await readPastTheDeadlineDuringExtraction(() =>
        runToolContract(arxivReadPaper, { paper_id: '2401.12345' }),
      );

      const result = call.value as Awaited<ReturnType<typeof runToolContract>> | undefined;
      if (!result) throw new Error('arxiv_read_paper did not settle with a result');
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toBe(`${DEADLINE_PREFIX}its PDF text extraction had not finished.`);
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain(error.message);
      await tracked.workers[0]?.exited;
    });
  });
});

// ---------------------------------------------------------------------------
// PDF text extraction in a worker thread (#73); the workers run on the real clock
// ---------------------------------------------------------------------------

describe('ArxivService.readContent — PDF text extraction in a worker (#73)', () => {
  const CANCELLED = 'The client cancelled the call.';

  /** Serve the PDF as the only rung with a render, and cancel `controller` once its extraction is under way. */
  function cancelDuringExtraction(controller: AbortController): void {
    stubHosts({
      html: 'miss',
      ar5iv: 'miss',
      pdf: () =>
        watchedPdfResponse(bookPdfBytes(300), () =>
          // Two turns on: the read has handed the PDF to its extraction.
          setImmediate(() =>
            setImmediate(() => controller.abort(new DOMException(CANCELLED, 'AbortError'))),
          ),
        ),
    });
  }

  it('fails as cancelled when the caller cancels during extraction, ending its worker', async () => {
    const controller = new AbortController();
    cancelDuringExtraction(controller);

    const outcome = await getArxivService()
      .readContent('2401.12345', {}, createMockContext({ signal: controller.signal }))
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

    expect(outcome).toEqual({ error: expect.objectContaining({ name: 'AbortError' }) });
    expect((outcome as { error: Error }).error.message).toBe(CANCELLED);
    expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
    expect(tracked.workers).toHaveLength(1);
    await tracked.workers[0]?.exited;
  });

  it('reports a read cancelled during extraction as cancelled on both surfaces', async () => {
    const controller = new AbortController();
    cancelDuringExtraction(controller);

    const result = await runToolContract(
      arxivReadPaper,
      { paper_id: '2401.12345' },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.message).toBe(CANCELLED);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(CANCELLED);
    // The cancellation landed once the extraction had its worker.
    expect(tracked.workers).toHaveLength(1);
    await tracked.workers[0]?.exited;
  });

  it('fails with ServiceUnavailable, after one replay, when its worker dies before replying', async () => {
    tracked.killOnPost = true;
    stubHosts({ html: 'miss', ar5iv: 'miss', pdf: () => pdfResponse('never extracted') });
    // Each worker dies on the real clock; the backoff before the replay runs on a fake one.
    useFakeClock();
    try {
      const read = readPaper().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      await untilTrue(() => tracked.workers.length === 1, 'the first extraction started');
      await tracked.workers[0]?.exited;
      // The longest backoff before the replay: 2 s, ±25% jitter.
      await vi.advanceTimersByTimeAsync(2500);
      await untilTrue(() => tracked.workers.length === 2, 'the replay started its extraction');
      await tracked.workers[1]?.exited;
      const outcome = await read;

      expect(outcome).toEqual({ error: expect.any(McpError) });
      expect((outcome as { error: McpError }).error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message:
          'The PDF text extraction worker stopped before replying; retry the read. (failed after 2 attempts)',
        data: { exitCode: expect.any(Number) },
      });
      expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf', 'html', 'ar5iv', 'pdf']);
      expect(tracked.workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// A PDF the parser cannot read, through the tool (#81); real workers, real clock
// ---------------------------------------------------------------------------

describe('arxiv_read_paper — a PDF the parser cannot read (#81)', () => {
  interface WireError {
    code: number;
    data: {
      paperId?: string;
      pdfUrl?: string;
      reason?: string;
      recovery?: { hint: string };
      retryable?: boolean;
    };
    message: string;
  }

  const contract = arxivReadPaper.errors?.find((e) => e.reason === 'pdf_extraction_failed');

  async function readThroughTool() {
    const result = await runToolContract(arxivReadPaper, { paper_id: '2401.12345' });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: WireError }).error;
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { error, text };
  }

  it('declares one entry for both causes, with a recovery that fits each', () => {
    expect(contract).toMatchObject({ code: JsonRpcErrorCode.NotFound, severity: 'notice' });
    expect(contract).not.toHaveProperty('retryable', true);
    expect(contract?.when).toContain('no text layer');
    expect(contract?.when).toContain('cannot read');
    expect(contract?.recovery).toContain('arxiv_get_metadata');
    expect(contract?.recovery).toContain('error.data.pdfUrl');
    // OCR is offered for the image-only cause alone, beside a remedy for the unparseable one.
    expect(contract?.recovery).toContain('optical character recognition for an image-only PDF');
    expect(contract?.recovery).toContain('a PDF repair tool for one that does not parse');
  });

  it('puts pdf_extraction_failed, its recovery, paperId, and pdfUrl on both surfaces', async () => {
    stubHosts({ html: 'miss', ar5iv: 'miss', pdf: 'unparseable' });

    const { error, text } = await readThroughTool();

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      "Paper '2401.12345v1' has no HTML render, and its PDF could not be parsed — the file arXiv served is damaged, truncated, or not a PDF. Download it at http://arxiv.org/pdf/2401.12345v1.",
    );
    expect(error.data).toMatchObject({
      reason: 'pdf_extraction_failed',
      paperId: '2401.12345v1',
      pdfUrl: 'http://arxiv.org/pdf/2401.12345v1',
      recovery: { hint: contract?.recovery },
    });
    expect(error.data.retryable).not.toBe(true);
    expect(text).toContain(error.message);
    expect(text).toContain(contract?.recovery ?? '<missing>');
    expect(text).toContain('pdf_extraction_failed');
    expect(text).not.toContain('pdf_text_extract_failed');
    expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
  });

  it('gives a PDF with no text layer the same reason and recovery under its own message', async () => {
    stubHosts({ html: 'miss', ar5iv: 'miss', pdf: 'placeholder' });

    const { error, text } = await readThroughTool();

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      "Paper '2401.12345v1' has no HTML render, and its PDF yielded no extractable text — the file is image-only (scanned) or carries no text layer. Download it at http://arxiv.org/pdf/2401.12345v1.",
    );
    expect(error.data).toMatchObject({
      reason: 'pdf_extraction_failed',
      recovery: { hint: contract?.recovery },
    });
    expect(text).toContain(contract?.recovery ?? '<missing>');
    expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf']);
  });

  it('reports a held ar5iv outage ahead of an unparseable PDF on both surfaces, after one replay', async () => {
    stubHosts({ html: 'miss', ar5iv: '503', pdf: 'unparseable' });

    const { error, text } = await readThroughTool();

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('ar5iv returned HTTP 503. (failed after 2 attempts)');
    expect(error.data.reason).toBeUndefined();
    expect(text).toContain(error.message);
    expect(text).not.toContain(contract?.recovery ?? '<missing>');
    expect(requestedHosts()).toEqual(['api', 'html', 'ar5iv', 'pdf', 'html', 'ar5iv', 'pdf']);
  }, 30_000);
});
