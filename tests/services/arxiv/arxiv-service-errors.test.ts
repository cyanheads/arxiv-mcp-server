/**
 * @fileoverview Additional error-path tests for ArxivService — network errors,
 * content-type edge cases, empty inputs, and ar5iv error handling.
 * @module services/arxiv/arxiv-service-errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
    mirrorEnabled: false,
    mirrorPath: '',
    mirrorFallbackLive: false,
    mirrorRecentDaysLive: 0,
    mirrorOaiBaseUrl: 'https://oaipmh.arxiv.org/oai',
    mirrorOaiRequestDelayMs: 0,
  }),
}));

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
  initArxivService();
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
    const result = await service.getPapers(['9999.99999'], ctx);
    expect(result.papers).toHaveLength(0);
    expect(result.not_found).toEqual([{ id: '9999.99999', reason: 'not_in_arxiv' }]);
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

  it('throws ServiceUnavailable when ar5iv returns 500', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      // arxiv.org/html → 404 (falls through to ar5iv)
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // ar5iv → 500 (two times to exhaust retry)
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  }, 30_000);

  it('ar5iv 404 falls through to html_unavailable notFound, not ServiceUnavailable', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
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
