/**
 * @fileoverview Boundary guard for arXiv ID inputs (issue #26) — a whitespace-only
 * ID must be rejected by the tool/resource schema and never dispatched to the
 * rate-limited arXiv API. These cases drive the real `ArxivService` with a stubbed
 * `fetch`, so the assertion is "no upstream request happened", not merely "an
 * error was returned": if a schema stops guarding, the handler runs and the
 * stubbed fetch records the call.
 * @module mcp-server/id-input-boundary.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperResource } from '@/mcp-server/resources/definitions/paper.resource.js';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
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
  mockFetch.mockResolvedValue(
    new Response('<feed></feed>', {
      status: 200,
      headers: { 'content-type': 'application/atom+xml' },
    }),
  );
  initArxivService();
});

/**
 * Run a handler for its side effects only. A whitespace ID that slips past the
 * schema fails somewhere downstream; the upstream call it makes on the way is
 * what the surrounding assertion is looking for.
 */
async function runIgnoringFailure(invoke: () => unknown): Promise<void> {
  try {
    await invoke();
  } catch {
    // Intentionally ignored — see doc comment.
  }
}

describe('whitespace-only paper IDs never reach the arXiv API (#26)', () => {
  it('arxiv_get_metadata — scalar paper_ids', async () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: '   ' });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
        typeof arxivGetMetadata.handler
      >[1];
      await runIgnoringFailure(() => arxivGetMetadata.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv_get_metadata — array element', async () => {
    const parsed = arxivGetMetadata.input.safeParse({ paper_ids: ['2401.12345', ' \t '] });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
        typeof arxivGetMetadata.handler
      >[1];
      await runIgnoringFailure(() => arxivGetMetadata.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv_read_paper — paper_id', async () => {
    const parsed = arxivReadPaper.input.safeParse({ paper_id: '   ', max_characters: 100 });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
        typeof arxivReadPaper.handler
      >[1];
      await runIgnoringFailure(() => arxivReadPaper.handler(parsed.data, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv://paper/{paperId} — resource parameter', async () => {
    const parsed = paperResource.params!.safeParse({ paperId: '   ' });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
        typeof paperResource.handler
      >[1];
      const params = parsed.data as Parameters<typeof paperResource.handler>[0];
      await runIgnoringFailure(() => paperResource.handler(params, ctx));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('arxiv://paper/{paperId} — percent-encoded blank segment', async () => {
    // URI-template matching yields raw segment text, so `%20%20%20` is nine
    // ordinary characters to the params schema and reaches the handler. The
    // decoded blank must still stop short of arXiv.
    const params = paperResource.params!.parse({ paperId: '%20%20%20' }) as Parameters<
      typeof paperResource.handler
    >[0];
    const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
      typeof paperResource.handler
    >[1];
    await runIgnoringFailure(() => paperResource.handler(params, ctx));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
