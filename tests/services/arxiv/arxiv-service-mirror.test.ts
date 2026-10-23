/**
 * @fileoverview End-to-end tests for ArxivService's mirror integration —
 * seeds a real SQLite mirror with a handful of records, then verifies
 * `getPapers` and the `searchMirror` private path resolve against it rather
 * than the live API. Covers the slot-based fallback merge introduced for
 * issue #12 along with FTS5 + category-filter behavior.
 * @module services/arxiv/arxiv-service-mirror.test
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paperResource } from '@/mcp-server/resources/definitions/paper.resource.js';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { arxivSearchPapers } from '@/mcp-server/tools/definitions/arxiv-search-papers.tool.js';
import { ArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';
import {
  closeReaderWorker,
  fromWireError,
  type MirrorSearcher,
  searchInThread,
  toWireError,
} from '@/services/arxiv/mirror/reader.js';
import { MirrorStore, resetStore } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const configOverrides: {
  apiTimeoutMs: number;
  mirrorEnabled: boolean;
  mirrorFallbackLive: boolean;
  mirrorPath: string;
  mirrorRecentDaysLive: number;
  readTimeoutMs: number;
  requestDelayMs: number;
} = {
  apiTimeoutMs: 5000,
  mirrorEnabled: true,
  mirrorPath: '',
  mirrorFallbackLive: true,
  mirrorRecentDaysLive: 0,
  readTimeoutMs: 50_000,
  requestDelayMs: 0,
};

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: configOverrides.requestDelayMs,
    contentTimeoutMs: 5000,
    apiTimeoutMs: configOverrides.apiTimeoutMs,
    readTimeoutMs: configOverrides.readTimeoutMs,
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

/** Add `hep-th/9901001` to the mirror at its latest version, v3. */
async function seedHepTh9901001(): Promise<void> {
  const store = await MirrorStore.open(configOverrides.mirrorPath);
  store.applyBatch(
    [
      mkRecord({
        paper_id: 'hep-th/9901001',
        identifier: 'oai:arXiv.org:hep-th/9901001',
        title: 'String Junctions and Their Duals in Heterotic String Theory',
        categories: 'hep-th',
        versions: [
          { version: 'v1', date: '1999-01-01T01:01:10Z' },
          { version: 'v2', date: '1999-01-20T00:00:00Z' },
          { version: 'v3', date: '1999-05-10T04:45:54Z' },
        ],
      }),
    ],
    [],
  );
  store.close();
}

/** A captured arXiv API response from `tests/fixtures/arxiv-api/`. */
function capturedFeed(name: string): string {
  return readFileSync(new URL(`../../fixtures/arxiv-api/${name}.xml`, import.meta.url), 'utf8');
}

/**
 * Answer `id_list` lookups the way arXiv does for `hep-th/9901001`: HTTP 500
 * with its internal-error feed for a list holding `v1`, otherwise the response
 * captured for that list. A list nothing was captured for, or any other host,
 * is refused.
 */
function serveCapturedLookups(): void {
  mockFetch.mockImplementation(async (request) => {
    const url = new URL(String(request));
    if (url.hostname !== 'export.arxiv.org') throw new Error(`Unexpected request: ${url}`);
    const idList = url.searchParams.get('id_list') ?? '';
    if (idList.split(',').includes('hep-th/9901001v1')) {
      return new Response(capturedFeed('http-500'), {
        status: 500,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      });
    }
    return atomResponse(capturedFeed(idList.replaceAll('/', '_').replaceAll(',', '+')));
  });
}

/**
 * Give the mirror at `path` the schema-v2 shape: a three-column FTS index and
 * `schema_version` 2. One statement per call, so no fixture step is skipped.
 */
function downgradeToV2(path: string): void {
  const db = new Database(path);
  for (const sql of [
    'DROP TRIGGER papers_ai',
    'DROP TRIGGER papers_ad',
    'DROP TRIGGER papers_au',
    'DROP TABLE papers_fts',
    `CREATE VIRTUAL TABLE papers_fts USING fts5(title, authors, abstract, content='papers', content_rowid='rowid')`,
    'INSERT INTO papers_fts(rowid, title, authors, abstract) SELECT rowid, title, authors, abstract FROM papers',
    'DELETE FROM schema_version',
    `INSERT INTO schema_version(version, applied_at) VALUES (2, '2025-06-01T00:00:00.000Z')`,
  ]) {
    db.run(sql);
  }
  db.close();
}

/** The schema version and FTS columns of the file at `path`, read on its own connection. */
function schemaShape(path: string): { ftsColumns: string[]; version: number } {
  const db = new Database(path, { readonly: true });
  const { version } = db.query('SELECT version FROM schema_version').get() as { version: number };
  const columns = db.query('PRAGMA table_info(papers_fts)').all() as { name: string }[];
  db.close();
  return { version, ftsColumns: columns.map((c) => c.name) };
}

/** Answer every arXiv API request with `ATOM_LIVE_PAPER`; refuse any other host. */
function serveLivePaper(): void {
  mockFetch.mockImplementation(async (request) => {
    const url = new URL(String(request));
    if (url.hostname !== 'export.arxiv.org') throw new Error(`Unexpected request: ${url}`);
    return atomResponse(ATOM_LIVE_PAPER);
  });
}

/** The `id_list` of every request made so far, in order (empty for a non-API request). */
function idLists(): string[] {
  return mockFetch.mock.calls.map(
    ([request]) => new URL(String(request)).searchParams.get('id_list') ?? '',
  );
}

/**
 * A real error the SQLite driver raises, for a stubbed store call to throw. Its
 * text is one the framework would classify as `NotFound` by its wording.
 */
function sqliteDriverError(): Error {
  const db = new Database(':memory:');
  try {
    db.query('SELECT * FROM missing_table').all();
  } catch (err) {
    return err as Error;
  } finally {
    db.close();
  }
  throw new Error('the driver accepted a query on a missing table');
}

/** arXiv's answer to a term the mirror's match cap sends live. */
const ATOM_AT_CAP = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1025313</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2402.99999v1</id>
    <title>From Live API</title>
    <summary>Answered by arXiv.</summary>
    <author><name>Live Author</name></author>
    <category term="cs.AI" />
    <published>2024-02-15T00:00:00Z</published>
    <updated>2024-02-15T00:00:00Z</updated>
  </entry>
