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
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
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

/** Live response for a version the mirror does not hold (it stores v1 only). */
const ATOM_LIVE_V9 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.10001v9</id>
    <title>Mirror Paper One on Transformers</title>
    <summary>Revision nine, live only.</summary>
    <author><name>Alice Smith</name></author>
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-06-01T00:00:00Z</updated>
  </entry>
</feed>`;

/**
 * Two explicit versions of one paper in a single response. arXiv returns newest
 * first, which is what made the base-ID map collapse both onto the older entry.
 */
const ATOM_LIVE_TWO_VERSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.10001v3</id>
    <title>Revision Three</title>
    <summary>Third revision.</summary>
    <author><name>Alice Smith</name></author>
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-04-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.10001v2</id>
    <title>Revision Two</title>
    <summary>Second revision.</summary>
    <author><name>Alice Smith</name></author>
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-03-01T00:00:00Z</updated>
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
      expect(result.not_found).toBeUndefined();
    });

    it('preserves input order regardless of stored order', async () => {
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10002', '2401.10001'], ctx);

      expect(result.papers.map((p) => p.id)).toEqual(['2401.10002v3', '2401.10001v1']);
    });

    it('serves an explicit version from the mirror when the stored version matches (#25)', async () => {
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001v1', '2401.10002v3'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1', '2401.10002v3']);
      expect(result.not_found).toBeUndefined();
    });

    it('routes an explicit version the mirror does not hold to the live API (#25)', async () => {
      // The mirror stores the latest version only (v1 here), so a v9 request is
      // a miss — never a silent substitution of the stored version.
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_V9));
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001v9'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(url.searchParams.get('id_list')).toBe('2401.10001v9');
      expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v9']);
    });

    it('reports an explicit version the mirror does not hold as unreachable, not absent from arXiv (#25, #35)', async () => {
      // The paper and the version both exist upstream — only this deployment
      // cannot reach them. `not_in_arxiv` would tell the caller the ID is bad.
      configOverrides.mirrorFallbackLive = false;
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001v9'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(0);
      expect(result.not_found).toEqual([
        {
          id: '2401.10001v9',
          reason: 'version_not_in_mirror',
          detail: expect.stringContaining("'2401.10001v1'"),
        },
      ]);
      expect(result.not_found?.[0]?.detail).toContain('version 1');
    });

    it('keeps two mirror-missing versions of one paper distinct through the live merge (#25 × #28)', async () => {
      // Compound case: an unversioned slot resolves from the mirror while two
      // differently-versioned slots for the same base ID both miss and share a
      // single live fallback call. The merge must key on the full versioned ID
      // or both live slots collapse onto one version.
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_TWO_VERSIONS));
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2401.10001v2', '2401.10001v3'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      // Only the two misses go upstream — the unversioned slot came from the mirror.
      expect(url.searchParams.get('id_list')).toBe('2401.10001v2,2401.10001v3');

      expect(result.papers.map((p) => p.id)).toEqual([
        '2401.10001v1',
        '2401.10001v2',
        '2401.10001v3',
      ]);
      expect(result.papers[0]?.title).toBe('Mirror Paper One on Transformers');
      expect(result.not_found).toBeUndefined();
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
      expect(result.not_found).toBeUndefined();
    });

    it('reports still-missing IDs when fallback also returns nothing', async () => {
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '9999.99999'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.not_found).toEqual([{ id: '9999.99999', reason: 'not_in_arxiv' }]);
    });

    it('skips fallback and reports misses when mirrorFallbackLive=false', async () => {
      // A base ID the mirror has never seen is absent from arXiv as far as this
      // deployment can tell — distinct from the version-pin case above (#35).
      configOverrides.mirrorFallbackLive = false;
      const ctx = createMockContext();
      const result = await service.getPapers(['2401.10001', '2402.99999'], ctx);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]?.id).toBe('2401.10001v1');
      expect(result.not_found).toEqual([{ id: '2402.99999', reason: 'not_in_arxiv' }]);
    });

    it('builds both paper URLs from the version the record reports, on either backend (#34)', async () => {
      // A mirror-served record used to pair a versioned `id` and `pdf_url` with
      // a bare `abstract_url`, so the same tool returned two URL shapes
      // depending on which backend answered.
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_LIVE_V9));
      const ctx = createMockContext();
      const [fromMirror] = (await service.getPapers(['2401.10001'], ctx)).papers;
      const [fromLive] = (await service.getPapers(['2401.10001v9'], ctx)).papers;

      expect(fromMirror?.id).toBe('2401.10001v1');
      expect(fromMirror?.abstract_url).toBe('https://arxiv.org/abs/2401.10001v1');
      expect(fromLive?.abstract_url).toBe('https://arxiv.org/abs/2401.10001v9');

      for (const paper of [fromMirror, fromLive]) {
        expect(paper?.abstract_url).toBe(`https://arxiv.org/abs/${paper?.id}`);
        expect(paper?.pdf_url).toBe(`https://arxiv.org/pdf/${paper?.id}`);
      }
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
  // readContent — mirror fallback when the live metadata lookup fails (#33)
  // -------------------------------------------------------------------------

  describe('readContent — live failure, mirror fallback (#33)', () => {
    /**
     * Rate-limit every API call (arXiv's most common failure, and non-retryable
     * here per #8) while serving HTML for any version. If a version-pinned read
     * ever resolves to the mirror's stored version, the HTML fetch below
     * succeeds and the call returns a different revision's body.
     */
    function mockLiveDownButHtmlUp(): void {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('export.arxiv.org')) {
          return Promise.resolve(
            new Response('Rate exceeded.', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            }),
          );
        }
        return Promise.resolve(
          new Response('<html><head></head><body><article>Body text.</article></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
      });
    }

    const htmlCalls = (): string[] =>
      mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes('export.arxiv.org'));

    it('fails rather than substituting the stored version for a version-pinned read', async () => {
      // The mirror holds 2401.10002 at v3; the caller pinned v1.
      mockLiveDownButHtmlUp();
      const ctx = createMockContext({ errors: arxivReadPaper.errors! });

      await expect(service.readContent('2401.10002v1', {}, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'version_unavailable', paperId: '2401.10002v1', mirrorVersion: '3' },
      });

      // No HTML fetched for the substituted version — or for any version.
      expect(htmlCalls()).toEqual([]);
    });

    it('serves a version-pinned read from the mirror when the stored version matches', async () => {
      mockLiveDownButHtmlUp();
      const ctx = createMockContext({ errors: arxivReadPaper.errors! });
      const result = await service.readContent('2401.10002v3', {}, ctx);

      expect(result.paper_id).toBe('2401.10002v3');
      expect(htmlCalls()).toEqual(['https://arxiv.org/html/2401.10002v3']);
    });

    it('keeps degrading an unversioned read to the latest stored version', async () => {
      mockLiveDownButHtmlUp();
      const ctx = createMockContext({ errors: arxivReadPaper.errors! });
      const result = await service.readContent('2401.10002', {}, ctx);

      expect(result.paper_id).toBe('2401.10002v3');
      expect(result.title).toBe('Mirror Paper Two on Astrophysics');
      expect(result.source).toBe('arxiv_html');
      expect(htmlCalls()).toEqual(['https://arxiv.org/html/2401.10002v3']);
    });

    it('reports a paper the mirror does not hold at all as not found', async () => {
      mockLiveDownButHtmlUp();
      const ctx = createMockContext({ errors: arxivReadPaper.errors! });

      await expect(service.readContent('9999.99999v1', {}, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_match' },
      });
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

    // -----------------------------------------------------------------------
    // Issue #37 — co: and jr: were advertised in the query description, worked
    // on the live path, and matched nothing here.
    // -----------------------------------------------------------------------

    describe('co: and jr: prefixes (#37)', () => {
      beforeEach(async () => {
        const store = await MirrorStore.open(configOverrides.mirrorPath);
        store.applyBatch(
          [
            mkRecord({
              paper_id: '2401.10003',
              title: 'Mirror Paper Three on Optimization',
              abstract: 'Convergence bounds for stochastic solvers.',
              categories: 'math.OC',
              comments: 'Accepted at ICML 2021, 12 pages',
              journal_ref: 'Nature Physics 17 (2021) 123',
            }),
          ],
          [],
        );
        store.close();
      });

      const idsFor = async (query: string): Promise<string[]> => {
        const ctx = createMockContext();
        const result = await service.search(query, { maxResults: 10 }, ctx);
        expect(mockFetch).not.toHaveBeenCalled();
        return result.papers.map((p) => p.id);
      };

      it('resolves a comment search', async () => {
        expect(await idsFor('co:ICML')).toEqual(['2401.10003v1']);
      });

      it('resolves a journal-ref search', async () => {
        expect(await idsFor('jr:Nature')).toEqual(['2401.10003v1']);
      });

      it('keeps a quoted comment value a single phrase', async () => {
        expect(await idsFor('co:"12 pages"')).toEqual(['2401.10003v1']);
        expect(await idsFor('co:"pages 12"')).toEqual([]);
      });

      it('composes with the other prefixes and with cat:', async () => {
        expect(await idsFor('co:ICML AND jr:Nature')).toEqual(['2401.10003v1']);
        expect(await idsFor('co:ICML AND cat:math.OC')).toEqual(['2401.10003v1']);
        expect(await idsFor('co:ICML AND cat:cs.LG')).toEqual([]);
        expect(await idsFor('co:ICML OR ti:transformers')).toEqual(
          expect.arrayContaining(['2401.10003v1', '2401.10001v1']),
        );
      });

      it('reaches the comment from all: and from a bare term', async () => {
        expect(await idsFor('all:ICML')).toEqual(['2401.10003v1']);
        expect(await idsFor('ICML')).toEqual(['2401.10003v1']);
      });
    });

    // -----------------------------------------------------------------------
    // Issue #36 — a cat: operand in the query text means the same subtree on
    // both paths, and stays an independent filter from the category parameter.
    // -----------------------------------------------------------------------

    describe('cat: in query text (#36)', () => {
      it('reads a bare archive code in the query as its whole subtree', async () => {
        const ctx = createMockContext();
        // 2401.10002 is filed under astro-ph.CO; 9901.00001 under bare astro-ph.
        const result = await service.search('cat:astro-ph', { maxResults: 10 }, ctx);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result.papers.map((p) => p.id).sort()).toEqual(['2401.10002v3']);
      });

      it('sends the expanded operand to the live API and echoes what it sent', async () => {
        configOverrides.mirrorEnabled = false;
        resetStore();
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
        const ctx = createMockContext();
        const result = await service.search('ti:attention AND cat:cs', { maxResults: 10 }, ctx);

        const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
        // A bare `cat:cs` matches nothing upstream — arXiv never assigns the
        // bare group name — so the operand has to carry the subtree.
        expect(url.searchParams.get('search_query')).toBe('ti:attention AND cat:cs*');
        expect(result.effective_query).toBe('ti:attention AND cat:cs*');
      });

      it('spells out an archive whose wildcard would leak a neighbour', async () => {
        configOverrides.mirrorEnabled = false;
        resetStore();
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
        const ctx = createMockContext();
        await service.search('cat:math', { maxResults: 10 }, ctx);

        const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
        expect(url.searchParams.get('search_query')).toBe('(cat:math.* OR cat:math)');
      });

      it('leaves a leaf code and the rest of the query untouched', async () => {
        configOverrides.mirrorEnabled = false;
        resetStore();
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
        const ctx = createMockContext();
        await service.search(
          'au:"hinton g" AND cat:cs.LG ANDNOT ti:survey',
          { maxResults: 10 },
          ctx,
        );

        const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
        expect(url.searchParams.get('search_query')).toBe(
          'au:"hinton g" AND cat:cs.LG ANDNOT ti:survey',
        );
      });

      it('intersects a query cat: with the category parameter rather than widening', async () => {
        // 2401.10001 is cs.LG + cs.AI; 2401.10002 is astro-ph.CO. Asking for
        // cs.AI in the query and astro-ph in the parameter must match neither.
        const ctx = createMockContext();
        const both = await service.search(
          'cat:cs.AI',
          { maxResults: 10, category: 'astro-ph' },
          ctx,
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(both.papers).toEqual([]);

        // The same pair on a paper carrying a code from each group does match.
        const overlap = await service.search(
          'cat:cs.AI',
          { maxResults: 10, category: 'cs.LG' },
          ctx,
        );
        expect(overlap.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
      });

      it('composes the two filters into one coherent live query', async () => {
        configOverrides.mirrorEnabled = false;
        resetStore();
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
        const ctx = createMockContext();
        const result = await service.search(
          'cat:cs.AI',
          { maxResults: 10, category: 'astro-ph' },
          ctx,
        );

        // Both operands survive, AND-ed — the same intersection the mirror applies.
        expect(result.effective_query).toBe('(cat:cs.AI) AND cat:astro-ph*');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Bare archive codes on the mirror path (#32). The live path reaches a whole
  // archive with `cat:astro-ph*`, which covers the legacy flat papers filed
  // before the archive was subdivided. Expanding to the dotted subject classes
  // alone makes the mirror quietly narrower than live for the same input.
  // -------------------------------------------------------------------------

  describe('bare archive categories (#32)', () => {
    beforeEach(async () => {
      const store = await MirrorStore.open(configOverrides.mirrorPath);
      store.applyBatch(
        [
          mkRecord({
            paper_id: '9901.00001',
            title: 'Legacy Flat Astrophysics Paper',
            abstract: 'Cosmic ray observations from before the archive was subdivided.',
            // Filed against the bare archive, as pre-2009 astro-ph papers are.
            categories: 'astro-ph',
            versions: [{ version: 'v1', date: '1999-01-11T00:00:00Z' }],
          }),
        ],
        [],
      );
      store.close();
    });

    it('covers legacy flat papers as well as subject classes', async () => {
      const ctx = createMockContext();
      const result = await service.search(
        'abs:cosmic',
        { maxResults: 10, category: 'astro-ph' },
        ctx,
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers.map((p) => p.id).sort()).toEqual(['2401.10002v3', '9901.00001v1']);
    });

    it('keeps a leaf code scoped to that subject class alone', async () => {
      const ctx = createMockContext();
      const result = await service.search(
        'abs:cosmic',
        { maxResults: 10, category: 'astro-ph.CO' },
        ctx,
      );

      expect(result.papers.map((p) => p.id)).toEqual(['2401.10002v3']);
    });

    it('reaches the same rows through the cat: wildcard the live path emits', async () => {
      const ctx = createMockContext();
      const viaOption = await service.search(
        'abs:cosmic',
        { maxResults: 10, category: 'astro-ph' },
        ctx,
      );
      const viaWildcard = await service.search(
        'abs:cosmic AND cat:astro-ph*',
        { maxResults: 10 },
        ctx,
      );

      expect(viaWildcard.papers.map((p) => p.id).sort()).toEqual(
        viaOption.papers.map((p) => p.id).sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Submitted-date windows on the mirror path (#27), and the echo that has to
  // survive a replay (#20). Boundary records are the point: arXiv compares a
  // window bound against the full-precision submission timestamp, so an encoding
  // that stops at `…2359` drops a day's final seconds into no window at all.
  // -------------------------------------------------------------------------

  describe('submitted-date windows (#27)', () => {
    /** paper_id → submission instant, chosen to sit on the interesting edges. */
    const WINDOW_PAPERS: Record<string, string> = {
      '2403.00000': '2024-03-09T23:59:59Z', // last instant before the window opens
      '2403.00001': '2024-03-10T00:00:00Z', // exactly the opening instant
      '2403.00002': '2024-03-10T12:00:00Z',
      '2403.00003': '2024-03-10T23:59:30Z', // the record a `…2359` bound loses
      '2403.00004': '2024-03-11T08:00:00Z',
      '2403.00005': '2024-03-12T05:00:00Z',
      '2403.00006': '2024-03-13T00:00:00Z', // exactly a shared window boundary
    };

    beforeEach(async () => {
      const store = await MirrorStore.open(configOverrides.mirrorPath);
      store.applyBatch(
        Object.entries(WINDOW_PAPERS).map(([paper_id, date]) =>
          mkRecord({
            paper_id,
            title: 'Windowed Chronometry Paper',
            abstract: 'A paper used to probe submitted-date window boundaries.',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date }],
          }),
        ),
        [],
      );
      store.close();
    });

    const idsOf = async (options: Record<string, unknown>): Promise<string[]> => {
      const ctx = createMockContext();
      const result = await service.search('ti:chronometry', { maxResults: 50, ...options }, ctx);
      return result.papers.map((p) => p.id).sort();
    };

    it('bounds a window inclusively at both ends', async () => {
      const ids = await idsOf({ submittedFrom: '2024-03-10', submittedTo: '2024-03-10' });
      // Opens on the 00:00:00 record, and still holds the 23:59:30 one.
      expect(ids).toEqual(['2403.00001v1', '2403.00002v1', '2403.00003v1']);
      expect(ids).not.toContain('2403.00000v1');
    });

    it('reconstructs the unpartitioned set from adjacent windows, by record identity', async () => {
      const whole = await idsOf({ submittedFrom: '2024-03-10', submittedTo: '2024-03-12' });
      const first = await idsOf({ submittedFrom: '2024-03-10', submittedTo: '2024-03-10' });
      const second = await idsOf({ submittedFrom: '2024-03-11', submittedTo: '2024-03-12' });

      const union = [...new Set([...first, ...second])].sort();
      // Coverage is the property under test: the union is the unpartitioned set,
      // so no record falls between the windows.
      expect(union).toEqual(whole);
      // This split carries no record at its 2024-03-11T00:00:00Z seam, which is
      // the only reason the halves are disjoint too. Asserted so the disjointness
      // below rests on the fixture rather than reading as a property of windowing
      // in general — a record sitting on a seam belongs to both halves by design,
      // which `shares the boundary instant rather than dropping it` covers.
      expect(Object.values(WINDOW_PAPERS)).not.toContain('2024-03-11T00:00:00Z');
      expect(first.length + second.length).toBe(whole.length);
      expect(first.filter((id) => second.includes(id))).toEqual([]);
      // The canary: a `…2359` upper bound would strand this one in no window.
      expect(whole).toContain('2403.00003v1');
      expect(first).toContain('2403.00003v1');
    });

    it('shares the boundary instant rather than dropping it', async () => {
      // arXiv's range includes both endpoints, so a record submitted at exactly
      // midnight lands in both adjacent windows. A duplicate is the trade for
      // never leaving a hole — the behavior is documented, not accidental.
      const first = await idsOf({ submittedFrom: '2024-03-12', submittedTo: '2024-03-12' });
      const second = await idsOf({ submittedFrom: '2024-03-13', submittedTo: '2024-03-13' });

      expect(first).toContain('2403.00006v1');
      expect(second).toContain('2403.00006v1');
    });

    it('honors an open-ended window on either side', async () => {
      expect(await idsOf({ submittedFrom: '2024-03-12' })).toEqual([
        '2403.00005v1',
        '2403.00006v1',
      ]);
      // The shared boundary instant again: an upper bound of 2024-03-09 closes at
      // 2024-03-10T00:00:00Z, which is exactly when 2403.00001 was submitted.
      expect(await idsOf({ submittedTo: '2024-03-09' })).toEqual(['2403.00000v1', '2403.00001v1']);
    });

    it('narrows the result set the same way the live path would', async () => {
      const unbounded = await idsOf({});
      const windowed = await idsOf({ submittedFrom: '2024-03-11', submittedTo: '2024-03-12' });
      expect(windowed.length).toBeLessThan(unbounded.length);
      expect(unbounded).toEqual(expect.arrayContaining(windowed));
    });

    // Issue #20 acceptance on the mirror path: the echo names every filter that
    // was applied, and replaying it as the bare query reproduces the same rows.
    it('replays effective_query to the identical result set', async () => {
      const ctx = createMockContext();
      const original = await service.search(
        'ti:chronometry',
        {
          maxResults: 50,
          category: 'cs.LG',
          submittedFrom: '2024-03-10',
          submittedTo: '2024-03-12',
        },
        ctx,
      );
      expect(original.effective_query).toBe(
        '(ti:chronometry) AND cat:cs.LG AND submittedDate:[202403100000 TO 202403130000]',
      );

      const replay = await service.search(original.effective_query, { maxResults: 50 }, ctx);

      expect(replay.total_results).toBe(original.total_results);
      expect(replay.papers.map((p) => p.id).sort()).toEqual(
        original.papers.map((p) => p.id).sort(),
      );
      // The replay must be narrower than the same query with no filters at all,
      // or "reproduces the result set" is passing for the wrong reason.
      const unfiltered = await service.search('ti:chronometry', { maxResults: 50 }, ctx);
      expect(replay.total_results).toBeLessThan(unfiltered.total_results);
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
