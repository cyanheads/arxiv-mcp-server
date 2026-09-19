/**
 * @fileoverview Contract-boundary guard for the two error envelopes a client
 * receives: an argument rejection raised before the handler runs, and a domain
 * failure thrown from the service. Both consumption paths are asserted —
 * `structuredContent.error` for schema-aware clients and the `content[]` text a
 * format-only client reads — because the framework renders them separately and
 * a change to one has shipped without the other.
 * @module mcp-server/error-envelope.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
    mirrorEnabled: false,
    mirrorPath: '',
    mirrorFallbackLive: true,
    mirrorRecentDaysLive: 0,
  }),
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  initArxivService();
});

/** The `error` object the framework writes onto `structuredContent`. */
function errorOf(result: { structuredContent?: unknown }): Record<string, unknown> {
  const structured = result.structuredContent as { error?: Record<string, unknown> } | undefined;
  expect(structured?.error, JSON.stringify(result)).toBeDefined();
  return structured!.error!;
}

/** Every text block of the result, joined — what a format-only client reads. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** A well-formed Atom feed with no entries — enough to reach a successful return. */
function emptyFeed(): Response {
  return new Response(
    `<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>0</opensearch:totalResults>
      <opensearch:startIndex>0</opensearch:startIndex></feed>`,
    { headers: { 'content-type': 'application/atom+xml' } },
  );
}

/**
 * An argument rejection never reaches the handler, so it is the framework's
 * envelope end to end. Assertions name the offending field rather than pinning
 * the sentence, which the framework rewords between releases.
 */
describe('argument rejection envelope', () => {
  it('names the omitted required field on both surfaces', async () => {
    const result = await runToolContract(arxivSearch, {} as never);

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((error.data as Record<string, unknown>).reason).toBe('invalid_arguments');
    const text = textOf(result);
    expect(text).toContain('query');
    expect(text).toContain('Recovery:');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('names the wrongly-typed field on both surfaces', async () => {
    const result = await runToolContract(arxivSearch, { query: 42 } as never);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toContain('query');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('drops a client-injected root key instead of rejecting the call', async () => {
    mockFetch.mockResolvedValue(emptyFeed());

    const result = await runToolContract(arxivSearch, {
      query: 'all:test',
      toolCallId: 'call_abc123',
      _meta: { progressToken: 1 },
    } as never);

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
  });

  it('rewrites a case-style spelling of a declared key onto the declared one', async () => {
    mockFetch.mockResolvedValue(emptyFeed());

    const result = await runToolContract(arxivSearch, {
      query: 'all:test',
      maxResults: 3,
    } as never);

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(mockFetch.mock.calls[0]?.[0]).toContain('max_results=3');
  });
});

describe('domain failure envelope', () => {
  it('carries the rate_limited reason and its recovery hint on both surfaces', async () => {
    // arXiv's usual throttle: HTTP 200 with a plain-text body, no Retry-After.
    mockFetch.mockResolvedValue(
      new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const result = await runToolContract(arxivSearch, { query: 'all:test' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect((error.data as Record<string, unknown>).reason).toBe('rate_limited');
    expect((error.data as Record<string, unknown>).cooldownAppliedMs).toEqual(expect.any(Number));
    // The contract advertises retryable: true; a service-layer factory throw has
    // to put it on the wire itself, since only ctx.fail injects it from errors[].
    expect((error.data as Record<string, unknown>).retryable).toBe(true);

    // The text surface has to carry the branchable terms too — a format-only
    // client never sees `data`.
    const text = textOf(result);
    expect(text).toContain('Recovery:');
    expect(text).toContain('cooldownAppliedMs');
    expect(text).toContain('(reason rate_limited · retryable)');
  });
});