</feed>`;

/**
 * Write `count` cs.LG papers whose abstract is `term` straight into the mirror
 * file. A test that seeds a corpus the size of the match cap takes a 30 s
 * timeout, sized for a loaded machine.
 */
function seedBulk(count: number, term: string): void {
  const db = new Database(configOverrides.mirrorPath);
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
    `INSERT INTO paper_categories(category, paper_id, updated, published)
     SELECT 'cs.LG', id, updated, published FROM papers WHERE id LIKE 'bulk.%'`,
  ).run();
  db.close();
}

describe('ArxivService — mirror integration', () => {
  let dir: string;
  let service: ArxivService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-svc-mirror-test-'));
    configOverrides.mirrorPath = join(dir, 'mirror.db');
    configOverrides.mirrorEnabled = true;
    configOverrides.mirrorFallbackLive = true;
    configOverrides.mirrorRecentDaysLive = 0;
    configOverrides.readTimeoutMs = 50_000;
    configOverrides.apiTimeoutMs = 5000;
    configOverrides.requestDelayMs = 0;

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
    // A request no test mocked is refused rather than answered with `undefined`.
    mockFetch.mockImplementation(async (url) => {
      throw new Error(`Unmocked request: ${url}`);
    });
    // In-thread, so the store spies below see each search. The reader-worker
    // block at the end runs the default searcher over the same fixtures.
    service = new ArxivService({ mirrorSearcher: searchInThread });
  });

  afterEach(async () => {
    await closeReaderWorker();
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

    it('keeps the live miss reason for a superseded version and the papers the mirror served (#53)', async () => {
      // The mirror holds hep-th/9901001 at v3, so the v1 pin goes live, where
      // arXiv answers HTTP 500 for it.
      await seedHepTh9901001();
      serveCapturedLookups();
      const result = await service.getPapers(
        ['2401.10001', 'hep-th/9901001v1', 'hep-th/9901001'],
        createMockContext(),
      );

      expect(idLists()).toEqual(['hep-th/9901001v1', 'hep-th/9901001']);
      expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1', 'hep-th/9901001v3']);
      expect(result.not_found).toEqual([
        {
          id: 'hep-th/9901001v1',
          reason: 'version_not_served',
          detail: expect.stringContaining('the latest version is v3'),
        },
      ]);
    });

    it('still reports a mirror version miss without live fallback (#35, #53)', async () => {
      await seedHepTh9901001();
      configOverrides.mirrorFallbackLive = false;
      const result = await service.getPapers(['hep-th/9901001v1'], createMockContext());

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.not_found).toEqual([
        {
          id: 'hep-th/9901001v1',
          reason: 'version_not_in_mirror',
          detail: expect.stringContaining("'hep-th/9901001v3'"),
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // getPapers — a failed live patch-up keeps what the mirror served (#67)
  // -------------------------------------------------------------------------

  describe('getPapers — a failed live patch-up keeps what the mirror served (#67)', () => {
    const http503 = (): Response =>
      new Response('<feed/>', {
        status: 503,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      });
    const rateExceeded = (): Response =>
      new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } });
    const textOf = (result: { content: { type: string; text?: string }[] }): string =>
      result.content.map((block) => block.text ?? '').join('\n');

    // [failure, how the live API answers, what the detail names, requests sent]
    const failures: [string, () => void, string, number][] = [
      [
        'HTTP 503 after its retry',
        () => mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503()),
        'arXiv API returned HTTP 503 (failed after 2 attempts)',
        2,
      ],
      [
        'a rate limit, never retried',
        () => mockFetch.mockResolvedValueOnce(rateExceeded()),
        'arXiv rate limit exceeded',
        1,
      ],
      [
        'a timeout, never retried',
        () =>
          mockFetch.mockRejectedValueOnce(
            new DOMException('The operation timed out.', 'TimeoutError'),
          ),
        'arXiv API timed out',
        1,
      ],
      [
        'a network error after its retry',
        () =>
          mockFetch
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed')),
        'arXiv API network error',
        2,
      ],
    ];
    for (const [failure, answer, named, requests] of failures) {
      it(`returns the mirror's papers and names the live-only ID on ${failure}`, async () => {
        answer();
        const result = await service.getPapers(['2401.10001', '2402.99999'], createMockContext());

        expect(mockFetch).toHaveBeenCalledTimes(requests);
        expect(idLists()).toEqual(Array(requests).fill('2402.99999'));
        expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
        expect(result.not_found).toEqual([
          { id: '2402.99999', reason: 'live_lookup_failed', detail: expect.any(String) },
        ]);
        const detail = result.not_found?.[0]?.detail ?? '';
        expect(detail).toContain(named);
        expect(detail).toContain('same call made again may serve it');
      }, 30_000);
    }

    it('names the version the mirror holds for a pin whose live lookup failed', async () => {
      mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503());
      const result = await service.getPapers(['2401.10002', '2401.10001v9'], createMockContext());

      expect(result.papers.map((p) => p.id)).toEqual(['2401.10002v3']);
      expect(result.not_found).toEqual([
        {
          id: '2401.10001v9',
          reason: 'live_lookup_failed',
          detail: expect.stringContaining("'2401.10001v1'"),
        },
      ]);
    }, 30_000);

    it('fails with the live error when every ID needed the live lookup', async () => {
      // 2401.10001v9 is a version the mirror lacks, so the mirror serves nothing.
      mockFetch.mockImplementation(async () => http503());

      await expect(
        service.getPapers(['2402.99999', '2401.10001v9'], createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'arXiv API returned HTTP 503 (failed after 2 attempts)',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 30_000);

    it('keeps failing on a lookup error a retry would not fix', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } }),
      );

      await expect(
        service.getPapers(['2401.10001', '2402.99999'], createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidRequest });
    });

    it('fails a call cancelled during the patch-up, never answering from the mirror', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementationOnce(async () => {
        controller.abort(new DOMException('The client cancelled the call.', 'AbortError'));
        return http503();
      });

      await expect(
        service.getPapers(
          ['2401.10001', '2402.99999'],
          createMockContext({ signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'The client cancelled the call.' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('carries the partial result on both surfaces of arxiv_get_metadata', async () => {
      initArxivService();
      mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503());
      const result = await runToolContract(arxivGetMetadata, {
        paper_ids: ['2401.10001', '2402.99999'],
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const output = arxivGetMetadata.output.parse(result.structuredContent);
      expect(output.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
      expect(output.not_found).toEqual([
        {
          id: '2402.99999',
          reason: 'live_lookup_failed',
          detail: expect.stringContaining('HTTP 503'),
        },
      ]);
      const text = textOf(result);
      expect(text).toContain('Found 1 of 2 papers.');
      expect(text).toContain('arXiv:2401.10001v1 |');
      expect(text).toContain(`- 2402.99999 (live_lookup_failed): ${output.not_found?.[0]?.detail}`);
    }, 30_000);

    it('fails arxiv_get_metadata and the paper resource with the live error when the mirror served nothing', async () => {
      initArxivService();
      mockFetch.mockImplementation(async () => http503());

      const metadata = await runToolContract(arxivGetMetadata, { paper_ids: ['2402.99999'] });
      expect(metadata.isError).toBe(true);
      const error = (metadata.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('HTTP 503');
      expect(textOf(metadata)).toContain('HTTP 503');

      const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
        typeof paperResource.handler
      >[1];
      await expect(paperResource.handler({ paperId: '2402.99999' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    }, 30_000);

    it('reports a call cancelled during the patch-up as cancelled on both surfaces', async () => {
      initArxivService();
      const controller = new AbortController();
      mockFetch.mockImplementationOnce(async () => {
        controller.abort(new DOMException('The client cancelled the call.', 'AbortError'));
        return http503();
      });
      const result = await runToolContract(
        arxivGetMetadata,
        { paper_ids: ['2401.10001', '2402.99999'] },
        { context: { signal: controller.signal } },
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(textOf(result)).toContain('The client cancelled the call.');
      expect(textOf(result)).not.toContain('2401.10001v1');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // readContent — a superseded old-style version arXiv answers HTTP 500 for (#53)
  // -------------------------------------------------------------------------

  describe('readContent — a superseded old-style version arXiv answers HTTP 500 for (#53)', () => {
    beforeEach(async () => {
      await seedHepTh9901001();
      serveCapturedLookups();
    });

    it('fails version_not_served naming the latest version and the PDF, with no body fetch', async () => {
      await expect(
        service.readContent('hep-th/9901001v1', {}, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('the latest version is v3'),
        data: {
          reason: 'version_not_served',
          paperId: 'hep-th/9901001v1',
          pdfUrl: 'https://arxiv.org/pdf/hep-th/9901001v1',
        },
      });
      expect(idLists()).toEqual(['hep-th/9901001v1', 'hep-th/9901001']);
    });

    it('carries the reason, the detail, and no retry hint on both surfaces of arxiv_read_paper', async () => {
      initArxivService();
      const result = await runToolContract(arxivReadPaper, { paper_id: 'hep-th/9901001v1' });

      expect(result.isError, JSON.stringify(result)).toBe(true);
      const error = (result.structuredContent as { error: { code: number; data: object } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'version_not_served' });
      expect(error.data).not.toHaveProperty('retryable', true);
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('the latest version is v3');
      expect(text).toContain('https://arxiv.org/pdf/hep-th/9901001v1');
      expect(text).toContain('(reason version_not_served)');
      expect(idLists()).toEqual(['hep-th/9901001v1', 'hep-th/9901001']);
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
      mockFetch.mockImplementation(async (request: string) => {
        const { hostname } = new URL(String(request));
        if (hostname === 'export.arxiv.org') {
          return new Response('Rate exceeded.', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        if (hostname === 'arxiv.org') {
          return new Response(
            '<html><head></head><body><article>Body text.</article></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        throw new Error(`Unexpected request: ${request}`);
      });
    }

    const htmlCalls = (): string[] =>
      mockFetch.mock.calls
        .map(([request]) => String(request))
        .filter((url) => new URL(url).hostname !== 'export.arxiv.org');

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

    it('fails a read whose deadline passes during the lookup, never reading the mirror (#69)', async () => {
      // The API hangs past the read's deadline but inside its own timeout; the
      // mirror holds the paper and HTML is up, so only the deadline ends the read.
      configOverrides.readTimeoutMs = 300;
      mockFetch.mockImplementation((request: string, init?: RequestInit) => {
        if (new URL(String(request)).hostname === 'export.arxiv.org') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve(
          new Response('<html><body><article><p>Body text.</p></article></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
      });
      // Every clock the read runs on, its deadline and each request's timeout
      // included, on vitest's fake `setTimeout`.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
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
      const lookupSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds');
      /** Advance the fake clock by `ms`, then let the work it released run. */
      const advance = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      try {
        let failure: unknown;
        const read = service.readContent('2401.10002', {}, createMockContext()).then(
          (result) => {
            throw new Error(`readContent resolved with ${result.paper_id}`);
          },
          (err: unknown) => {
            failure = err;
          },
        );

        await advance(299);
        expect(failure).toBeUndefined();
        await advance(1);
        expect(failure).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          message:
            "Reading arXiv paper '2401.10002' timed out after 300ms; the request to arXiv API was still open.",
        });
        await read;
        expect(mockFetch.mock.calls.map(([request]) => new URL(String(request)).hostname)).toEqual([
          'export.arxiv.org',
        ]);
        expect(lookupSpy).not.toHaveBeenCalled();
      } finally {
        lookupSpy.mockRestore();
        timeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    /**
     * Rate-limit the API, answer arxiv.org/html with a 404, and serve an ar5iv
     * render, routed by host. Returns the content URLs requested, in order.
     */
    function mockLiveDownAndAr5ivOnly(): string[] {
      const requested: string[] = [];
      mockFetch.mockImplementation(async (request: string) => {
        const url = new URL(String(request));
        if (url.hostname === 'export.arxiv.org') {
          return new Response('Rate exceeded.', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        requested.push(url.href);
        if (url.hostname === 'arxiv.org') return new Response('Not Found', { status: 404 });
        if (url.hostname === 'ar5iv.labs.arxiv.org') {
          return new Response(
            '<article><h2 class="ltx_title ltx_title_section">1 Intro</h2><p>Body.</p></article>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      return requested;
    }

    it('flags an ar5iv body for an unversioned read the mirror resolves to a later version (#63)', async () => {
      const requested = mockLiveDownAndAr5ivOnly();
      const result = await service.readContent('2401.10002', {}, createMockContext());

      expect(result.paper_id).toBe('2401.10002v3');
      expect(result.source).toBe('ar5iv');
      expect(result.revision_unconfirmed).toBe(true);
      expect(requested).toEqual([
        'https://arxiv.org/html/2401.10002v3',
        'https://ar5iv.labs.arxiv.org/html/2401.10002v3',
      ]);
    });

    it('flags an ar5iv body even at v1 when the mirror resolved the version (#63, #79)', async () => {
      // A stored v1 can trail a revision arXiv has published since the last
      // refresh, so only a live lookup establishes that v1 is the only version.
      mockLiveDownAndAr5ivOnly();
      const result = await service.readContent('2401.10001', {}, createMockContext());

      expect(result.paper_id).toBe('2401.10001v1');
      expect(result.source).toBe('ar5iv');
      expect(result.revision_unconfirmed).toBe(true);
    });

    it('fails with the live error, not no_match, for a paper the mirror does not hold at all (#68)', async () => {
      mockLiveDownButHtmlUp();
      const ctx = createMockContext({ errors: arxivReadPaper.errors! });

      await expect(service.readContent('9999.99999v1', {}, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited' },
      });
      expect(htmlCalls()).toEqual([]);
    });

    it('fails with the live error, never the store error, when the mirror read throws (#76)', async () => {
      mockLiveDownButHtmlUp();
      const corrupt = Object.assign(new Error('database disk image is malformed'), {
        name: 'SQLiteError',
        code: 'SQLITE_CORRUPT',
      });
      const readSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds').mockImplementation(() => {
        throw corrupt;
      });
      try {
        const ctx = createMockContext({ errors: arxivReadPaper.errors! });
        const warning = vi.spyOn(ctx.log, 'warning');
        await expect(service.readContent('2401.10002', {}, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'rate_limited' },
        });
        expect(warning).toHaveBeenCalledWith(
          'Mirror read failed for readContent metadata; using the live lookup',
          { paperId: '2401.10002', error: 'database disk image is malformed' },
        );
        expect(htmlCalls()).toEqual([]);

        // A pinned read through the tool, on both surfaces: the live failure, no SQLite text.
        initArxivService();
        const result = await runToolContract(arxivReadPaper, { paper_id: '2401.10002v3' });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.message).toContain('arXiv rate limit exceeded');
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('arXiv rate limit exceeded');
        expect(JSON.stringify(result)).not.toContain('malformed');
        expect(readSpy).toHaveBeenCalledTimes(2);
      } finally {
        readSpy.mockRestore();
      }
    });

    it('lets an error the driver did not raise from the mirror read propagate (#76)', async () => {
      mockLiveDownButHtmlUp();
      const readSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds').mockImplementation(() => {
        throw new TypeError('a bug in the mirror path');
      });
      try {
        await expect(service.readContent('2401.10002', {}, createMockContext())).rejects.toThrow(
          new TypeError('a bug in the mirror path'),
        );
        expect(readSpy).toHaveBeenCalledTimes(1);
        expect(htmlCalls()).toEqual([]);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // readContent — a live failure on a paper the mirror does not hold (#68)
  // -------------------------------------------------------------------------

  describe('readContent — a live failure on a paper the mirror does not hold (#68)', () => {
    const http503 = (): Response =>
      new Response('<feed/>', {
        status: 503,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      });
    const textOf = (result: { content: { type: string; text?: string }[] }): string =>
      result.content.map((block) => block.text ?? '').join('\n');
    /** The hostname of every request made so far, in order. */
    const hosts = (): string[] =>
      mockFetch.mock.calls.map(([request]) => new URL(String(request)).hostname);
    /** The rejection of a `readContent` call on a fresh service; a resolved call fails the test. */
    const readError = (id: string, signal?: AbortSignal): Promise<unknown> =>
      new ArxivService().readContent(id, {}, createMockContext(signal ? { signal } : {})).then(
        (result) => {
          throw new Error(`readContent('${id}') resolved with ${result.paper_id}`);
        },
        (err: unknown) => err,
      );
    const shapeOf = (err: unknown) => {
      if (!(err instanceof McpError)) throw new Error(`Not an McpError: ${String(err)}`);
      return { code: err.code, message: err.message, data: err.data };
    };

    // [failure, how the live API answers one read, requests that read sends]
    const failures: [string, () => void, number][] = [
      [
        'HTTP 503 after its retry',
        () => mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503()),
        2,
      ],
      [
        'a rate limit, never retried',
        () =>
          mockFetch.mockResolvedValueOnce(
            new Response('Rate exceeded.', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            }),
          ),
        1,
      ],
      [
        'a timeout, never retried',
        () =>
          mockFetch.mockRejectedValueOnce(
            new DOMException('The operation timed out.', 'TimeoutError'),
          ),
        1,
      ],
      [
        'a network error after its retry',
        () =>
          mockFetch
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed')),
        2,
      ],
      [
        'a lookup arXiv rejected',
        () =>
          mockFetch.mockResolvedValueOnce(
            new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } }),
          ),
        1,
      ],
    ];
    for (const [failure, answer, requests] of failures) {
      it(`fails with the error a read without the mirror gets, on ${failure}`, async () => {
        configOverrides.mirrorEnabled = false;
        answer();
        const withoutMirror = shapeOf(await readError('0704.0001v1'));
        configOverrides.mirrorEnabled = true;
        answer();
        const withMirror = shapeOf(await readError('0704.0001v1'));

        expect(withMirror).toEqual(withoutMirror);
        expect(withMirror.code).not.toBe(JsonRpcErrorCode.NotFound);
        expect(withMirror.data).not.toHaveProperty('reason', 'no_match');
        expect(hosts()).toEqual(Array(2 * requests).fill('export.arxiv.org'));
      }, 30_000);
    }

    it('fails an unversioned read with the live error as well', async () => {
      mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503());

      expect(shapeOf(await readError('0704.0001'))).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'arXiv API returned HTTP 503 (failed after 2 attempts)',
      });
      expect(hosts()).toEqual(['export.arxiv.org', 'export.arxiv.org']);
    }, 30_000);

    it('carries the live error, and no not-found hint, on both surfaces of arxiv_read_paper', async () => {
      initArxivService();
      mockFetch.mockResolvedValueOnce(http503()).mockResolvedValueOnce(http503());
      const result = await runToolContract(arxivReadPaper, { paper_id: '0704.0001v1' });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { code: number; message: string; data: object } }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('arXiv API returned HTTP 503 (failed after 2 attempts)');
      expect(error.data).not.toHaveProperty('reason');
      const text = textOf(result);
      expect(text).toContain('arXiv API returned HTTP 503 (failed after 2 attempts)');
      expect(text).not.toContain('Verify the');
      expect(text).not.toContain('no_match');
    }, 30_000);

    /** Abort `controller` from inside the live lookup, the way a caller disconnect lands mid-fetch. */
    const abortDuringLookup = (controller: AbortController) =>
      mockFetch.mockImplementationOnce(async () => {
        controller.abort(new DOMException('The client cancelled the call.', 'AbortError'));
        return http503();
      });

    it('fails a call cancelled during the live lookup, never reading the mirror', async () => {
      const lookupSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds');
      try {
        // Each paper the mirror lacks, holds at another version (#33), or holds outright.
        for (const id of ['0704.0001v1', '2401.10002v1', '2401.10002']) {
          mockFetch.mockClear();
          const controller = new AbortController();
          abortDuringLookup(controller);

          expect(await readError(id, controller.signal), id).toMatchObject({
            name: 'AbortError',
            message: 'The client cancelled the call.',
          });
          expect(hosts(), id).toEqual(['export.arxiv.org']);
        }
        expect(lookupSpy).not.toHaveBeenCalled();
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it('reports a call cancelled during the live lookup as cancelled on both surfaces', async () => {
      initArxivService();
      const controller = new AbortController();
      abortDuringLookup(controller);
      const result = await runToolContract(
        arxivReadPaper,
        { paper_id: '2401.10002v1' },
        { context: { signal: controller.signal } },
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number } }).error;
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      const text = textOf(result);
      expect(text).toContain('The client cancelled the call.');
      expect(text).not.toContain('cannot be served locally');
      expect(hosts()).toEqual(['export.arxiv.org']);
    });
  });

  // -------------------------------------------------------------------------
  // readContent — an unversioned read waits on its live lookup at most
  // ARXIV_API_TIMEOUT_MS, queue wait included, when the mirror holds the paper (#79)
  // -------------------------------------------------------------------------

  describe('readContent — a pending live lookup gives way to the mirror at ARXIV_API_TIMEOUT_MS (#79)', () => {
    /** arXiv answering a lookup for `2401.10002` at v4, a revision the mirror (v3) has not seen. */
    const ATOM_LIVE_10002_V4 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.10002v4</id>
    <title>Mirror Paper Two on Astrophysics</title>
    <summary>Revision four, live only.</summary>
    <author><name>Carol Adams</name></author>
    <category term="astro-ph.CO" />
    <published>2024-01-15T00:00:00Z</published>
    <updated>2024-07-01T00:00:00Z</updated>
  </entry>
</feed>`;
    const HTML_BODY =
      '<html><body><article><h2 class="ltx_title ltx_title_section">1 Intro</h2><p>Body text.</p></article></body></html>';
    const corrupt = () =>
      Object.assign(new Error('database disk image is malformed'), {
        name: 'SQLiteError',
        code: 'SQLITE_CORRUPT',
      });

    let t0: number;
    let timeoutSpy: { mockRestore(): void };
    /** Each arXiv API request: its `id_list` and the fake-clock time it was sent. */
    let apiRequests: { at: number; idList: string }[];
    /** Each content request's URL, in order. */
    let contentRequests: string[];

    /** A response that never arrives: it rejects only when the request's signal aborts. */
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });

    /**
     * Route by host: the API through `api` (hanging by default), arxiv.org/html
     * through `html` (a body by default), and ar5iv as a 404 unless `ar5iv` serves it.
     */
    function route(
      api: (init: RequestInit | undefined, idList: string) => Promise<Response> = hang,
      { html = true, ar5iv = false }: { ar5iv?: boolean; html?: boolean } = {},
    ): void {
      mockFetch.mockImplementation((request: string, init?: RequestInit) => {
        const url = new URL(String(request));
        if (url.hostname === 'export.arxiv.org') {
          const idList = url.searchParams.get('id_list') ?? '';
          apiRequests.push({ at: Date.now() - t0, idList });
          return api(init, idList);
        }
        contentRequests.push(url.href);
        const serves = url.hostname === 'arxiv.org' ? html : ar5iv;
        return Promise.resolve(
          serves
            ? new Response(HTML_BODY, { status: 200, headers: { 'content-type': 'text/html' } })
            : new Response('Not Found', { status: 404 }),
        );
      });
    }

    /** Track `read` as it settles: the fake-clock time, and its value or error. */
    function timed<T>(read: Promise<T>) {
      const outcome: { at?: number; error?: unknown; value?: T } = {};
      read.then(
        (value) => {
          outcome.at = Date.now() - t0;
          outcome.value = value;
        },
        (error: unknown) => {
          outcome.at = Date.now() - t0;
          outcome.error = error;
        },
      );
      return outcome;
    }

    /** Advance the fake clock by `ms`, then let the work it released run. */
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    beforeEach(async () => {
      // The shipped timeouts: each lookup ahead in the queue holds it for 15 s
      // plus the 3 s etiquette delay, inside a 50 s read.
      configOverrides.apiTimeoutMs = 15_000;
      configOverrides.requestDelayMs = 3_000;
      configOverrides.readTimeoutMs = 50_000;
      const store = await MirrorStore.open(configOverrides.mirrorPath);
      store.applyBatch(
        [
          mkRecord({ paper_id: '2401.10003', title: 'Mirror Paper Three' }),
          mkRecord({
            paper_id: '2401.10004',
            title: 'Mirror Paper Four',
            versions: [
              { version: 'v1', date: '2024-01-10T00:00:00Z' },
              { version: 'v2', date: '2024-02-01T00:00:00Z' },
            ],
          }),
        ],
        [],
      );
      store.close();

      apiRequests = [];
      contentRequests = [];
      // Every clock the read runs on, its deadline, the cap, and each request's
      // timeout included, on vitest's fake `setTimeout`.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
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
      t0 = Date.now();
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it('answers four concurrent reads from the mirror at the cap, sending only the first lookup', async () => {
      route((init, idList) =>
        idList === '0704.0001' ? Promise.resolve(atomResponse(ATOM_EMPTY)) : hang(init),
      );
      const ids = ['2401.10001', '2401.10002', '2401.10003', '2401.10004'];
      const reads = ids.map((id) => timed(service.readContent(id, {}, createMockContext())));
      // A live lookup for a paper the mirror lacks, queued behind all four.
      const behind = timed(service.getPapers(['0704.0001'], createMockContext()));

      await advance(14_999);
      expect(reads.map((r) => r.at)).toEqual([undefined, undefined, undefined, undefined]);
      await advance(1);
      expect(
        reads.map((r) => ({
          at: r.at,
          error: r.error,
          paper_id: r.value?.paper_id,
          pdf_url: r.value?.pdf_url,
          source: r.value?.source,
        })),
      ).toEqual(
        ['2401.10001v1', '2401.10002v3', '2401.10003v1', '2401.10004v2'].map((paper_id) => ({
          at: 15_000,
          error: undefined,
          paper_id,
          pdf_url: `https://arxiv.org/pdf/${paper_id}`,
          source: 'arxiv_html',
        })),
      );
      expect([...contentRequests].sort()).toEqual([
        'https://arxiv.org/html/2401.10001v1',
        'https://arxiv.org/html/2401.10002v3',
        'https://arxiv.org/html/2401.10003v1',
        'https://arxiv.org/html/2401.10004v2',
      ]);

      // The withdrawn lookups never reach arXiv, and the first one's request was
      // aborted. The call queued behind them goes out one etiquette delay after
      // that abort: a lookup withdrawn from the queue holds no slot of its own.
      await advance(60_000);
      expect(apiRequests).toEqual([
        { at: 0, idList: '2401.10001' },
        { at: 18_000, idList: '0704.0001' },
      ]);
      expect(behind.at).toBe(18_000);
    });

    it('carries the capped read and its ar5iv flag on both surfaces of arxiv_read_paper', async () => {
      initArxivService();
      route(hang, { html: false, ar5iv: true });
      // A pinned read holds the queue, so this read's lookup is still unsent at
      // the cap: no request timeout or failure fallback can answer it at 15 s.
      timed(runToolContract(arxivReadPaper, { paper_id: '2401.10002v3' }));
      await advance(0);
      const call = timed(runToolContract(arxivReadPaper, { paper_id: '2401.10001' }));

      await advance(15_000);
      expect(call.at).toBe(15_000);
      expect(apiRequests).toEqual([{ at: 0, idList: '2401.10002v3' }]);
      const result = call.value;
      if (!result) throw new Error(`arxiv_read_paper failed: ${String(call.error)}`);
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        paper_id: '2401.10001v1',
        pdf_url: 'https://arxiv.org/pdf/2401.10001v1',
        source: 'ar5iv',
        revision_unconfirmed: true,
      });
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('Mirror Paper One on Transformers');
      expect(text).toContain(
        '[Revision unconfirmed: ar5iv keeps one render per paper, so this body may be another revision than arXiv:2401.10001v1.',
      );
      expect(text).toContain('Body text.');
      expect(contentRequests.filter((url) => url.endsWith('/2401.10001v1'))).toEqual([
        'https://arxiv.org/html/2401.10001v1',
        'https://ar5iv.labs.arxiv.org/html/2401.10001v1',
      ]);
    });

    it('uses a live answer that arrives inside the cap and reads no mirror row', async () => {
      const readSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds');
      try {
        route(
          () =>
            new Promise<Response>((resolve) =>
              setTimeout(() => resolve(atomResponse(ATOM_LIVE_V9)), 14_999),
            ),
        );
        const read = timed(service.readContent('2401.10001', {}, createMockContext()));

        await advance(14_999);
        expect(read).toMatchObject({ at: 14_999, value: { paper_id: '2401.10001v9' } });
        expect(contentRequests).toEqual(['https://arxiv.org/html/2401.10001v9']);
        await advance(20_000);
        expect(readSpy).not.toHaveBeenCalled();
      } finally {
        readSpy.mockRestore();
      }
    });

    it('keeps waiting past the cap for a paper the mirror lacks, failing with the live error (#68)', async () => {
      route();
      const held = timed(service.readContent('2401.10001', {}, createMockContext()));
      const absent = timed(service.readContent('0704.0001', {}, createMockContext()));

      await advance(15_000);
      expect(held).toMatchObject({ at: 15_000, value: { paper_id: '2401.10001v1' } });
      expect(absent.at).toBeUndefined();
      // Its lookup goes out once the withdrawn one's request and delay are done.
      await advance(17_999);
      expect(absent.at).toBeUndefined();
      await advance(1);
      expect(absent.at).toBe(33_000);
      expect(absent.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'arXiv API timed out after 15000ms',
      });
      expect((absent.error as McpError).data).not.toHaveProperty('reason', 'no_match');
      expect(apiRequests).toEqual([
        { at: 0, idList: '2401.10001' },
        { at: 18_000, idList: '0704.0001' },
      ]);
    });

    it('never answers at the cap from a mirror whose harvest has not completed, waiting on the live lookup (#21, #79)', async () => {
      // A cold init in flight holds the paper but has never completed.
      resetStore();
      const coldDir = await mkdtemp(join(tmpdir(), 'arxiv-svc-cold-cap-test-'));
      configOverrides.mirrorPath = join(coldDir, 'mirror.db');
      const cold = await MirrorStore.open(configOverrides.mirrorPath);
      cold.applyBatch([mkRecord({ paper_id: '2401.10001', title: 'Partial Cold Harvest' })], []);
      cold.writeHarvestState({ status: 'in_progress', started_at: '2024-02-22T00:00:00Z' });
      cold.close();
      resetStore();
      try {
        route();
        const read = timed(service.readContent('2401.10001', {}, createMockContext()));

        await advance(15_000);
        expect(read).toMatchObject({
          at: 15_000,
          error: { code: JsonRpcErrorCode.Timeout, message: 'arXiv API timed out after 15000ms' },
        });
        expect(contentRequests).toEqual([]);
      } finally {
        resetStore();
        await rm(coldDir, { recursive: true, force: true });
      }
    });

    it('leaves version-pinned reads to their live lookups, the #33 fallback after them (#33, #69)', async () => {
      route();
      const reads = ['2401.10001v1', '2401.10002v3', '2401.10002v1'].map((id) =>
        timed(service.readContent(id, {}, createMockContext())),
      );

      await advance(15_000);
      expect(reads[0]).toMatchObject({ at: 15_000, value: { paper_id: '2401.10001v1' } });
      await advance(18_000);
      expect(reads[1]).toMatchObject({ at: 33_000, value: { paper_id: '2401.10002v3' } });
      await advance(16_999);
      expect(reads[2]?.at).toBeUndefined();
      await advance(1);
      expect(reads[2]).toMatchObject({
        at: 50_000,
        error: {
          code: JsonRpcErrorCode.Timeout,
          message:
            "Reading arXiv paper '2401.10002v1' timed out after 50000ms; the request to arXiv API was still open.",
        },
      });
      expect(apiRequests.map((r) => r.at)).toEqual([0, 18_000, 36_000]);
    });

    it('fails a read cancelled before the cap as cancelled, reading no mirror row (#68)', async () => {
      const readSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds');
      try {
        const controller = new AbortController();
        // The caller disconnects once the lookup is in flight.
        route((init) => {
          controller.abort(new DOMException('The client cancelled the call.', 'AbortError'));
          return hang(init);
        });
        const read = timed(
          service.readContent('2401.10001', {}, createMockContext({ signal: controller.signal })),
        );

        await advance(0);
        expect(read.at).toBe(0);
        expect(read.error).toMatchObject({
          name: 'AbortError',
          message: 'The client cancelled the call.',
        });
        await advance(60_000);
        expect(readSpy).not.toHaveBeenCalled();
        expect(contentRequests).toEqual([]);
        expect(apiRequests).toEqual([{ at: 0, idList: '2401.10001' }]);
      } finally {
        readSpy.mockRestore();
      }
    });

    it('treats a mirror read that throws at the cap as a miss and keeps waiting (#76)', async () => {
      const readSpy = vi.spyOn(MirrorStore.prototype, 'getPapersByIds').mockImplementation(() => {
        throw corrupt();
      });
      try {
        route((init, idList) =>
          idList === '2401.10002' ? Promise.resolve(atomResponse(ATOM_LIVE_10002_V4)) : hang(init),
        );
        // A pinned read holds the queue for one slot; the unversioned read's lookup waits behind it.
        const blockerCtx = createMockContext();
        const blocker = timed(service.readContent('2401.10001v1', {}, blockerCtx));
        const ctx = createMockContext();
        const warning = vi.spyOn(ctx.log, 'warning');
        const read = timed(service.readContent('2401.10002', {}, ctx));

        await advance(15_000);
        expect(read.at).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(
          'Mirror read failed for readContent metadata; using the live lookup',
          { paperId: '2401.10002', error: 'database disk image is malformed' },
        );
        // The blocker's own lookup timed out, and its fallback read threw too:
        // the live failure stands.
        expect(blocker).toMatchObject({
          at: 15_000,
          error: { code: JsonRpcErrorCode.Timeout, message: 'arXiv API timed out after 15000ms' },
        });
        await advance(2_999);
        expect(read.at).toBeUndefined();
        await advance(1);
        expect(read).toMatchObject({
          at: 18_000,
          value: { paper_id: '2401.10002v4', pdf_url: 'https://arxiv.org/pdf/2401.10002v4' },
        });
        expect(contentRequests).toEqual(['https://arxiv.org/html/2401.10002v4']);
        expect(JSON.stringify(blocker.error)).not.toContain('malformed');
      } finally {
        readSpy.mockRestore();
      }
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

    // Issue #56: arXiv answers 500 past its first 10,000 results, so a recency
    // bypass with nothing reachable there goes straight to the mirror.
    it('answers a recency-bypass start past arXiv’s 10,000 results from the mirror, with no request', async () => {
      configOverrides.mirrorRecentDaysLive = 2;
      const result = await service.search(
        'transformers',
        { start: 10_000, sortBy: 'submitted', sortOrder: 'descending' },
        createMockContext(),
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.start).toBe(10_000);
      expect(result.total_results).toBe(1);
      expect(result.result_limit).toBeUndefined();
    });

    it('cuts a recency-bypass page at arXiv’s 10,000th result', async () => {
      configOverrides.mirrorRecentDaysLive = 2;
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      const result = await service.search(
        'transformers',
        { start: 9_995, maxResults: 50, sortBy: 'submitted', sortOrder: 'descending' },
        createMockContext(),
      );

      const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(url.searchParams.get('max_results')).toBe('5');
      expect(result.result_limit).toBe(10_000);
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

    it('rethrows a store-side fts5 SQLiteError as a validationError carrying the original query and matchExpr', async () => {
      const spy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
        throw new Error('fts5: syntax error near ":"');
      });
      try {
        const ctx = createMockContext({ errors: arxivSearchPapers.errors! });
        expect.assertions(4);
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
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('surfaces the arxiv_search_papers contract recovery hint for an fts5 failure at the tool boundary', async () => {
      const spy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
        throw new Error('fts5: syntax error near ":"');
      });
      try {
        initArxivService({ mirrorSearcher: searchInThread });
        const result = await runToolContract(arxivSearchPapers, {
          query: 'language all:automated',
          max_results: 1,
        });

        expect(result.isError, JSON.stringify(result)).toBe(true);
        const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
          .error;
        expect(error.data.reason).toBe('unsupported_query_syntax');
        const declared = arxivSearchPapers.errors!.find(
          (e) => e.reason === 'unsupported_query_syntax',
        );
        expect(error.data.recovery).toEqual({ hint: declared!.recovery });
      } finally {
        spy.mockRestore();
      }
    });

    it('answers live, with a warning, when the store throws a non-fts5 SQLite error (#76)', async () => {
      const spy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
        throw sqliteDriverError();
      });
      serveLivePaper();
      try {
        const ctx = createMockContext();
        const warning = vi.spyOn(ctx.log, 'warning');
        const result = await service.search('anything', { maxResults: 1 }, ctx);
        expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith('Mirror search failed; using live API', {
          error: 'no such table: missing_table',
        });
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
      // The issue's shapes that keep every cat: operand a conjunct.
      '(cat:cs.LG AND attention)',
      '(cat:cs.LG)',
      '(cat:cs.LG OR cat:cs.AI)',
      // Broader cleanup combinations.
      'cat:cs.LG AND attention',
      'attention AND cat:cs.LG',
      'attention AND (cat:cs.LG)',
      '(cat:cs.LG) AND attention',
      '(attention AND (cat:cs.LG))',
    ])('resolves cat:-cleanup query %s without surfacing an FTS5 error', async (q) => {
      const ctx = createMockContext();
      await expect(service.search(q, { maxResults: 5 }, ctx)).resolves.toMatchObject({
        total_results: expect.any(Number),
        papers: expect.any(Array),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      '(cat:cs.LG OR attention)',
      '(attention OR cat:cs.LG)',
      '(cat:cs.LG OR cat:cs.AI OR attention)',
      '(attention OR cat:cs.LG OR background)',
      'attention AND cat:cs.LG OR background',
      '(all:attention OR cat:cs.LG)',
    ])(
      'sends the #14 query %s, a cat: joined to a term by OR, to the live API (#65)',
      async (q) => {
        serveLivePaper();
        const ctx = createMockContext();
        const result = await service.search(q, { maxResults: 5 }, ctx);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get('search_query')).toBe(
          q,
        );
        expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      },
    );

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

    it('answers (cat:cs.LG OR attention) from the live API instead of reading its OR as AND (#65)', async () => {
      serveLivePaper();
      const ctx = createMockContext();
      const result = await service.search('(cat:cs.LG OR attention)', { maxResults: 10 }, ctx);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(result.effective_query).toBe('(cat:cs.LG OR attention)');
    });

    // -----------------------------------------------------------------------
    // Issue #65 — a cat: or submittedDate: operand stays on the mirror only as
    // a conjunct of the whole query under arXiv's grammar, where every operator
    // shares one precedence grouped to the right (#82). Every other shape goes
    // live.
    // -----------------------------------------------------------------------

    describe('boolean operators around cat: and submittedDate: operands (#65)', () => {
      beforeEach(async () => {
        const store = await MirrorStore.open(configOverrides.mirrorPath);
        const at = (date: string) => [{ version: 'v1', date }];
        store.applyBatch(
          [
            mkRecord({
              paper_id: '2403.10001',
              title: 'Transformer survey',
              authors: 'Hinton G',
              categories: 'cs.LG math.AG',
              versions: at('2020-06-01T00:00:00Z'),
            }),
            mkRecord({
              paper_id: '2403.10002',
              title: 'Transformer methods',
              authors: 'Hinton G',
              categories: 'cs.LG',
              versions: at('2022-06-01T00:00:00Z'),
            }),
            mkRecord({
              paper_id: '2403.10003',
              title: 'Algebraic geometry survey',
              authors: 'Ada Lovelace',
              categories: 'math.AG',
              versions: at('2020-03-01T00:00:00Z'),
            }),
            mkRecord({
              paper_id: '2403.10004',
              title: 'Transformer reasoning',
              authors: 'Ada Lovelace',
              categories: 'cs.AI',
              versions: at('2020-09-01T00:00:00Z'),
            }),
            // A `transformer` match outside every category the queries below
            // name, so a category filter the mirror drops changes their sets.
            mkRecord({
              paper_id: '2403.10005',
              title: 'Transformer forecasting',
              authors: 'Grace Hopper',
              categories: 'stat.ML',
              versions: at('2023-06-01T00:00:00Z'),
            }),
            ...['alpha', 'alpha beta', 'alpha gamma', 'alpha beta gamma'].map((abstract, i) =>
              mkRecord({ paper_id: `2403.2000${i + 1}`, abstract, categories: 'q-bio.PE' }),
            ),
          ],
          [],
        );
        store.close();
      });

      const ids = (result: { papers: { id: string }[] }) =>
        result.papers.map((p) => p.id.replace(/v\d+$/, '')).sort();

      it.each([
        // A paper must carry both codes: each lifted cat: is its own group.
        ['cat:cs.LG AND cat:math.AG', ['2403.10001']],
        ['transformer AND cat:cs.AI', ['2403.10004']],
        // An OR-ed set of cat: operands is one group: both codes admit papers,
        // and together they keep out the stat.ML 2403.10005.
        ['(cat:cs.LG OR cat:cs.AI) AND transformer', ['2403.10001', '2403.10002', '2403.10004']],
        // The cat: sits on the left of the ANDNOT, so it is a conjunct and the
        // ANDNOT keeps excluding the surveys.
        ['au:"hinton g" AND cat:cs.LG ANDNOT ti:survey', ['2403.10002']],
        [
          'transformer AND submittedDate:[202001010000 TO 202101010000]',
          ['2403.10001', '2403.10004'],
        ],
        // The echoed form of a query cat: beside `category: "math"`: two groups.
        // The bare `cat:math` in it echoes as its subtree, as on the live path.
        [
          '(cat:cs.LG OR cat:cs.AI) AND (cat:math.* OR cat:math)',
          ['2403.10001'],
          '(cat:cs.LG OR cat:cs.AI) AND (cat:math.* OR (cat:math.* OR cat:math))',
        ],
        // No cat: at all: operators group to the right, so this is
        // alpha ∧ ¬(beta ∧ gamma), never (alpha ∧ ¬beta) ∧ gamma.
        ['alpha ANDNOT beta AND gamma', ['2403.20001', '2403.20002', '2403.20003']],
      ])(
        'answers %s from the mirror with the set arXiv returns',
        async (query, expected, echoed = query) => {
          const result = await service.search(query, { maxResults: 50 }, createMockContext());
          expect(mockFetch).not.toHaveBeenCalled();
          expect(ids(result)).toEqual(expected);
          expect(result.total_results).toBe(expected.length);
          expect(result.effective_query).toBe(echoed);
        },
      );

      it.each([
        'transformer ANDNOT cat:cs.AI',
        'transformer OR cat:cs.AI',
        'cat:cs.AI ANDNOT transformer',
        'cat:cs.LG ANDNOT cat:cs.AI',
        'ti:a ANDNOT ti:b AND cat:cs.LG',
        'a AND cat:cs.LG OR b',
        '(cat:cs.LG AND cat:cs.AI) OR cat:math.AG',
        'transformer ANDNOT submittedDate:[202001010000 TO 202101010000]',
        'submittedDate:[202001010000 TO 202101010000] OR submittedDate:[202201010000 TO 202301010000]',
      ])('answers %s from the live API without consulting the mirror', async (query) => {
        serveLivePaper();
        const stateSpy = vi.spyOn(MirrorStore.prototype, 'readHarvestState');
        const probeSpy = vi.spyOn(MirrorStore.prototype, 'matchReachesCap');
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        try {
          const result = await service.search(query, { maxResults: 5 }, createMockContext());
          expect(mockFetch).toHaveBeenCalledTimes(1);
          const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
          expect(url.searchParams.get('search_query')).toBe(query);
          expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
          expect(result.result_limit).toBe(10_000);
          expect(stateSpy).not.toHaveBeenCalled();
          expect(probeSpy).not.toHaveBeenCalled();
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          stateSpy.mockRestore();
          probeSpy.mockRestore();
          searchSpy.mockRestore();
        }
      });

      it('keeps the category parameter a separate group, intersected with the query groups', async () => {
        const ctx = createMockContext();
        const none = await service.search(
          'cat:cs.LG AND cat:math.AG',
          { maxResults: 50, category: 'cs.AI' },
          ctx,
        );
        const one = await service.search(
          'cat:cs.LG AND cat:math.AG',
          { maxResults: 50, category: 'math' },
          ctx,
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(none).toMatchObject({ total_results: 0, papers: [] });
        expect(ids(one)).toEqual(['2403.10001']);
        expect(one.effective_query).toBe(
          '(cat:cs.LG AND cat:math.AG) AND (cat:math.* OR cat:math)',
        );
      });

      it('returns a failed recency bypass for a query that goes live, never a mirror answer', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(
          new Response('Rate exceeded.', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        );
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        try {
          await expect(
            service.search(
              'transformer OR cat:cs.AI',
              { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
              createMockContext(),
            ),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: { reason: 'rate_limited' },
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          searchSpy.mockRestore();
        }
      });

      it('refuses start 10,000 for a query that goes live, before any request', async () => {
        await expect(
          service.search('transformer OR cat:cs.AI', { start: 10_000 }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'start_beyond_result_limit' },
        });
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('reports the mirror answer through the tool’s structured and text output', async () => {
        initArxivService({ mirrorSearcher: searchInThread });
        const result = await runToolContract(arxivSearchPapers, {
          query: 'au:"hinton g" AND cat:cs.LG ANDNOT ti:survey',
          max_results: 10,
        });

        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        expect(mockFetch).not.toHaveBeenCalled();
        const structured = result.structuredContent as {
          papers: { id: string; title: string }[];
          totalFound: number;
        };
        expect(structured.totalFound).toBe(1);
        expect(structured.papers.map((p) => [p.id, p.title])).toEqual([
          ['2403.10002v1', 'Transformer methods'],
        ]);
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('2403.10002v1');
        expect(text).toContain('Transformer methods');
        expect(text).not.toContain('Transformer survey');
      });

      it('reports the live answer to a query the mirror cannot answer through the tool’s structured and text output', async () => {
        serveLivePaper();
        initArxivService({ mirrorSearcher: searchInThread });
        const result = await runToolContract(arxivSearchPapers, {
          query: 'transformer ANDNOT cat:cs.AI',
          max_results: 10,
        });

        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const structured = result.structuredContent as { papers: { id: string }[] };
        expect(structured.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('2402.99999v1');
        expect(text).toContain('From Live API');
      });
    });

    // -----------------------------------------------------------------------
    // Issue #82 — the mirror reads a query with arXiv's grammar (adjacency is
    // OR, one precedence grouped right, uppercase operators only) and sends
    // what it cannot read that way live.
    // -----------------------------------------------------------------------

    describe("arXiv's query grammar on the mirror (#82)", () => {
      beforeEach(async () => {
        const store = await MirrorStore.open(configOverrides.mirrorPath);
        const papers: [string, string][] = [
          ['2404.10001', 'Quantum computing with qubits'],
          ['2404.10002', 'Quantum annealing'],
          ['2404.10003', 'Computing at scale'],
          ['2404.10004', 'Quantum error correction'],
          ['2404.10005', 'Distributed computing'],
          // Unmatched filler, so each title word is rare enough for BM25 to weigh.
          ...Array.from({ length: 10 }, (_, i): [string, string] => [
            `2404.200${i + 10}`,
            'Unrelated filler',
          ]),
        ];
        store.applyBatch(
          papers.map(([paper_id, title]) =>
            mkRecord({ paper_id, title, abstract: 'Plain abstract.', categories: 'quant-ph' }),
          ),
          [],
        );
        store.close();
      });

      it('answers space-separated terms with every paper holding either, both-term papers first', async () => {
        const result = await service.search(
          'ti:quantum ti:computing',
          { maxResults: 10, sortBy: 'relevance' },
          createMockContext(),
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result.total_results).toBe(5);
        expect(result.papers[0]?.id).toBe('2404.10001v1');
        expect(result.papers.map((p) => p.id.replace(/v\d+$/, '')).sort()).toEqual([
          '2404.10001',
          '2404.10002',
          '2404.10003',
          '2404.10004',
          '2404.10005',
        ]);
        expect(result.effective_query).toBe('ti:quantum ti:computing');
      });

      it('answers AND with the papers holding every term', async () => {
        const result = await service.search(
          'ti:quantum AND ti:computing',
          { maxResults: 10 },
          createMockContext(),
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result.papers.map((p) => p.id)).toEqual(['2404.10001v1']);
      });

      it('reports the widened mirror answer through the tool’s structured and text output', async () => {
        initArxivService({ mirrorSearcher: searchInThread });
        const result = await runToolContract(arxivSearchPapers, {
          query: 'quantum computing',
          max_results: 10,
        });

        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        expect(mockFetch).not.toHaveBeenCalled();
        const structured = result.structuredContent as {
          papers: { id: string; title: string }[];
          totalFound: number;
        };
        expect(structured.totalFound).toBe(5);
        expect(structured.papers[0]?.title).toBe('Quantum computing with qubits');
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('Quantum annealing');
        expect(text).toContain('Distributed computing');
      });

      it.each([
        ['ti: quantum', 'empty_field_value'],
        ['cat: quantum', 'empty_field_value'],
        ['quantum AND ti:', 'empty_field_value'],
        ['ti:""', 'empty_field_value'],
        ['""', 'empty_phrase'],
        ['()', 'empty_query'],
        ['rn:CERN', 'field_not_in_mirror'],
        ['id:2401.12345', 'field_not_in_mirror'],
        ['quantum cat:quant-ph', 'filter_not_conjunct'],
        // A category filter naming no code: the mirror would drop it and answer
        // with every quantum paper, in any category.
        ['quantum AND cat:zzz*', 'empty_category'],
        ['cat:zzz.*', 'empty_category'],
        // A word arXiv's index drops: beside OR the mirror would match every
        // paper holding it, where arXiv matches next to none.
        ['(quantum of computing) AND ti:annealing', 'stopword_term'],
        ['ti:quantum and ti:computing', 'stopword_term'],
        // A date filter the mirror cannot apply, read as terms it would match on.
        ['ti:quantum AND (lastUpdatedDate:[202410010000 TO 202410012359])', 'field_not_in_mirror'],
        ['ti:quantum AND submittedDate:[2024 TO 2025]', 'field_not_in_mirror'],
      ])('sends %s to the live API without consulting the mirror (%s)', async (query, reason) => {
        serveLivePaper();
        const stateSpy = vi.spyOn(MirrorStore.prototype, 'readHarvestState');
        const probeSpy = vi.spyOn(MirrorStore.prototype, 'matchReachesCap');
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        try {
          const ctx = createMockContext();
          const info = vi.spyOn(ctx.log, 'info');
          const result = await service.search(query, { maxResults: 5 }, ctx);
          expect(mockFetch).toHaveBeenCalledTimes(1);
          const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
          expect(url.searchParams.get('search_query')).toBe(query);
          expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
          expect(info).toHaveBeenCalledWith(
            'The mirror cannot answer this query as arXiv does; not using it',
            { query, reason },
          );
          expect(stateSpy).not.toHaveBeenCalled();
          expect(probeSpy).not.toHaveBeenCalled();
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          stateSpy.mockRestore();
          probeSpy.mockRestore();
          searchSpy.mockRestore();
        }
      });

      it.each([
        'ti: quantum',
        '""',
        '()',
        'rn:CERN',
        'quantum AND cat:zzz*',
        '(quantum of computing) AND ti:annealing',
        'ti:quantum AND (lastUpdatedDate:[202410010000 TO 202410012359])',
      ])('returns a failed recency bypass for %s, never a mirror answer', async (query) => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(
          new Response('Rate exceeded.', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        );
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        try {
          await expect(
            service.search(
              query,
              { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
              createMockContext(),
            ),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: { reason: 'rate_limited' },
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          searchSpy.mockRestore();
        }
      });

      it.each([
        'ti: quantum',
        '""',
        '()',
        'rn:CERN',
        'quantum AND cat:zzz*',
        '(quantum of computing) AND ti:annealing',
        'ti:quantum AND (lastUpdatedDate:[202410010000 TO 202410012359])',
      ])('refuses start 10,000 for %s before any request', async (query) => {
        await expect(
          service.search(query, { start: 10_000 }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'start_beyond_result_limit' },
        });
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('reports the live answer to an rn: query through the tool’s structured and text output', async () => {
        serveLivePaper();
        initArxivService({ mirrorSearcher: searchInThread });
        const result = await runToolContract(arxivSearchPapers, {
          query: 'rn:CERN',
          max_results: 10,
        });

        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const structured = result.structuredContent as { papers: { id: string }[] };
        expect(structured.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('2402.99999v1');
      });
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

    // -----------------------------------------------------------------------
    // Issue #49 — a free-text term matching the cap or more papers goes to the
    // live API, and only such a term does.
    // -----------------------------------------------------------------------

    describe('free-text terms at the match cap go to the live API (#49)', () => {
      const rateLimited = () =>
        new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } });

      it.each(['relevance', 'updated', 'submitted'] as const)(
        'answers a %s-sorted query whose term matches the cap from the live API alone',
        async (sortBy) => {
          await seedBulk(50_000, 'ubiquitous');
          const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
          mockFetch.mockResolvedValueOnce(atomResponse(ATOM_AT_CAP));
          try {
            const result = await service.search(
              'ubiquitous',
              { maxResults: 1, sortBy, sortOrder: 'ascending' },
              createMockContext(),
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(searchSpy).not.toHaveBeenCalled();
            expect(result.total_results).toBe(1_025_313);
            expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
            expect(result.effective_query).toBe('ubiquitous');
          } finally {
            searchSpy.mockRestore();
          }
        },
        30_000,
      );

      it('keeps a term one match under the cap on the mirror, with an exact count', async () => {
        await seedBulk(49_999, 'ubiquitous');
        const result = await service.search('ubiquitous', { maxResults: 2 }, createMockContext());
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result.total_results).toBe(49_999);
        expect(result.papers).toHaveLength(2);
      }, 30_000);

      it('decides on the free-text term alone, before category and date filters narrow it', async () => {
        await seedBulk(50_000, 'ubiquitous');
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
        const result = await service.search(
          'ubiquitous',
          { maxResults: 1, category: 'astro-ph', submittedFrom: '2023-01-01' },
          createMockContext(),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.total_results).toBe(0);
      }, 30_000);

      it('surfaces a live failure for a query at the cap instead of answering from the mirror', async () => {
        await seedBulk(50_000, 'ubiquitous');
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        mockFetch.mockResolvedValue(rateLimited());
        try {
          await expect(
            service.search('ubiquitous', { maxResults: 1 }, createMockContext()),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          searchSpy.mockRestore();
        }
      }, 30_000);

      it('still falls back to the mirror when the recency bypass fails on a query under the cap', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(rateLimited());
        const result = await service.search(
          'transformers',
          { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
          createMockContext(),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
        expect(result.total_results).toBe(1);
      });

      it('fails with the live error when the recency bypass fails and the mirror matches nothing (#68)', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        mockFetch.mockResolvedValue(rateLimited());
        try {
          await expect(
            service.search(
              'quasicrystal',
              { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
              createMockContext(),
            ),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: { reason: 'rate_limited' },
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(searchSpy).toHaveBeenCalledTimes(1);
        } finally {
          searchSpy.mockRestore();
        }
      });

      it('reports the failed recency bypass, never "No papers found", at the tool boundary (#68)', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(rateLimited());
        initArxivService();
        const result = await runToolContract(arxivSearchPapers, {
          query: 'quasicrystal',
          max_results: 5,
          sort_by: 'submitted',
          sort_order: 'descending',
        });

        expect(result.isError, JSON.stringify(result)).toBe(true);
        const error = (result.structuredContent as { error: { code: number; message: string } })
          .error;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.message).toContain('arXiv rate limit exceeded');
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('arXiv rate limit exceeded');
        expect(text).not.toContain('No papers found');
      });

      it('keeps answering a failed recency bypass from the mirror when its page starts past the mirror total', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(rateLimited());
        const result = await service.search(
          'transformers',
          { start: 5, maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
          createMockContext(),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ total_results: 1, start: 5, papers: [] });
      });

      /** Abort `ctrl` from inside the live request, the way a caller disconnect lands mid-fetch. */
      const abortDuringFetch = (ctrl: AbortController) =>
        mockFetch.mockImplementation(() => {
          ctrl.abort();
          return Promise.reject(ctrl.signal.reason);
        });

      it('rethrows a caller cancellation on the recency bypass instead of answering from the mirror', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        const ctrl = new AbortController();
        abortDuringFetch(ctrl);
        const probeSpy = vi.spyOn(MirrorStore.prototype, 'matchReachesCap');
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        try {
          await expect(
            service.search(
              'transformers',
              { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' },
              createMockContext({ signal: ctrl.signal }),
            ),
          ).rejects.toMatchObject({ name: 'AbortError' });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(probeSpy).not.toHaveBeenCalled();
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          probeSpy.mockRestore();
          searchSpy.mockRestore();
        }
      });

      it('reports a cancelled recency-bypass search as RequestCancelled at the tool boundary', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        const ctrl = new AbortController();
        abortDuringFetch(ctrl);
        initArxivService();
        const result = await runToolContract(
          arxivSearchPapers,
          { query: 'transformers', max_results: 5, sort_by: 'submitted', sort_order: 'descending' },
          { context: { signal: ctrl.signal } },
        );

        expect(result.isError, JSON.stringify(result)).toBe(true);
        const error = (result.structuredContent as { error: { code: number } }).error;
        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it('surfaces a failed recency bypass for a query at the cap instead of falling back to the mirror', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        await seedBulk(50_000, 'ubiquitous');
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search');
        mockFetch.mockResolvedValue(rateLimited());
        try {
          await expect(
            service.search(
              'ubiquitous',
              { maxResults: 1, sortBy: 'submitted', sortOrder: 'descending' },
              createMockContext(),
            ),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(searchSpy).not.toHaveBeenCalled();
        } finally {
          searchSpy.mockRestore();
        }
      }, 30_000);

      it('serves a category-only search from the mirror without probing (#19)', async () => {
        await seedBulk(50_000, 'ubiquitous');
        const probeSpy = vi.spyOn(MirrorStore.prototype, 'matchReachesCap');
        try {
          const result = await service.search('cat:cs.LG', { maxResults: 1 }, createMockContext());
          expect(mockFetch).not.toHaveBeenCalled();
          expect(probeSpy).not.toHaveBeenCalled();
          // The 50,000 bulk papers plus the seeded cs.LG paper.
          expect(result.total_results).toBe(50_001);
        } finally {
          probeSpy.mockRestore();
        }
      }, 30_000);

      it('converts an FTS5 parse error raised by the probe into unsupported_query_syntax', async () => {
        // The translator emits no malformed expression, so the real probe is
        // handed one: the error under test is the one SQLite itself raises.
        const probe = MirrorStore.prototype.matchReachesCap;
        const probeSpy = vi
          .spyOn(MirrorStore.prototype, 'matchReachesCap')
          .mockImplementation(function (this: MirrorStore) {
            return probe.call(this, 'title:');
          });
        try {
          await expect(
            service.search('language all:automated', { maxResults: 1 }, createMockContext()),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.ValidationError,
            data: { reason: 'unsupported_query_syntax', query: 'language all:automated' },
          });
        } finally {
          probeSpy.mockRestore();
        }
      });

      it("reports arXiv's own total through the tool's structured and text output", async () => {
        await seedBulk(50_000, 'ubiquitous');
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_AT_CAP));
        initArxivService();
        const result = await runToolContract(arxivSearchPapers, {
          query: 'ubiquitous',
          max_results: 1,
        });

        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        const structured = result.structuredContent as {
          papers: { id: string }[];
          totalFound: number;
        };
        expect(structured.totalFound).toBe(1_025_313);
        expect(structured.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        expect(text).toContain('1025313');
        expect(text).toContain('From Live API');
      }, 30_000);
    });

    // A search without a free-text term, one category code aside, stops its
    // count at the cap and stays on the mirror, flagging the total as a floor.
    describe('a term-less count that stops at the cap (#78)', () => {
      const textOf = (result: { content: { type: string; text?: string }[] }): string =>
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

      it('flags a capped archive count on both surfaces of arxiv_search_papers, through start 10,000', async () => {
        seedBulk(50_000, 'ubiquitous');
        initArxivService();

        const first = await runToolContract(arxivSearchPapers, { query: 'cat:cs', max_results: 5 });
        expect(first.isError, JSON.stringify(first)).toBeFalsy();
        expect(first.structuredContent).toMatchObject({
          totalFound: 50_000,
          totalFoundIsLowerBound: true,
          truncated: true,
          shown: 5,
        });
        const notice = (first.structuredContent as { notice: string }).notice;
        expect(notice).toContain('50000 or more total matches');
        expect(notice).toContain('only the first 10005 are reachable');
        expect(textOf(first)).toContain('**Total Found Is Lower Bound:** true');
        expect(textOf(first)).toContain('50000 or more total matches');

        // The deepest page the schema accepts still holds a full page of papers.
        const deepest = await runToolContract(arxivSearchPapers, {
          query: 'cat:cs',
          start: 10_000,
          max_results: 50,
        });
        expect(deepest.isError, JSON.stringify(deepest)).toBeFalsy();
        const structured = deepest.structuredContent as {
          notice: string;
          papers: unknown[];
          totalFoundIsLowerBound?: true;
        };
        expect(structured.papers).toHaveLength(50);
        expect(structured.totalFoundIsLowerBound).toBe(true);
        expect(structured.notice).toContain('50000 or more total matches');
        expect(structured.notice).not.toContain('exceeds total results');
        expect(mockFetch).not.toHaveBeenCalled();
      }, 30_000);

      it('sets total_is_lower_bound for a window alone and for two category groups', async () => {
        // One more than the cap, so an exact count (50,001 in the window) is
        // told apart from one that stopped at the cap.
        seedBulk(50_001, 'ubiquitous');
        const ctx = createMockContext();

        const byDate = await service.search(
          'submittedDate:[202301010000 TO 202401010000]',
          { maxResults: 2 },
          ctx,
        );
        // 50,002 papers carry cs.LG and a code under cs: two groups, capped.
        const twoGroups = await service.search('cat:cs', { maxResults: 2, category: 'cs.LG' }, ctx);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(byDate).toMatchObject({ total_results: 50_000, total_is_lower_bound: true });
        expect(byDate.papers).toHaveLength(2);
        expect(twoGroups).toMatchObject({ total_results: 50_000, total_is_lower_bound: true });
        expect(twoGroups.papers).toHaveLength(2);
      }, 30_000);

      it('leaves the flag off an exact count: one code, a group under the cap, and a live total', async () => {
        const ctx = createMockContext();
        const underCap = await service.search('cat:cs', { maxResults: 2 }, ctx);
        expect(underCap.total_results).toBe(1);
        expect(underCap).not.toHaveProperty('total_is_lower_bound');

        seedBulk(50_000, 'ubiquitous');
        mockFetch.mockResolvedValueOnce(atomResponse(ATOM_AT_CAP));
        initArxivService();
        const byCode = await runToolContract(arxivSearchPapers, {
          query: 'cat:cs.LG',
          max_results: 2,
        });
        const live = await runToolContract(arxivSearchPapers, {
          query: 'ubiquitous',
          max_results: 1,
        });

        expect(byCode.structuredContent).toMatchObject({ totalFound: 50_001 });
        expect(live.structuredContent).toMatchObject({ totalFound: 1_025_313 });
        for (const result of [byCode, live]) {
          expect(result.isError, JSON.stringify(result)).toBeFalsy();
          expect(result.structuredContent).not.toHaveProperty('totalFoundIsLowerBound');
          expect(textOf(result)).not.toContain('Lower Bound');
          expect(textOf(result)).not.toContain('or more');
        }
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }, 30_000);
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

  // -------------------------------------------------------------------------
  // The server's mirror connection is query-only (#55): it never creates,
  // seeds, or migrates the file. A file it cannot serve reads as not ready —
  // the call goes live — and is opened again on the next call.
  // -------------------------------------------------------------------------

  describe("the server's read-only mirror open (#55)", () => {
    const warnings = (ctx: ReturnType<typeof createMockContext>) =>
      (ctx.log as unknown as { calls: { level: string; msg: string }[] }).calls.filter(
        (c) => c.level === 'warning',
      );

    it('answers from the live API on an older-schema mirror and leaves the file as it was', async () => {
      downgradeToV2(configOverrides.mirrorPath);
      serveLivePaper();
      const ctx = createMockContext();

      const searched = await service.search('ti:transformers', { maxResults: 10 }, ctx);
      const looked = await service.getPapers(['2402.99999'], ctx);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(searched.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(looked.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(schemaShape(configOverrides.mirrorPath)).toEqual({
        version: 2,
        ftsColumns: ['title', 'authors', 'abstract'],
      });
      expect(warnings(ctx)).toEqual([]);
    });

    it('serves the next call from the mirror once a writer has migrated the file', async () => {
      downgradeToV2(configOverrides.mirrorPath);
      serveLivePaper();
      await service.search('ti:transformers', { maxResults: 10 }, createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(1);

      (await MirrorStore.open(configOverrides.mirrorPath)).close();
      mockFetch.mockClear();
      const result = await service.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
    });

    it('reads a missing file as not ready: a live answer, nothing created, no warning', async () => {
      const absentDir = join(dir, 'absent');
      configOverrides.mirrorPath = join(absentDir, 'mirror.db');
      serveLivePaper();
      const ctx = createMockContext();

      const result = await service.search('ti:transformers', { maxResults: 10 }, ctx);

      expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(existsSync(absentDir)).toBe(false);
      expect(warnings(ctx)).toEqual([]);

      // Not ready is never cached: once a writer has built the file, the next call reads it.
      const writer = await MirrorStore.open(configOverrides.mirrorPath);
      writer.applyBatch([mkRecord({ paper_id: '2401.20001', title: 'Transformers arrive' })], []);
      writer.writeHarvestState({ status: 'complete', completed_at: '2024-03-01T00:00:00Z' });
      writer.close();
      mockFetch.mockClear();
      const next = await service.search('ti:transformers', { maxResults: 10 }, createMockContext());

      expect(mockFetch).not.toHaveBeenCalled();
      expect(next.papers.map((p) => p.id)).toEqual(['2401.20001v1']);
    });

    it('never writes the harvest_state seed a writer open adds', async () => {
      const raw = new Database(configOverrides.mirrorPath);
      raw.run('DELETE FROM harvest_state');
      raw.close();
      serveLivePaper();

      const result = await service.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );

      expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      const check = new Database(configOverrides.mirrorPath, { readonly: true });
      expect(check.query('SELECT COUNT(*) AS n FROM harvest_state').get()).toEqual({ n: 0 });
      check.close();
    });

    it('reports an older schema to onMirrorSchemaOutdated, and no other not-ready file', async () => {
      const onMirrorSchemaOutdated = vi.fn();
      const watched = new ArxivService({ onMirrorSchemaOutdated });
      serveLivePaper();
      const mirrorPath = configOverrides.mirrorPath;

      configOverrides.mirrorPath = join(dir, 'absent', 'mirror.db');
      await watched.search('ti:transformers', { maxResults: 10 }, createMockContext());
      expect(onMirrorSchemaOutdated).not.toHaveBeenCalled();

      configOverrides.mirrorPath = mirrorPath;
      downgradeToV2(mirrorPath);
      await watched.search('ti:transformers', { maxResults: 10 }, createMockContext());
      await watched.getPapers(['2402.99999'], createMockContext());
      expect(onMirrorSchemaOutdated).toHaveBeenCalledTimes(2);

      (await MirrorStore.open(mirrorPath)).close();
      await watched.search('ti:transformers', { maxResults: 10 }, createMockContext());
      expect(onMirrorSchemaOutdated).toHaveBeenCalledTimes(2);
    });

    // Issue #71 — a file another writer is migrating needs no upgrade child.
    it('starts no upgrade while a writer holds the migration lease, and does once it lapses', async () => {
      const onMirrorSchemaOutdated = vi.fn();
      const watched = new ArxivService({ onMirrorSchemaOutdated });
      serveLivePaper();
      const mirrorPath = configOverrides.mirrorPath;
      downgradeToV2(mirrorPath);
      const setLease = (renewedAt: string) => {
        const raw = new Database(mirrorPath);
        raw.run(
          `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
           VALUES (1, 'another-writer', 4242, '2026-01-01T00:00:00.000Z', ?)`,
          [renewedAt],
        );
        raw.close();
      };
      setLease(new Date().toISOString());
      const ctx = createMockContext();

      const searched = await watched.search('ti:transformers', { maxResults: 10 }, ctx);
      await watched.getPapers(['2402.99999'], createMockContext());

      expect(searched.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(onMirrorSchemaOutdated).not.toHaveBeenCalled();
      expect(warnings(ctx)).toEqual([]);

      setLease('2000-01-01T00:00:00.000Z');
      await watched.search('ti:transformers', { maxResults: 10 }, createMockContext());
      expect(onMirrorSchemaOutdated).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Mirror searches run in the reader worker (#58): the request thread posts the
  // call and receives the page. Every answer, route, and error matches the
  // in-thread search's.
  // -------------------------------------------------------------------------

  describe('mirror searches in the reader worker (#58)', () => {
    const inThread = () => new ArxivService({ mirrorSearcher: searchInThread });

    describe('over the seeded fixtures', () => {
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
            mkRecord({
              paper_id: '9901.00001',
              title: 'Legacy Flat Astrophysics Paper',
              abstract: 'Cosmic ray observations from before the archive was subdivided.',
              categories: 'astro-ph',
              versions: [{ version: 'v1', date: '1999-01-11T00:00:00Z' }],
            }),
            ...[
              '2024-03-09T23:59:59Z',
              '2024-03-10T00:00:00Z',
              '2024-03-10T12:00:00Z',
              '2024-03-10T23:59:30Z',
              '2024-03-11T08:00:00Z',
              '2024-03-12T05:00:00Z',
              '2024-03-13T00:00:00Z',
            ].map((date, i) =>
              mkRecord({
                paper_id: `2403.0000${i}`,
                title: 'Windowed Chronometry Paper',
                abstract: 'A paper used to probe submitted-date window boundaries.',
                categories: 'cs.LG',
                versions: [{ version: 'v1', date }],
              }),
            ),
            // Submitted and revised on days that run in opposite orders, so the
            // two date sorts disagree.
            ...Array.from({ length: 12 }, (_, i) =>
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
            ),
          ],
          [],
        );
        store.close();
      });

      it('returns the papers, order, and total_results the in-thread search returns, for every sort and page', async () => {
        const queries: [string, Record<string, string>][] = [
          ['ti:transformers', {}],
          ['attention', { category: 'cs.LG' }],
          ['lattice', {}],
          ['lattice', { category: 'cs' }],
          ['co:ICML OR ti:lattice', {}],
          ['cat:cs', {}],
          ['cat:cs.LG', {}],
          ['(cat:cs.LG OR cat:astro-ph.CO)', {}],
          ['cat:astro-ph', {}],
          ['abs:cosmic', { category: 'astro-ph' }],
          ['cat:cs.AI', { category: 'cs.LG' }],
          ['ti:chronometry', { submittedFrom: '2024-03-10', submittedTo: '2024-03-12' }],
          ['submittedDate:[202402010000 TO 202403130000]', {}],
          ['cat:cs', { submittedFrom: '2024-02-05' }],
        ];
        const viaWorker = new ArxivService();
        const reference = inThread();
        let pagesOfThree = 0;
        let pastTheEnd = 0;
        for (const [query, filters] of queries) {
          for (const sortBy of ['relevance', 'submitted', 'updated'] as const) {
            for (const sortOrder of ['ascending', 'descending'] as const) {
              for (const start of [0, 3, 500]) {
                const options = { ...filters, sortBy, sortOrder, start, maxResults: 4 };
                const expected = await reference.search(query, options, createMockContext());
                const actual = await viaWorker.search(query, options, createMockContext());
                expect(actual, JSON.stringify([query, options])).toEqual(expected);
                if (actual.papers.length >= 3) pagesOfThree++;
                if (start === 500 && actual.total_results > 0) {
                  expect(actual.papers).toEqual([]);
                  pastTheEnd++;
                }
              }
            }
          }
        }

        expect(mockFetch).not.toHaveBeenCalled();
        expect(pagesOfThree).toBeGreaterThan(50);
        expect(pastTheEnd).toBeGreaterThan(30);
      });
    });

    describe('routing', () => {
      it('still sends a term at the match cap to the live API, for every sort order', async () => {
        seedBulk(50_000, 'ubiquitous');
        mockFetch.mockImplementation(async (request) => {
          const url = new URL(String(request));
          if (url.hostname !== 'export.arxiv.org') throw new Error(`Unexpected request: ${url}`);
          return atomResponse(ATOM_AT_CAP);
        });
        const viaWorker = new ArxivService();
        for (const sortBy of ['relevance', 'updated', 'submitted'] as const) {
          for (const sortOrder of ['ascending', 'descending'] as const) {
            const result = await viaWorker.search(
              'ubiquitous',
              { maxResults: 1, sortBy, sortOrder },
              createMockContext(),
            );
            expect(result.total_results).toBe(1_025_313);
            expect(result.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
          }
        }
        expect(mockFetch).toHaveBeenCalledTimes(6);
      }, 30_000);

      it('keeps category- and date-only searches on the mirror, and serves start 10,000 there', async () => {
        seedBulk(50_000, 'ubiquitous');
        const viaWorker = new ArxivService();
        const ctx = createMockContext();

        const byCode = await viaWorker.search('cat:cs.LG', { maxResults: 2 }, ctx);
        const byArchive = await viaWorker.search(
          'cat:cs',
          { maxResults: 2, sortBy: 'submitted' },
          ctx,
        );
        const byDate = await viaWorker.search(
          'submittedDate:[202301010000 TO 202401010000]',
          { maxResults: 2 },
          ctx,
        );
        const deep = await viaWorker.search('cat:cs.LG', { start: 10_000, maxResults: 3 }, ctx);

        expect(mockFetch).not.toHaveBeenCalled();
        // The bulk papers, plus the seeded cs.LG paper where the filter reaches
        // it. One code counts exactly; a whole archive and a window stop at the
        // cap (#78).
        expect(byCode.total_results).toBe(50_001);
        expect(byArchive.total_results).toBe(50_000);
        expect(byDate.total_results).toBe(50_000);
        expect(deep).toMatchObject({ start: 10_000, total_results: 50_001 });
        expect(deep.papers).toHaveLength(3);
        expect(deep.result_limit).toBeUndefined();
      }, 30_000);
    });

    it('lets a request-thread timer fire while the worker runs a search', async () => {
      seedBulk(50_000, 'ubiquitous');
      const call = ['cat:cs', { maxResults: 5, sortBy: 'submitted' }] as const;
      const viaWorker = new ArxivService();
      // Starts the worker and opens its store, so what follows times the search alone.
      await viaWorker.search(...call, createMockContext());

      /** Run `search` with a 1 ms interval timer on this thread; count its ticks before the reply. */
      const ticksDuring = async (search: () => Promise<unknown>) => {
        let ticks = 0;
        const timer = setInterval(() => {
          ticks++;
        }, 1);
        try {
          const result = await search();
          return { result, ticks };
        } finally {
          clearInterval(timer);
        }
      };
      const onThread = await ticksDuring(() => inThread().search(...call, createMockContext()));
      const offThread = await ticksDuring(() => viaWorker.search(...call, createMockContext()));

      expect(mockFetch).not.toHaveBeenCalled();
      expect(offThread.result).toEqual(onThread.result);
      // 50,001 papers in the archive: the count stops at the cap (#78).
      expect(offThread.result).toMatchObject({ total_results: 50_000 });
      // The same search on the request thread holds the timer until it returns.
      expect(onThread.ticks).toBe(0);
      expect(offThread.ticks).toBeGreaterThan(0);
    }, 30_000);

    it('settles a cancelled search as RequestCancelled at the tool boundary without waiting for its statement', async () => {
      seedBulk(50_000, 'ubiquitous');
      initArxivService();
      const input = { query: 'cat:cs', max_results: 5, sort_by: 'submitted' } as const;
      await runToolContract(arxivSearchPapers, input);
      const ctrl = new AbortController();
      const order: string[] = [];

      const cancelled = runToolContract(arxivSearchPapers, input, {
        context: { signal: ctrl.signal },
      }).then((result) => {
        order.push('cancelled');
        return result;
      });
      // Once the cancelled search is running in the worker, queue one behind it,
      // then cancel.
      await new Promise((resolve) => setImmediate(resolve));
      const next = runToolContract(arxivSearchPapers, input).then((result) => {
        order.push('next');
        return result;
      });
      ctrl.abort('the caller cancelled this search');
      // The worker's reply to the cancelled search can only land on a later turn
      // of the event loop, so a call that waited for it settles after this one.
      const turn = new Promise<void>((resolve) =>
        setImmediate(() => {
          order.push('turn');
          resolve();
        }),
      );

      const result = await cancelled;
      await turn;
      expect(order.slice(0, 2)).toEqual(['cancelled', 'turn']);
      expect(result.isError, JSON.stringify(result)).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.message).toContain('the caller cancelled this search');
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('the caller cancelled this search');
      expect((await next).isError).toBeFalsy();
      expect(order).toEqual(['cancelled', 'turn', 'next']);
      expect(mockFetch).not.toHaveBeenCalled();
    }, 30_000);

    it('reports an fts5 error raised in the worker as unsupported_query_syntax, at the service and the tool boundary', async () => {
      // Nested deeper than the FTS5 parser goes.
      const nested = `${'('.repeat(100)}attention${')'.repeat(100)}`;
      await expect(
        new ArxivService().search(nested, { maxResults: 1 }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('fts5: '),
        data: { reason: 'unsupported_query_syntax', query: nested },
      });

      initArxivService();
      const result = await runToolContract(arxivSearchPapers, { query: nested, max_results: 1 });
      expect(result.isError, JSON.stringify(result)).toBe(true);
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(error.data.reason).toBe('unsupported_query_syntax');
      const declared = arxivSearchPapers.errors!.find(
        (e) => e.reason === 'unsupported_query_syntax',
      );
      expect(error.data.recovery).toEqual({ hint: declared!.recovery });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // The request thread's store, once open, stays open on the file it opened,
    // so pointing the config elsewhere leaves only the worker's open to fail.
    it("answers live, with the request thread's warning, when the worker's own open fails, and answers the next from a new worker", async () => {
      const viaWorker = new ArxivService();
      await viaWorker.search('ti:transformers', { maxResults: 10 }, createMockContext());
      const mirrorPath = configOverrides.mirrorPath;
      const garbage = join(dir, 'garbage.db');
      await writeFile(garbage, 'not a database, only text '.repeat(400));
      configOverrides.mirrorPath = garbage;
      serveLivePaper();

      const ctx = createMockContext();
      const warning = vi.spyOn(ctx.log, 'warning');
      const live = await viaWorker.search('ti:transformers', { maxResults: 10 }, ctx);
      expect(live.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(warning).toHaveBeenCalledWith('Mirror open failed; using live API', {
        error: `Failed to open mirror store at ${garbage}`,
      });

      // At the tool boundary no server path reaches the caller, on either surface.
      initArxivService();
      const result = await runToolContract(arxivSearchPapers, {
        query: 'ti:transformers',
        max_results: 10,
      });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(dir);
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('2402.99999v1');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      configOverrides.mirrorPath = mirrorPath;
      const next = await viaWorker.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );
      expect(next.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("answers live when the worker's own open finds the file not ready, reporting an older schema", async () => {
      const onMirrorSchemaOutdated = vi.fn();
      const viaWorker = new ArxivService({ onMirrorSchemaOutdated });
      await viaWorker.search('ti:transformers', { maxResults: 10 }, createMockContext());
      const mirrorPath = configOverrides.mirrorPath;
      serveLivePaper();

      configOverrides.mirrorPath = join(dir, 'absent', 'mirror.db');
      const missing = await viaWorker.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );
      expect(missing.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(onMirrorSchemaOutdated).not.toHaveBeenCalled();

      const olderPath = join(dir, 'older.db');
      (await MirrorStore.open(olderPath)).close();
      downgradeToV2(olderPath);
      configOverrides.mirrorPath = olderPath;
      const older = await viaWorker.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );
      expect(older.papers.map((p) => p.id)).toEqual(['2402.99999v1']);
      expect(onMirrorSchemaOutdated).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      configOverrides.mirrorPath = mirrorPath;
      const served = await viaWorker.search(
        'ti:transformers',
        { maxResults: 10 },
        createMockContext(),
      );
      expect(served.papers.map((p) => p.id)).toEqual(['2401.10001v1']);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #76 — a SQLite error raised while the mirror answers a call (a
  // corrupt page, an I/O error) is handled as a failed open: a warning, then
  // the live API. No SQLite text reaches the caller, and where the mirror was
  // standing in for a live call that already failed, that failure stands.
  // -------------------------------------------------------------------------

  describe('a mirror read that fails at query time (#76)', () => {
    const rateLimited = () =>
      new Response('Rate exceeded.', { status: 200, headers: { 'content-type': 'text/plain' } });
    const recencyBypass = { maxResults: 5, sortBy: 'submitted', sortOrder: 'descending' } as const;
    const textOf = (result: { content: { type: string; text?: string }[] }): string =>
      result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    /** A service whose every mirror search settles as `searcher` does. */
    const searchingWith = (searcher: MirrorSearcher) =>
      new ArxivService({ mirrorSearcher: searcher });
    const driverErrorFromWorker = () =>
      fromWireError(structuredClone(toWireError(sqliteDriverError())));
    const stoppedReader = () =>
      serviceUnavailable('The mirror reader stopped before answering this search; retry it.', {
        exitCode: 1,
      });

    describe('search', () => {
      it('answers live, with a warning, when the cap probe throws a driver error', async () => {
        const probeSpy = vi
          .spyOn(MirrorStore.prototype, 'matchReachesCap')
          .mockImplementation(() => {
            throw sqliteDriverError();
          });
        serveLivePaper();
        try {
          const ctx = createMockContext();
          const warning = vi.spyOn(ctx.log, 'warning');
          const result = await service.search('attention', { maxResults: 1 }, ctx);
          expect(result.papers.map((p) => p.title)).toEqual(['From Live API']);
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(warning).toHaveBeenCalledWith('Mirror search failed; using live API', {
            error: 'no such table: missing_table',
          });
        } finally {
          probeSpy.mockRestore();
        }
      });

      it('answers live, with a warning, when the reader worker replies with a driver error', async () => {
        serveLivePaper();
        const ctx = createMockContext();
        const warning = vi.spyOn(ctx.log, 'warning');
        const result = await searchingWith(() => Promise.reject(driverErrorFromWorker())).search(
          'attention',
          { maxResults: 1 },
          ctx,
        );
        expect(result.papers.map((p) => p.title)).toEqual(['From Live API']);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith('Mirror search failed; using live API', {
          error: 'no such table: missing_table',
        });
      });

      it('keeps a reader that stopped before answering as ServiceUnavailable', async () => {
        await expect(
          searchingWith(() => Promise.reject(stoppedReader())).search(
            'attention',
            { maxResults: 1 },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'The mirror reader stopped before answering this search; retry it.',
        });
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('lets an error the driver did not raise propagate', async () => {
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
          throw new TypeError('a bug in the mirror path');
        });
        try {
          await expect(
            service.search('attention', { maxResults: 1 }, createMockContext()),
          ).rejects.toThrow(new TypeError('a bug in the mirror path'));
          expect(mockFetch).not.toHaveBeenCalled();
        } finally {
          searchSpy.mockRestore();
        }
      });

      it('fails a call cancelled during its mirror search with the caller’s reason', async () => {
        const ctrl = new AbortController();
        await expect(
          searchingWith((_mirror, _options, signal) => {
            ctrl.abort('the caller cancelled this search');
            return Promise.reject(signal.reason);
          }).search('attention', { maxResults: 1 }, createMockContext({ signal: ctrl.signal })),
        ).rejects.toBe('the caller cancelled this search');
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('fails a call cancelled during its live fallback as cancelled, never with the store error', async () => {
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
          throw sqliteDriverError();
        });
        const ctrl = new AbortController();
        mockFetch.mockImplementation(() => {
          ctrl.abort(new DOMException('The client cancelled the call.', 'AbortError'));
          return Promise.reject(ctrl.signal.reason);
        });
        try {
          await expect(
            service.search(
              'attention',
              { maxResults: 1 },
              createMockContext({ signal: ctrl.signal }),
            ),
          ).rejects.toMatchObject({
            name: 'AbortError',
            message: 'The client cancelled the call.',
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
        } finally {
          searchSpy.mockRestore();
        }
      });
    });

    describe('the recency bypass falling back to the mirror', () => {
      beforeEach(() => {
        configOverrides.mirrorRecentDaysLive = 2;
      });

      const searchFailed = 'Mirror search failed; using live API';
      const fallbackFailed = 'Mirror fallback failed on recency bypass; returning the live failure';
      it.each([
        ['a driver error', sqliteDriverError, searchFailed, 'no such table: missing_table'],
        [
          'a driver error the reader worker replied with',
          driverErrorFromWorker,
          searchFailed,
          'no such table: missing_table',
        ],
        [
          'an fts5 error',
          () => new Error('fts5: syntax error near ":"'),
          fallbackFailed,
          'Mirror search could not parse the translated FTS5 expression: fts5: syntax error near ":"',
        ],
        [
          'a reader that stopped',
          stoppedReader,
          fallbackFailed,
          'The mirror reader stopped before answering this search; retry it.',
        ],
        [
          'an error the driver did not raise',
          () => new TypeError('a bug in the mirror path'),
          fallbackFailed,
          'a bug in the mirror path',
        ],
      ])(
        'returns the live failure when the mirror throws %s',
        async (_label, mirrorError, logged, error) => {
          mockFetch.mockResolvedValue(rateLimited());
          const ctx = createMockContext();
          const warning = vi.spyOn(ctx.log, 'warning');
          await expect(
            searchingWith(() => Promise.reject(mirrorError())).search(
              'transformers',
              recencyBypass,
              ctx,
            ),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: { reason: 'rate_limited' },
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(warning).toHaveBeenCalledWith(logged, { error });
        },
      );

      it('returns the live failure when the store itself throws a driver error', async () => {
        const searchSpy = vi.spyOn(MirrorStore.prototype, 'search').mockImplementation(() => {
          throw sqliteDriverError();
        });
        mockFetch.mockResolvedValue(rateLimited());
        try {
          await expect(
            service.search('transformers', recencyBypass, createMockContext()),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
          expect(searchSpy).toHaveBeenCalledTimes(1);
        } finally {
          searchSpy.mockRestore();
        }
      });

      it('fails a call cancelled during the fallback with the caller’s reason', async () => {
        mockFetch.mockResolvedValue(rateLimited());
        const ctrl = new AbortController();
        await expect(
          searchingWith((_mirror, _options, signal) => {
            ctrl.abort('the caller cancelled this search');
            return Promise.reject(signal.reason);
          }).search('transformers', recencyBypass, createMockContext({ signal: ctrl.signal })),
        ).rejects.toBe('the caller cancelled this search');
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPapers', () => {
      const failLookups = () =>
        vi.spyOn(MirrorStore.prototype, 'getPapersByIds').mockImplementation(() => {
          throw sqliteDriverError();
        });

      it.each([true, false])(
        'answers the whole lookup live, with a warning, whatever ARXIV_MIRROR_FALLBACK_LIVE says (%s)',
        async (fallbackLive) => {
          configOverrides.mirrorFallbackLive = fallbackLive;
          const lookupSpy = failLookups();
          serveLivePaper();
          try {
            const ctx = createMockContext();
            const warning = vi.spyOn(ctx.log, 'warning');
            const result = await service.getPapers(['2401.10001', '2402.99999'], ctx);
            // The mirror holds 2401.10001, yet the lookup asks arXiv for both IDs.
            expect(idLists()).toEqual(['2401.10001,2402.99999']);
            expect(result.papers.map((p) => [p.id, p.title])).toEqual([
              ['2402.99999v1', 'From Live API'],
            ]);
            expect(result.not_found).toEqual([{ id: '2401.10001', reason: 'not_in_arxiv' }]);
            expect(warning).toHaveBeenCalledWith('Mirror lookup failed; using live API', {
              error: 'no such table: missing_table',
            });
          } finally {
            lookupSpy.mockRestore();
          }
        },
      );

      it('lets an error the driver did not raise propagate', async () => {
        const lookupSpy = vi
          .spyOn(MirrorStore.prototype, 'getPapersByIds')
          .mockImplementation(() => {
            throw new TypeError('a bug in the mirror path');
          });
        try {
          await expect(service.getPapers(['2401.10001'], createMockContext())).rejects.toThrow(
            new TypeError('a bug in the mirror path'),
          );
          expect(mockFetch).not.toHaveBeenCalled();
        } finally {
          lookupSpy.mockRestore();
        }
      });

      it('fails a lookup cancelled during its live fallback as cancelled', async () => {
        const lookupSpy = failLookups();
        const ctrl = new AbortController();
        mockFetch.mockImplementation(() => {
          ctrl.abort(new DOMException('The client cancelled the call.', 'AbortError'));
          return Promise.reject(ctrl.signal.reason);
        });
        try {
          await expect(
            service.getPapers(['2401.10001'], createMockContext({ signal: ctrl.signal })),
          ).rejects.toMatchObject({
            name: 'AbortError',
            message: 'The client cancelled the call.',
          });
          expect(mockFetch).toHaveBeenCalledTimes(1);
        } finally {
          lookupSpy.mockRestore();
        }
      });

      it('answers arxiv_get_metadata and the paper resource live, with no SQLite text', async () => {
        const lookupSpy = failLookups();
        serveLivePaper();
        try {
          initArxivService();
          const result = await runToolContract(arxivGetMetadata, { paper_ids: ['2402.99999'] });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const output = arxivGetMetadata.output.parse(result.structuredContent);
          expect(output.papers.map((p) => [p.id, p.title])).toEqual([
            ['2402.99999v1', 'From Live API'],
          ]);
          expect(textOf(result)).toContain('From Live API');
          expect(JSON.stringify(result)).not.toContain('missing_table');

          const ctx = createMockContext({ errors: paperResource.errors! }) as Parameters<
            typeof paperResource.handler
          >[1];
          await expect(
            paperResource.handler({ paperId: '2402.99999' }, ctx),
          ).resolves.toMatchObject({ id: '2402.99999v1', title: 'From Live API' });
          expect(mockFetch).toHaveBeenCalledTimes(2);
        } finally {
          lookupSpy.mockRestore();
        }
      });
    });

    // The issue's `dd` reproduction on a synthetic mirror: 16 pages of 0xFF from
    // the `papers` page holding the marker row (2402.99999, the ID the live
    // stub answers for). Every page past it is FTS or category data, so the
    // open still succeeds and the failure lands at query time.
    describe('over a real overwritten page', () => {
      const MARKER_DOI = '10.76/overwritten-page-marker';

      beforeEach(async () => {
        seedBulk(2000, 'filler');
        const db = new Database(configOverrides.mirrorPath);
        db.prepare(
          `INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                              categories, published, updated, latest_version, doi)
           VALUES ('2402.99999', '1', 'Marker paper', 'Marker Author', 'zymurgy', 'q-fin.TR',
                   'q-fin.TR', '2024-02-15T00:00:00.000Z', '2024-02-15T00:00:00.000Z',
                   '2024-02-15T00:00:00.000Z', ?)`,
        ).run(MARKER_DOI);
        db.prepare(
          `INSERT INTO paper_categories(category, paper_id, updated, published)
           VALUES ('q-fin.TR', '2402.99999', '2024-02-15T00:00:00.000Z', '2024-02-15T00:00:00.000Z')`,
        ).run();
        db.run('PRAGMA wal_checkpoint(TRUNCATE)');
        const { page_size: pageSize } = db.query('PRAGMA page_size').get() as { page_size: number };
        const file = readFileSync(configOverrides.mirrorPath);
        const page = Math.floor(file.indexOf(MARKER_DOI) / pageSize) + 1;
        const owner = db.query('SELECT name FROM dbstat WHERE pageno = ?').get(page) as {
          name: string;
        } | null;
        db.close();
        expect(owner?.name).toBe('papers');

        const offset = (page - 1) * pageSize;
        const length = Math.min(16 * pageSize, file.length - offset);
        const handle = await open(configOverrides.mirrorPath, 'r+');
        try {
          await handle.write(Buffer.alloc(length, 0xff), 0, length, offset);
        } finally {
          await handle.close();
        }
      });

      it('answers free-text and category searches live, with a warning, in the reader worker and on the request thread', async () => {
        serveLivePaper();
        for (const [label, svc] of [
          ['worker', new ArxivService()],
          ['in-thread', service],
        ] as const) {
          for (const query of ['zymurgy', 'cat:q-fin.TR']) {
            const ctx = createMockContext();
            const warning = vi.spyOn(ctx.log, 'warning');
            const result = await svc.search(query, { maxResults: 2 }, ctx);
            expect(
              result.papers.map((p) => p.title),
              `${label} ${query}`,
            ).toEqual(['From Live API']);
            expect(warning, `${label} ${query}`).toHaveBeenCalledWith(
              'Mirror search failed; using live API',
              { error: 'database disk image is malformed' },
            );
          }
        }
        expect(mockFetch).toHaveBeenCalledTimes(4);
      });

      it('answers an ID lookup on the page live, with a warning', async () => {
        serveLivePaper();
        const ctx = createMockContext();
        const warning = vi.spyOn(ctx.log, 'warning');
        const result = await service.getPapers(['2402.99999'], ctx);
        expect(idLists()).toEqual(['2402.99999']);
        expect(result.papers.map((p) => p.title)).toEqual(['From Live API']);
        expect(warning).toHaveBeenCalledWith('Mirror lookup failed; using live API', {
          error: 'database disk image is malformed',
        });
      });

      it('returns the live failure when the recency bypass falls back to the mirror', async () => {
        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockImplementation(async () => rateLimited());
        for (const svc of [new ArxivService(), service]) {
          await expect(
            svc.search('zymurgy', recencyBypass, createMockContext()),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
        }
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('reaches neither tool surface with SQLite text or the file path', async () => {
        serveLivePaper();
        initArxivService();
        const searched = await runToolContract(arxivSearchPapers, {
          query: 'cat:q-fin.TR',
          max_results: 2,
        });
        const looked = await runToolContract(arxivGetMetadata, { paper_ids: ['2402.99999'] });
        for (const result of [searched, looked]) {
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(textOf(result)).toContain('From Live API');
          const json = JSON.stringify(result);
          expect(json).not.toContain('malformed');
          expect(json).not.toContain(dir);
        }

        configOverrides.mirrorRecentDaysLive = 2;
        mockFetch.mockResolvedValue(rateLimited());
        const bypassed = await runToolContract(arxivSearchPapers, {
          query: 'zymurgy',
          max_results: 2,
          sort_by: 'submitted',
          sort_order: 'descending',
        });
        expect(bypassed.isError, JSON.stringify(bypassed)).toBe(true);
        const error = (bypassed.structuredContent as { error: { code: number } }).error;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(textOf(bypassed)).toContain('arXiv rate limit exceeded');
        expect(JSON.stringify(bypassed)).not.toContain('malformed');
      });
    });
  });
});
