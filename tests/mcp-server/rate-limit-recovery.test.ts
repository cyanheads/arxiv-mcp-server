/**
 * @fileoverview Contract guard for the `rate_limited` recovery hints (issue #9)
 * — every `error.data.<field>` a recovery string tells the caller to read must
 * be present on the error the common throttle path actually emits. arXiv
 * answers a throttle with 200 + "Rate exceeded." far more often than with a 429,
 * and that response carries no `Retry-After` header to report, so a hint naming
 * `retryAfter` points at a key that is absent exactly when it is needed.
 * @module mcp-server/rate-limit-recovery.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperResource } from '@/mcp-server/resources/definitions/paper.resource.js';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';

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

/** Error data from the 200 + "Rate exceeded." path — arXiv's usual throttle shape. */
async function softThrottleErrorData(): Promise<Record<string, unknown>> {
  mockFetch.mockResolvedValue(
    new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );
  try {
    await getArxivService().search('all:test', {}, createMockContext());
  } catch (err) {
    return (err as McpError).data as Record<string, unknown>;
  }
  throw new Error('expected the soft-throttle response to fail');
}

const definitions = [
  { name: 'arxiv_search', errors: arxivSearch.errors },
  { name: 'arxiv_get_metadata', errors: arxivGetMetadata.errors },
  { name: 'arxiv_read_paper', errors: arxivReadPaper.errors },
  { name: 'arxiv://paper/{paperId}', errors: paperResource.errors },
];

describe('rate_limited recovery hints (#9)', () => {
  it.each(definitions)('$name points at a field the throttle path emits', async ({ errors }) => {
    const data = await softThrottleErrorData();
    const entry = errors?.find((e) => e.reason === 'rate_limited');
    expect(entry).toBeDefined();

    const referenced = [...entry!.recovery.matchAll(/error\.data\.(\w+)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const field of referenced) {
      expect(
        data,
        `recovery names error.data.${field}, absent on the 200 throttle path`,
      ).toHaveProperty(field as string);
    }
  });

  it('emits cooldownAppliedMs but no retryAfter when arXiv sends no header', async () => {
    const data = await softThrottleErrorData();
    expect(data).toHaveProperty('cooldownAppliedMs');
    expect(data).not.toHaveProperty('retryAfter');
  });
});
