/**
 * @fileoverview Tests for ArxivService — search, metadata lookup, and HTML content fetching.
 * Mocks fetch globally and uses zero request delay for fast tests.
 * @module services/arxiv/arxiv-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';
import { PaperMetadataSchema } from '@/services/arxiv/types.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
  }),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATOM_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper Title</title>
    <summary>Test abstract.</summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <arxiv:primary_category term="cs.AI" />
    <category term="cs.AI" />
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html" />
    <link href="http://arxiv.org/pdf/2401.12345v1" title="pdf" type="application/pdf" />
    <arxiv:comment>10 pages</arxiv:comment>
  </entry>
</feed>`;

const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

// Sparse entry: omits arxiv:comment, arxiv:journal_ref, arxiv:doi,
// arxiv:primary_category, and link elements entirely.
const ATOM_SPARSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.99999v1</id>
    <title>Sparse Paper</title>
    <summary>Minimal abstract.</summary>
    <author><name>Single Author</name></author>
    <category term="cs.AI" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
  </entry>
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  initArxivService();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('ArxivService.search', () => {
  it('parses search results from Atom feed', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:testing', {}, ctx);

    expect(result.total_results).toBe(1);
    expect(result.start).toBe(0);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      id: '2401.12345v1',
      title: 'Test Paper Title',
      abstract: 'Test abstract.',
      authors: ['Alice', 'Bob'],
      primary_category: 'cs.AI',
      categories: ['cs.AI', 'cs.LG'],
      comment: '10 pages',
    });
  });

  it('sends a descriptive User-Agent identifying this client to arXiv', async () => {
    // arXiv community convention (cf. arxiv.py): include a UA so operators can
    // identify and contact maintainers if a client misbehaves.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:test', {}, ctx);

    const init = mockFetch.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['user-agent']).toMatch(/arxiv-mcp-server/);
    expect(headers['user-agent']).toMatch(/github\.com\/cyanheads\/arxiv-mcp-server/);
  });

  it('builds URL with correct query params', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('ti:attention', { maxResults: 5, sortBy: 'submitted', start: 10 }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/query');
    expect(url.searchParams.get('search_query')).toBe('ti:attention');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(url.searchParams.get('start')).toBe('10');
  });

  it('appends category filter to query with user query wrapped in parens', async () => {
    // Parens scope AND to the whole expression, not just the last bare token —
    // prevents "mixture of experts AND cat:cs.CL" from leaking across categories.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:testing', { category: 'cs.AI' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(all:testing) AND cat:cs.AI');
  });

  // Issue #20: the echo is the string that actually went on the wire. Before the
  // fix the handler echoed the raw input query, so a category filter vanished
  // from the reported query while still shaping the results.
  it('returns the wire query as effective_query, category wrapper included', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:testing', { category: 'cs.AI' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(result.effective_query).toBe(url.searchParams.get('search_query'));
    expect(result.effective_query).toBe('(all:testing) AND cat:cs.AI');
  });

  // Issue #20 acceptance: replaying the echo as the bare query, with no filter
  // options at all, has to reach arXiv as the identical search_query — otherwise
  // a caller replaying it gets a different result set than was reported.
  it('replays effective_query to the identical wire query (category + date window)', async () => {
    // Fresh Response per call — a shared one throws ERR_BODY_ALREADY_USED.
    mockFetch.mockImplementation(async () => atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();

    const first = await service.search(
      'all:transformer',
      { category: 'cs.CL', submittedFrom: '2020-01-01', submittedTo: '2020-01-31' },
      ctx,
    );
    await service.search(first.effective_query, {}, ctx);

    const originalQuery = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get(
      'search_query',
    );
    const replayedQuery = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get(
      'search_query',
    );
    expect(replayedQuery).toBe(originalQuery);
    expect(originalQuery).toBe(
      '(all:transformer) AND cat:cs.CL AND submittedDate:[202001010000 TO 202002010000]',
    );
  });

  // Issue #32: a bare archive code has to reach the whole subtree. `cat:astro-ph`
  // alone is only the 105,380 legacy flat papers, not the 388,854-paper archive.
  it('wildcards a bare archive code to its subtree', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('dark matter', { category: 'astro-ph' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(dark matter) AND cat:astro-ph*');
  });

  // Issue #32: `cat:math*` also prefix-matches math-ph, a physics archive with
  // 91,063 papers of its own. The spelled-out subtree keeps it out.
  it('avoids the math / math-ph prefix collision', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('manifold', { category: 'math' }, ctx);

    const searchQuery = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get(
      'search_query',
    );
    expect(searchQuery).toBe('(manifold) AND (cat:math.* OR cat:math)');
    expect(searchQuery).not.toContain('cat:math*');
  });

  it('keeps a leaf code an exact match', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('folding', { category: 'q-bio.BM' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(folding) AND cat:q-bio.BM');
  });

  it('accepts bare archive and group codes that used to be rejected', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    for (const category of ['astro-ph', 'cond-mat', 'cs', 'econ', 'q-fin', 'physics']) {
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      await expect(service.search('anything', { category }, ctx)).resolves.toBeDefined();
    }
  });

  // Issue #27 — the date window reaches arXiv as a submittedDate clause, and the
  // upper bound is midnight of the day AFTER submitted_to. A same-day 2359 bound
  // would drop that day's last 59 seconds: arXiv compares the bound against the
  // full-precision submission timestamp, not a minute bucket.
  it('folds an inclusive date window into the wire query', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search(
      'all:transformer',
      { submittedFrom: '2020-01-01', submittedTo: '2020-01-31' },
      ctx,
    );

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe(
      '(all:transformer) AND submittedDate:[202001010000 TO 202002010000]',
    );
  });

  it('substitutes a sentinel for an omitted bound so the range stays well-formed', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:transformer', { submittedFrom: '2020-01-01' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe(
      '(all:transformer) AND submittedDate:[202001010000 TO 300001010000]',
    );
  });

  it('emits adjacent windows that meet at one instant, leaving no gap', async () => {
    // Fresh Response per call — a shared one throws ERR_BODY_ALREADY_USED.
    mockFetch.mockImplementation(async () => atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('q', { submittedFrom: '2020-01-01', submittedTo: '2020-01-15' }, ctx);
    await service.search('q', { submittedFrom: '2020-01-16', submittedTo: '2020-01-31' }, ctx);

    const first = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get('search_query');
    const second = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get('search_query');
    expect(first).toContain('TO 202001160000]');
    expect(second).toContain('submittedDate:[202001160000 ');
  });

  it('rejects a date that is not a real calendar date', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(service.search('q', { submittedFrom: '2020-02-31' }, ctx)).rejects.toThrow(
      /not a real UTC calendar date/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an inverted date window', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(
      service.search('q', { submittedFrom: '2024-05-01', submittedTo: '2024-04-01' }, ctx),
    ).rejects.toThrow(/is after submitted_to/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('wraps multi-word unprefixed queries so category scopes the whole expression', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('mixture of experts', { category: 'cs.CL' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(mixture of experts) AND cat:cs.CL');
  });

  it('rejects unknown categories with a near-match suggestion', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('llm', { category: 'cs.INVALID' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'cs\.INVALID'\. Did you mean: cs\./,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown categories outside the taxonomy with edit-distance fallback', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('anything', { category: 'foo.BAR' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'foo\.BAR'/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails fast on "Rate exceeded" plain-text response without retrying', async () => {
    // arXiv returns 200 OK with `Rate exceeded.` body when throttling. Retrying
    // violates arXiv's 3s crawl etiquette and amplifies the throttle — surface
    // the rate-limit immediately. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 4xx without retrying', async () => {
    // arXiv returns HTTP 400 for bad input (e.g., non-integer max_results) with
    // an atom+xml content-type. These are permanent client errors and must not
    // be retried — see https://github.com/cyanheads/arxiv-mcp-server/issues/1.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 400,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('bad query', {}, ctx)).rejects.toThrow(/HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx transient server error', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 503,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:test', {}, ctx);

    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('fails fast on fetch timeout without retrying', async () => {
    // AbortSignal.timeout fires when arXiv hangs (typically connection-layer
    // throttling). The previous classification wrapped this as ServiceUnavailable
    // and retried, doubling caller-visible latency and upstream load. Surface as
    // Timeout and let the caller back off. See production logs 2026-05-08
    // (sessionId fae92e81…, requests with rootCause TimeoutError, durationMs 60-90s).
    const timeoutErr = Object.assign(new Error('The operation timed out.'), {
      name: 'TimeoutError',
    });
    mockFetch.mockRejectedValueOnce(timeoutErr);

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on HTTP 429 and surfaces Retry-After header', async () => {
    // 429 means arXiv is throttling — retrying makes it worse. Surface the
    // Retry-After header so clients can honor the cooldown. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 429,
        headers: {
          'content-type': 'application/atom+xml; charset=UTF-8',
          'retry-after': '60',
        },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { status: 429, retryAfter: '60' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After at the queue level — subsequent calls wait the cooldown', async () => {
    // When arXiv signals throttle, the cooldown applies to ALL queued calls,
    // not just the one that hit the rate-limit. Otherwise N concurrent callers
    // each hit the same rate-limit window in parallel. Retry-After larger than
    // the adaptive base (5s) wins; smaller values are floored by the adaptive
    // formula. See issues #8, #9.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Call 1: 429 with Retry-After: 8 (seconds) — larger than adaptive 5s base
      mockFetch.mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 429,
          headers: {
            'content-type': 'application/atom+xml; charset=UTF-8',
            'retry-after': '8',
          },
        }),
      );
      // Call 2: success (should fire only after the 8s cooldown)
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

      const service = getArxivService();
      const p1 = service.search('first', {}, createMockContext());
      const p2 = service.search('second', {}, createMockContext());

      await expect(p1).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      // After p1 settled, only one fetch has happened.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance just shy of the cooldown — second call still waiting.
      await vi.advanceTimersByTimeAsync(7500);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past the cooldown — second call dispatches and resolves.
      await vi.advanceTimersByTimeAsync(700);
      const result = await p2;
      expect(result.papers).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows cooldown geometrically on consecutive rate-limit hits (issue #9)', async () => {
    // First hit: 5s, second: 10s, third: 20s, fourth: 30s (capped). The error
    // data surfaces cooldownAppliedMs and consecutiveRateLimits so callers can
    // self-throttle.
    const rateLimited200 = (): Response =>
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    mockFetch
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = getArxivService();
      const expected = [
        { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1, advance: 5_100 },
        { cooldownAppliedMs: 10_000, consecutiveRateLimits: 2, advance: 10_100 },
        { cooldownAppliedMs: 20_000, consecutiveRateLimits: 3, advance: 20_100 },
        { cooldownAppliedMs: 30_000, consecutiveRateLimits: 4, advance: 0 },
      ];
      for (const { cooldownAppliedMs, consecutiveRateLimits, advance } of expected) {
        const p = service.search('t', {}, createMockContext());
        await expect(p).rejects.toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { cooldownAppliedMs, consecutiveRateLimits },
        });
        if (advance > 0) await vi.advanceTimersByTimeAsync(advance);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets consecutive rate-limit counter on successful response (issue #9)', async () => {
    // Two rate-limit hits grow the cooldown, then a success resets the counter
    // so the next rate-limit goes back to the 5s base.
    const rateLimited200 = (): Response =>
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    mockFetch
      .mockResolvedValueOnce(rateLimited200()) // 5s
      .mockResolvedValueOnce(rateLimited200()) // 10s
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE)) // success → reset
      .mockResolvedValueOnce(rateLimited200()); // 5s again (not 20s)

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = getArxivService();

      const p1 = service.search('t', {}, createMockContext());
      await expect(p1).rejects.toMatchObject({
        data: { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1 },
      });
      await vi.advanceTimersByTimeAsync(5_100);

      const p2 = service.search('t', {}, createMockContext());
      await expect(p2).rejects.toMatchObject({
        data: { cooldownAppliedMs: 10_000, consecutiveRateLimits: 2 },
      });
      await vi.advanceTimersByTimeAsync(10_100);

      // Success — counter resets
      await service.search('t', {}, createMockContext());

      // Next rate-limit starts fresh at the 5s base
      const p4 = service.search('t', {}, createMockContext());
      await expect(p4).rejects.toMatchObject({
        data: { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('200 "Rate exceeded" and 429 rate-limit paths emit symmetric error data (issue #9)', async () => {
    // Both paths must carry the same diagnostic fields so callers can branch on
    // a single shape. Pre-fix, the 200 path emitted only {url}. The recovery
    // hint is added at the tool/resource layer (via ctx.recoveryFor), not in
    // the service, so this check covers service-level parity only.
    const expectedKeys = new Set([
      'url',
      'status',
      'body',
      'cooldownAppliedMs',
      'consecutiveRateLimits',
      'reason',
    ]);

    // 200 + Rate exceeded
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    let service = getArxivService();
    let err: unknown;
    try {
      await service.search('t', {}, createMockContext());
    } catch (e) {
      err = e;
    }
    const data200 = (err as { data: Record<string, unknown> }).data;
    for (const key of expectedKeys) {
      expect(data200, `200 path missing ${key}`).toHaveProperty(key);
    }
    expect(data200.status).toBe(200);

    // Reset service so the counter starts fresh
    initArxivService();
    service = getArxivService();

    // 429
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded', {
        status: 429,
        headers: {
          'content-type': 'application/atom+xml; charset=UTF-8',
          'retry-after': '4',
        },
      }),
    );
    try {
      await service.search('t', {}, createMockContext());
    } catch (e) {
      err = e;
    }
    const data429 = (err as { data: Record<string, unknown> }).data;
    for (const key of expectedKeys) {
      expect(data429, `429 path missing ${key}`).toHaveProperty(key);
    }
    expect(data429.status).toBe(429);
    expect(data429.retryAfter).toBe('4');
  });

  it('rate-limit message names the applied cooldown in ms (issue #9)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const service = getArxivService();
    await expect(service.search('t', {}, createMockContext())).rejects.toThrow(
      /arXiv rate limit exceeded — server applied 5000ms cooldown/,
    );
  });

  it('skips queued requests whose ctx.signal aborted before their turn', async () => {
    // A cancelled request shouldn't consume a 3s queue slot — drop it at the
    // queue head so the next live caller dispatches immediately.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const liveCtx = createMockContext();
    const cancelledCtrl = new AbortController();
    const cancelledCtx = createMockContext({ signal: cancelledCtrl.signal });
    cancelledCtrl.abort(new Error('user cancelled'));

    const service = getArxivService();

    await expect(service.search('cancelled', {}, cancelledCtx)).rejects.toThrow(/cancelled/);
    expect(mockFetch).not.toHaveBeenCalled();

    // Live request after the cancelled one still works.
    const result = await service.search('live', {}, liveCtx);
    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPapers()
// ---------------------------------------------------------------------------

describe('ArxivService.getPapers', () => {
  it('returns papers and builds id_list URL param', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.id).toBe('2401.12345v1');
    expect(result.not_found).toBeUndefined();

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('id_list')).toBe('2401.12345');
  });

  it('detects not-found paper IDs', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345', '9999.99999'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.not_found).toEqual([{ id: '9999.99999', reason: 'not_in_arxiv' }]);
  });

  it('preserves input order regardless of arXiv response order (issue #5)', async () => {
    // arXiv returns entries in submission-date desc, not the order we asked
    // for. The service must re-index by input so callers can stitch metadata
    // back to an ordered reference list.
    const ATOM_REORDERED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>3</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.00003v1</id>
    <title>C</title><summary>c</summary>
    <author><name>X</name></author>
    <published>2024-03-01T00:00:00Z</published><updated>2024-03-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A</title><summary>a</summary>
    <author><name>X</name></author>
    <published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>B</title><summary>b</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_REORDERED));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.00001', '2401.00002', '2401.00003'], ctx);

    expect(result.papers.map((p) => p.id)).toEqual([
      '2401.00001v1',
      '2401.00002v1',
      '2401.00003v1',
    ]);
  });

  it('preserves input order across mixed versioned and unversioned IDs (issue #5)', async () => {
    // Input may carry version suffixes inconsistently; the reorder must compare
    // by base id so a versioned input lines up with arXiv's versioned response.
    const ATOM_MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v3</id>
    <title>B</title><summary>b</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A</title><summary>a</summary>
    <author><name>X</name></author>
    <published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_MIXED));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.00001v1', '2401.00002'], ctx);

    expect(result.papers.map((p) => p.id)).toEqual(['2401.00001v1', '2401.00002v3']);
  });

  it('keeps two explicit versions of one paper in distinct slots (issue #28)', async () => {
    // arXiv honors a `vN` suffix in id_list and returns one entry per requested
    // version, newest first. Matching on base ID alone collapses both slots onto
    // whichever entry landed last in the index.
    const ATOM_TWO_VERSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title><summary>v7</summary>
    <author><name>Vaswani</name></author>
    <published>2017-06-12T00:00:00Z</published><updated>2023-08-02T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v1</id>
    <title>Attention Is All You Need</title><summary>v1</summary>
    <author><name>Vaswani</name></author>
    <published>2017-06-12T00:00:00Z</published><updated>2017-06-12T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_TWO_VERSIONS));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['1706.03762v1', '1706.03762v7'], ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('id_list')).toBe('1706.03762v1,1706.03762v7');
    expect(result.papers.map((p) => p.id)).toEqual(['1706.03762v1', '1706.03762v7']);
    expect(result.papers.map((p) => p.abstract)).toEqual(['v1', 'v7']);
    expect(result.not_found).toBeUndefined();
  });

  it('reports an explicitly requested version arXiv did not return as not found (issue #25)', async () => {
    // ATOM_SINGLE carries 2401.12345v1 only — a v2 request must not resolve to it.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345v2'], ctx);

    expect(result.papers).toHaveLength(0);
    expect(result.not_found).toEqual([{ id: '2401.12345v2', reason: 'not_in_arxiv' }]);
  });

  it('handles sparse upstream entries without fabricating optional fields', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SPARSE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.99999'], ctx);
    const [paper] = result.papers;

    expect(paper).toBeDefined();
    // Output validates against the published schema even with omitted upstream fields
    expect(() => PaperMetadataSchema.parse(paper)).not.toThrow();
    // Genuinely-optional fields stay unset, not coerced into empty strings
    expect(paper?.comment).toBeUndefined();
    expect(paper?.journal_ref).toBeUndefined();
    expect(paper?.doi).toBeUndefined();
    // Primary category falls back to first <category> element when arxiv:primary_category is omitted
    expect(paper?.primary_category).toBe('cs.AI');
    // URLs derive deterministically from the paper ID when <link> elements are omitted
    expect(paper?.pdf_url).toBe('https://arxiv.org/pdf/2401.99999v1');
    expect(paper?.abstract_url).toBe('https://arxiv.org/abs/2401.99999v1');
  });
});

// ---------------------------------------------------------------------------
// readContent()
// ---------------------------------------------------------------------------

describe('ArxivService.readContent', () => {
  it('fetches metadata then HTML from arxiv.org', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<html><body>Paper content</body></html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.paper_id).toBe('2401.12345v1');
    expect(result.title).toBe('Test Paper Title');
    expect(result.source).toBe('arxiv_html');
    expect(result.content).toBe('<html><body>Paper content</body></html>');
    expect(result.truncated).toBe(false);
    expect(result.total_characters).toBe(39);
    expect(result.body_characters).toBe(39);
  });

  it('truncates content when max_characters is set', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('x'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 10 }, ctx);

    expect(result.truncated).toBe(true);
    expect(result.start).toBe(0);
    expect(result.content).toBe('x'.repeat(10));
    expect(result.total_characters).toBe(100);
  });

  it('slices from start offset when paginating', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('abcdefghij'.repeat(10)));

    const ctx = createMockContext();
    const service = getArxivService();
    // body_characters = 100; ask for chars 30..49
    const result = await service.readContent('2401.12345', { maxCharacters: 20, start: 30 }, ctx);

    expect(result.start).toBe(30);
    expect(result.body_characters).toBe(100);
    expect(result.content).toHaveLength(20);
    expect(result.content).toBe('abcdefghij'.repeat(10).slice(30, 50));
    expect(result.truncated).toBe(true);
  });

  it('returns empty content with truncated=false when start is past body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('a'.repeat(50)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent(
      '2401.12345',
      { maxCharacters: 100, start: 9999 },
      ctx,
    );

    expect(result.start).toBe(9999);
    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.body_characters).toBe(50);
  });

  it('reports truncated=false when the slice ends exactly at body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('z'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50, start: 50 }, ctx);

    expect(result.start).toBe(50);
    expect(result.content).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it('falls back to ar5iv when arxiv.org returns 404', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<html>ar5iv content</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('ar5iv');
    expect(result.content).toBe('<html>ar5iv content</html>');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('forwards the versioned paper ID to arxiv.org HTML fetch (issue #10)', async () => {
    // Versioned input must reach the HTML host with the version intact —
    // arxiv.org/html honors a version suffix, so stripping it silently served
    // the latest version instead of the requested one.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>V1 Title</title><summary>v1 abstract</summary>
    <author><name>X</name></author>
    <published>2024-01-22T00:00:00Z</published><updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(htmlResponse('<html>v1 body</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    await service.readContent('2401.12345v1', {}, ctx);

    // Second fetch (HTML) URL must include the version
    const htmlUrl = String(mockFetch.mock.calls[1]?.[0]);
    expect(htmlUrl).toBe('https://arxiv.org/html/2401.12345v1');
  });

  it('forwards the versioned ID through to the ar5iv fallback (issue #10)', async () => {
    // When arxiv.org/html returns 404 for a versioned paper, the ar5iv fallback
    // must also receive the version — not the stripped form.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>V2</title><summary>v2</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<html>v2 from ar5iv</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    await service.readContent('2401.12345v2', {}, ctx);

    expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://arxiv.org/html/2401.12345v2');
    expect(String(mockFetch.mock.calls[2]?.[0])).toBe(
      'https://ar5iv.labs.arxiv.org/html/2401.12345v2',
    );
  });

  it('points the PDF fallback hint at the same version that was requested (issue #10)', async () => {
    // When HTML is genuinely unavailable, the error message points the caller
    // at the PDF — and that hint must match the version they asked for, not the
    // stripped form.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>V1</title><summary>v1</summary>
    <author><name>X</name></author>
    <published>2024-01-22T00:00:00Z</published><updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345v1', {}, ctx)).rejects.toThrow(
      /https:\/\/arxiv\.org\/pdf\/2401\.12345v1/,
    );
  });

  it('throws notFound when paper does not exist', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('9999.99999', {}, ctx)).rejects.toThrow(/not found/i);
  });

  it('throws notFound when no HTML source is available', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      // arxiv.org/html returns 404
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // ar5iv returns 307 redirect (paper not converted)
      .mockResolvedValueOnce(new Response('', { status: 307 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toThrow(/not available/i);
  });

  it('collapses inline MathML to TeX annotation, reclaiming character budget (issue #4)', async () => {
    // arXiv renders inline `70%` as ~250 chars of presentation MathML. The same
    // content is present in the <annotation encoding="application/x-tex"> child
    // as 4 chars. Collapsing typically shrinks math-heavy papers by an order of
    // magnitude with zero content loss.
    const mathTag =
      '<math alttext="70\\%" display="inline">' +
      '<semantics><mrow><mn>70</mn><mo>%</mo></mrow>' +
      '<annotation encoding="application/x-tex">70\\%</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>Fracture point at ${mathTag} utilization.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.content).not.toContain('<math');
    expect(result.content).not.toContain('annotation');
    expect(result.content).not.toContain('semantics');
    expect(result.content).toContain('$70\\%$');
    expect(result.content).toContain('Fracture point at');
    expect(result.content).toContain('utilization');
  });

  it('marks display-block MathML with $$…$$ and inline with $…$ (issue #4)', async () => {
    // Block-level math (display="block") wraps in $$…$$; inline math wraps in
    // single $. The distinction is preserved so downstream consumers can render
    // each appropriately.
    const blockMath =
      '<math display="block"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">E=mc^2</annotation>' +
      '</semantics></math>';
    const inlineMath =
      '<math display="inline"><semantics><mi>x</mi>' +
      '<annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>${blockMath} and inline ${inlineMath}.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$$E=mc^2$$');
    expect(result.content).toContain('$x$');
  });

  it('falls back to alttext when no annotation child is present (issue #4)', async () => {
    // Some arXiv pages render MathML without an x-tex annotation child but
    // still carry the LaTeX source in the alttext attribute. Drop math
    // elements that have neither.
    const withAlt = '<math alttext="\\alpha" display="inline"><mi>α</mi></math>';
    const noSource = '<math display="inline"><mi>β</mi></math>';
    const raw = `<article><p>${withAlt} vs ${noSource}.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$\\alpha$');
    // The annotation-less element is dropped entirely
    expect(result.content).not.toContain('β');
    expect(result.content).not.toContain('<math');
  });

  it('decodes HTML entities in the LaTeX source (issue #4)', async () => {
    // The <annotation> child may carry HTML-encoded characters (&lt;, &gt;,
    // &amp;) from the upstream LaTeXML transform. Decode them so downstream
    // consumers see literal TeX, not HTML-escaped TeX.
    const mathTag =
      '<math display="inline"><semantics><mi>a</mi>' +
      '<annotation encoding="application/x-tex">a &lt; b &amp;&amp; c &gt; d</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>${mathTag}</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$a < b && c > d$');
  });

  it('shrinks math-heavy bodies by an order of magnitude (issue #4)', async () => {
    // Regression check on the practical benefit: a page where MathML dominates
    // the byte budget should compress dramatically after collapse, leaving
    // proportionally more characters for prose.
    const mathExpr =
      '<math alttext="x" display="inline">' +
      '<semantics><mrow><mi>x</mi></mrow>' +
      '<annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math>';
    // 200 inline math expressions, each ~250 chars raw → ~3 chars collapsed.
    const raw = `<article><p>${mathExpr.repeat(200)}</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    // Body should shrink at least 5x — in practice closer to 30x.
    expect(result.body_characters).toBeLessThan(result.total_characters / 5);
  });

  it('strips LaTeXML class/id noise and reports body_characters distinct from total', async () => {
    const raw =
      '<article><span class="ltx_text" id="S1.p1">Hello</span>' +
      '<br class="ltx_break"/><br class="ltx_break"/>' +
      '<p class="ltx_para" id="p2">World</p></article>';
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Content should no longer contain ltx_* class or id attributes
    expect(result.content).not.toMatch(/class="ltx_/);
    expect(result.content).not.toMatch(/\sid="/);
    // Runs of <br> should collapse to a single <br>
    expect(result.content).not.toMatch(/<br[^>]*>\s*<br/i);
    // Content should still contain the actual text and tag skeleton
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
    expect(result.content).toContain('<span>');
    expect(result.content).toContain('<p>');
    // Both char counts are reported; body is strictly smaller after stripping
    expect(result.total_characters).toBe(raw.length);
    expect(result.body_characters).toBe(result.content.length);
    expect(result.body_characters).toBeLessThan(result.total_characters);
  });

  it('preserves structural ltx_* class attributes (section, title, bibliography) while stripping noise', async () => {
    // Section boundaries must survive cleaning so downstream tooling (or a
    // future section-scoped read parameter) can identify them. Decorative
    // classes like ltx_text and ltx_font_bold should still be stripped.
    const raw = [
      '<article>',
      '<section class="ltx_section">',
      '<h2 class="ltx_title ltx_title_section">1 Introduction</h2>',
      '<p class="ltx_para"><span class="ltx_text ltx_font_bold">Body</span></p>',
      '<section class="ltx_subsection"><h3 class="ltx_title ltx_title_subsection">1.1</h3></section>',
      '<section class="ltx_bibliography"><h2 class="ltx_title">References</h2></section>',
      '</section>',
      '</article>',
    ].join('');
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Structural markers preserved
    expect(result.content).toContain('class="ltx_section"');
    expect(result.content).toContain('class="ltx_subsection"');
    expect(result.content).toContain('class="ltx_bibliography"');
    expect(result.content).toContain('ltx_title');
    // Decorative noise stripped
    expect(result.content).not.toContain('ltx_para');
    expect(result.content).not.toContain('ltx_text');
    expect(result.content).not.toContain('ltx_font_bold');
    // Text content survives
    expect(result.content).toContain('1 Introduction');
    expect(result.content).toContain('References');
  });

  it('truncates based on body_characters, not raw total', async () => {
    // Raw HTML with lots of ltx noise that strips down to a small body.
    const raw = `<article>${'<span class="ltx_text" id="x">a</span>'.repeat(20)}</article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50 }, ctx);

    expect(result.total_characters).toBe(raw.length);
    // Cleaned content is much smaller than raw; truncation applies to cleaned form
    expect(result.body_characters).toBeLessThan(raw.length);
    expect(result.content.length).toBeLessThanOrEqual(50);
    if (result.body_characters > 50) {
      expect(result.truncated).toBe(true);
    }
  });

  it('throws on unexpected content-type from API', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal error', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toThrow(/content-type/i);
  });
});
