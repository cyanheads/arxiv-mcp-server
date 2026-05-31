/**
 * @fileoverview End-to-end tests for ArxivService's mirror integration —
 * seeds a real SQLite mirror with a handful of records, then verifies
 * `getPapers` and the `searchMirror` private path resolve against it rather
 * than the live API. Covers the slot-based fallback merge introduced for
 * issue #12 along with FTS5 + category-filter behavior.
 * @module services/arxiv/arxiv-service-mirror.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import { ArxivService } from '@/services/arxiv/arxiv-service.js';
import { MirrorStore, resetStore } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const configOverrides: {
  mirrorEnabled: boolean;
  mirrorFallbackLive: boolean;
  mirrorPath: string;
  mirrorRecentDaysLive: number;
} = {
  mirrorEnabled: true,
  mirrorPath: '',
  mirrorFallbackLive: true,
  mirrorRecentDaysLive: 0,
};

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
    mirrorEnabled: configOverrides.mirrorEnabled,
    mirrorPath: configOverrides.mirrorPath,
    mirrorFallbackLive: configOverrides.mirrorFallbackLive,
    mirrorRecentDaysLive: configOverrides.mirrorRecentDaysLive,
    mirrorOaiBaseUrl: 'https://oaipmh.arxiv.org/oai',
    mirrorOaiRequestDelayMs: 0,
  }),
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

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

function atomResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
  });
}

const ATOM_LIVE_PAPER = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2402.99999v1</id>
    <title>From Live API</title>
    <summary>This was not in the mirror.</summary>
    <author><name>Live Author</name></author>
    <category term="cs.AI" />
    <published>2024-02-15T00:00:00Z</published>
    <updated>2024-02-15T00:00:00Z</updated>
  </entry>
</feed>`;

const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

describe('ArxivService — mirror integration', () => {
  let dir: string;
  let service: ArxivService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-svc-mirror-test-'));
    configOverrides.mirrorPath = join(dir, 'mirror.db');
    configOverrides.mirrorEnabled = true;
    configOverrides.mirrorFallbackLive = true;
    configOverrides.mirrorRecentDaysLive = 0;

    const store = await MirrorStore.open(configOverrides.mirrorPath);
    store.applyBatch(
      [
        mkRecord({
          paper_id: '2401.10001',
          title: 'Mirror Paper One on Transformers',
          authors: 'Alice Smith, Bob Jones',
          abstract: 'A study of attention mechanisms in deep learning.',
          categories: 'cs.LG cs.AI',
        }),
        mkRecord({
          paper_id: '2401.10002',
          title: 'Mirror Paper Two on Astrophysics',
          authors: 'Carol Adams',
          abstract: 'Cosmic microwave background observations.',
          categories: 'astro-ph.CO',
          versions: [
            { version: 'v1', date: '2024-01-15T00:00:00Z' },
            { version: 'v3', date: '2024-02-20T00:00:00Z' },
          ],
        }),
      ],
      [],
    );
    store.writeHarvestState({
      status: 'complete',
      started_at: '2024-02-21T00:00:00Z',
      completed_at: '2024-02-21T01:00:00Z',
      last_datestamp: '2024-02-20',
      total_records: 2,
    });
    store.close();

    mockFetch.mockReset();
    service = new ArxivService();
  });

  afterEach(async () => {
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // getPapers — mirror path
  // -------------------------------------------------------------------------

  describe('getPapers', () => {
    it('resolves all IDs from the mirror without touching the live API', async () => {
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2401.10002'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(2);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.papers[1]?.id).toBe('2401.10002v3');
      expect(result.not_found_ids).toBeUndefined();
    });

    it('preserves input order regardless of stored order', async () => {
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10002', '2401.10001'], ctx);

      expect(result.papers.map((p) => p.id)).toEqual(['2401.10002v3', '2401.10001v1']);
    });

    it('strips versioned input before mirror lookup and returns the stored version', async () => {
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001v9'], ctx);

      // Mirror only knows the latest version; input version is stripped before lookup.
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });

    it('falls back to live API for misses when mirrorFallbackLive=true', async () => {
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_PAPER));
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2402.99999'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      // Live fallback should only request the missing ID, not the mirror hit.
      expect(url.searchParams.get('id_list')).toBe('2402.99999');

      expect(result.papers).toHaveLength(2);
      // Input order: mirror hit at index 0, live hit at index 1.
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.papers[0]?.title).toBe('Mirror Paper One on Transformers');
      expect(result.papers[1]?.id).toBe('2402.99999v1');
      expect(result.papers[1]?.title).toBe('From Live API');
      expect(result.not_found_ids).toBeUndefined();
    });

    it('reports still-missing IDs when fallback also returns nothing', async () => {
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '9999.99999'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.not_found_ids).toEqual(['9999.99999']);
    });

    it('skips fallback and reports misses when mirrorFallbackLive=false', async () => {
      configOverrides.mirrorFallbackLive = false;
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2402.99999'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.not_found_ids).toEqual(['2402.99999']);
    });

    it('bypasses the mirror entirely when mirrorEnabled=false', async () => {
      configOverrides.mirrorEnabled = false;
      resetStore();
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_PAPER));
      const ctx = createMockContext();
      const result = await service.getPapers(['2402.99999'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.papers[0]?.id).toBe('2402.99999v1');
    });
  });

  // -------------------------------------------------------------------------
  // search — mirror FTS5 path
  // -------------------------------------------------------------------------

  describe('search', () => {
    it('resolves a free-text query against the mirror via FTS5', async () => {
      // FTS5 unicode61 case-folds but does not stem — query token must match
      // the stored token exactly (plural vs singular do not match).
      const ctx = createMockContext();
      const result = await service.search('ti:transformers', { maxResults: 10 }, ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.total_results).toBe(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });

    it('applies category filter via the structured cat: extraction', async () => {
      const ctx = createMockContext();
      const result = await service.search('cat:astro-ph.CO', { maxResults: 10 }, ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10002v3');
    });

    it('merges options.category into the structured filter', async () => {
      const ctx = createMockContext();
      const result = await service.search('attention', { maxResults: 10, category: 'cs.LG' }, ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });

    it('bypasses the mirror for sort-by-submitted-descending when recent-days window is active', async () => {
      configOverrides.mirrorRecentDaysLive = 2;
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      const ctx = createMockContext();
      await service.search('anything', { sortBy: 'submitted', sortOrder: 'descending' }, ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('uses the mirror for sort-by-submitted when recent-days window is disabled', async () => {
      configOverrides.mirrorRecentDaysLive = 0;
      const ctx = createMockContext();
      const result = await service.search('astrophysics', { sortBy: 'submitted' }, ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Issue #13 — translator/FTS5 adjacency. These queries previously emitted
    // FTS5 expressions that SQLite rejected with a raw `fts5: syntax error`;
    // after the translator fix they should resolve cleanly via the mirror.
    // -----------------------------------------------------------------------

    it.each([
      'transformers attention',
      'attention all:transformers',
      'all:attention transformers',
      'all:attention "transformers" all:protein',
      '(transformers) (protein)',
      'protein (all:transformers)',
    ])('resolves adjacency-prone query %s without surfacing an FTS5 error', async (q) => {
      const ctx = createMockContext();
      await expect(service.search(q, { maxResults: 5 }, ctx)).resolves.toMatchObject({
        total_results: expect.any(Number),
        papers: expect.any(Array),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rethrows a store-side fts5 SQLiteError as a validationError carrying the original query, matchExpr, and recovery hint from the tool contract', async () => {
      const spy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
        throw new Error('fts5: syntax error near ":"');
      });
      try {
        // Wire the mock context to the arxiv_search errors[] contract so the
        // service's `ctx.recoveryFor('unsupported_query_syntax')` resolves to
        // the real recovery hint a production caller would see.
        const ctx = createMockContext({ errors: arxivSearch.errors! });
        expect.assertions(5);
        try {
          await service.search('language all:automated', { maxResults: 1 }, ctx);
        } catch (err) {
          expect(err).toBeInstanceOf(McpError);
          expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
          expect((err as McpError).data).toMatchObject({
            query: 'language all:automated',
            reason: 'unsupported_query_syntax',
          });
          expect((err as McpError).data).toHaveProperty('matchExpr');
          expect((err as McpError).data).toHaveProperty('recovery');
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('does not catch non-fts5 errors thrown by the store', async () => {
      const spy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
        throw new Error('disk I/O error');
      });
      try {
        const ctx = createMockContext();
        await expect(service.search('anything', { maxResults: 1 }, ctx)).rejects.toThrow(
          /disk I\/O error/,
        );
      } finally {
        spy.mockRestore();
      }
    });

    // -----------------------------------------------------------------------
    // Issue #14 — cat: extraction inside parens. Previously emitted FTS5
    // expressions with dangling operators or empty groups; after the
    // translator cleanup pass these resolve cleanly via the mirror.
    // -----------------------------------------------------------------------

    it.each([
      // All six failing shapes from the issue's table.
      '(cat:cs.LG OR attention)',
      '(attention OR cat:cs.LG)',
      '(cat:cs.LG AND attention)',
      '(cat:cs.LG)',
      '(cat:cs.LG OR cat:cs.AI)',
      '(cat:cs.LG OR cat:cs.AI OR attention)',
      // Broader cleanup combinations.
      'cat:cs.LG AND attention',
      'attention AND cat:cs.LG',
      'attention AND (cat:cs.LG)',
      '(cat:cs.LG) AND attention',
      '(attention AND (cat:cs.LG))',
      '(attention OR cat:cs.LG OR background)',
      'attention AND cat:cs.LG OR background',
      '(all:attention OR cat:cs.LG)',
    ])('resolves cat:-cleanup query %s without surfacing an FTS5 error', async (q) => {
      const ctx = createMockContext();
      await expect(service.search(q, { maxResults: 5 }, ctx)).resolves.toMatchObject({
        total_results: expect.any(Number),
        papers: expect.any(Array),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('applies the extracted category filter even when the group emptied out', async () => {
      // `(cat:cs.LG)` strips to no matchExpr — the mirror search runs as a
      // pure category filter and returns the cs.LG paper only.
      const ctx = createMockContext();
      const result = await service.search('(cat:cs.LG)', { maxResults: 10 }, ctx);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });

    it('applies multiple extracted categories from inside a group', async () => {
      const ctx = createMockContext();
      const result = await service.search(
        '(cat:cs.LG OR cat:astro-ph.CO)',
        { maxResults: 10 },
        ctx,
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(2);
      expect(result.papers.map((p) => p.id).sort()).toEqual(['2401.10001v1', '2401.10002v3']);
    });

    it('combines surviving FTS term with extracted category filter', async () => {
      const ctx = createMockContext();
      const result = await service.search('(cat:cs.LG OR attention)', { maxResults: 10 }, ctx);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });
  });

  // -------------------------------------------------------------------------
  // Refresh-window readiness (#21) — an incremental or failed refresh on top of
  // a complete mirror must keep serving the existing dataset, not drop to the
  // throttled live API. Readiness keys off the durable completed_at marker,
  // which survives the in_progress/error status writes the runner makes.
  // -------------------------------------------------------------------------

  describe('refresh-window readiness (#21)', () => {
    /** Flip harvest_state to a non-complete status; completed_at must survive. */
    async function setRefreshStatus(state: {
      status: 'in_progress' | 'error';
      error_message?: string;
    }): Promise<void> {
      const s = await MirrorStore.open(configOverrides.mirrorPath);
      s.writeHarvestState({
        status: state.status,
        started_at: '2024-02-22T00:00:00Z',
        last_datestamp: '2024-02-21',
        ...(state.error_message ? { error_message: state.error_message } : {}),
      });
      // The seed wrote completed_at on a `complete` state; it must persist.
      expect(s.readHarvestState().completed_at).toBe('2024-02-21T01:00:00Z');
      s.close();
    }

    it.each([
      { status: 'in_progress' as const },
      { status: 'error' as const, error_message: 'OAI ListRecords HTTP 503' },
    ])('keeps serving search from the mirror during a $status refresh', async (state) => {
      await setRefreshStatus(state);
      const ctx = createMockContext();
      const result = await service.search('ti:transformers', { maxResults: 10 }, ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.total_results).toBe(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
    });

    it('keeps serving getPapers from the mirror during an in-progress refresh', async () => {
      await setRefreshStatus({ status: 'in_progress' });
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2401.10002'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1', '2401.10002v3']);
    });

    it('still routes to live during a never-completed cold init', async () => {
      // A cold init in flight has status=in_progress but has NEVER completed, so
      // completed_at is null. The partial dataset must not be served as ready —
      // search routes to the live API until the first harvest completes.
      resetStore();
      const coldDir = await mkdtemp(join(tmpdir(), 'arxiv-svc-cold-test-'));
      configOverrides.mirrorPath = join(coldDir, 'mirror.db');
      const cold = await MirrorStore.open(configOverrides.mirrorPath);
      cold.applyBatch([mkRecord({ paper_id: '2401.10001', title: 'Partial Cold Harvest' })], []);
      cold.writeHarvestState({ status: 'in_progress', started_at: '2024-02-22T00:00:00Z' });
      expect(cold.readHarvestState().completed_at).toBeUndefined();
      cold.close();
      resetStore();

      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_PAPER));
      const ctx = createMockContext();
      const result = await service.search('ti:transformers', { maxResults: 10 }, ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.papers[0]?.id).toBe('2402.99999v1');

      resetStore();
      await rm(coldDir, { recursive: true, force: true });
    });
  });
});
