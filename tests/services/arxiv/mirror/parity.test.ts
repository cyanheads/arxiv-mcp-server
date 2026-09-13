/**
 * @fileoverview Compare live Atom and SQLite mirror routes over a fixed corpus.
 * The upstream fake asserts the exact request; the mirror must perform no fetch.
 * Both routes run through the tool contract, including content and enrichment.
 * @module services/arxiv/mirror/parity.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { arxivSearch } from '@/mcp-server/tools/definitions/arxiv-search.tool.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';
import { MirrorStore, resetStore } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const records: ArxivRawRecord[] = [
  {
    paper_id: '2401.10001',
    identifier: 'oai:arXiv.org:2401.10001',
    datestamp: '2024-01-22',
    title: 'Transformer Methods',
    authors: 'Alice Smith, Bob Jones',
    abstract: 'Attention for language models.',
    categories: 'cs.LG cs.CL',
    comments: 'Includes a convergence proof',
    journal_ref: 'Journal of Learning',
    doi: '10.1234/fixture',
    versions: [
      { version: 'v1', date: '2024-01-10T00:00:00.000Z' },
      { version: 'v2', date: '2024-01-22T00:00:00.000Z' },
    ],
  },
  {
    paper_id: '2401.10002',
    identifier: 'oai:arXiv.org:2401.10002',
    datestamp: '2024-01-15',
    title: 'Dark Matter Observations',
    authors: 'Donald Knuth',
    abstract: 'A study of cosmic structure.',
    categories: 'astro-ph.CO',
    versions: [{ version: 'v1', date: '2024-01-15T00:00:00.000Z' }],
  },
  {
    paper_id: '2401.10003',
    identifier: 'oai:arXiv.org:2401.10003',
    datestamp: '2024-01-20',
    title: 'Transformer Architecture',
    authors: 'Carol Adams',
    abstract: 'Attention models for vision.',
    categories: 'cs.CV',
    versions: [{ version: 'v1', date: '2024-01-20T00:00:00.000Z' }],
  },
];

/** Encode the fixed upstream record shape without invoking server normalization. */
function atom(record: ArxivRawRecord): string {
  const first = record.versions[0]!;
  const last = record.versions.at(-1)!;
  return `<entry>
    <id>http://arxiv.org/abs/${record.paper_id}${last.version}</id>
    <title>${record.title}</title><summary>${record.abstract}</summary>
    ${record.authors
      .split(', ')
      .map((name) => `<author><name>${name}</name></author>`)
      .join('')}
    ${record.categories
      .split(' ')
      .map((category) => `<category term="${category}"/>`)
      .join('')}
    <published>${first.date}</published><updated>${last.date}</updated>
    ${record.comments ? `<arxiv:comment>${record.comments}</arxiv:comment>` : ''}
    ${record.journal_ref ? `<arxiv:journal_ref>${record.journal_ref}</arxiv:journal_ref>` : ''}
    ${record.doi ? `<arxiv:doi>${record.doi}</arxiv:doi>` : ''}
  </entry>`;
}

describe('mirror and live search contract parity', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'arxiv-parity-'));
    vi.stubEnv('ARXIV_MIRROR_PATH', join(directory, 'mirror.db'));
    vi.stubEnv('ARXIV_MIRROR_ENABLED', 'false');
    vi.stubEnv('ARXIV_MIRROR_RECENT_DAYS_LIVE', '0');
    vi.stubEnv('ARXIV_REQUEST_DELAY_MS', '0');
    vi.stubEnv('ARXIV_API_BASE_URL', 'https://export.arxiv.org/api');
    resetServerConfig();
    resetStore();
    const store = await MirrorStore.open(join(directory, 'mirror.db'));
    try {
      store.applyBatch(records, []);
      store.writeHarvestState({
        status: 'complete',
        completed_at: '2024-01-23T00:00:00.000Z',
        total_records: 3,
      });
    } finally {
      store.close();
    }
    initArxivService();
  });

  afterEach(async () => {
    resetStore();
    resetServerConfig();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  const cases = [
    {
      query: 'ti:transformer AND cat:cs.LG',
      expectedQuery: 'ti:transformer AND cat:cs.LG',
      ids: [0],
    },
    { query: 'au:knuth', expectedQuery: 'au:knuth', ids: [1] },
    { query: 'all:"dark matter"', expectedQuery: 'all:"dark matter"', ids: [1] },
    { query: 'all:convergence', expectedQuery: 'all:convergence', ids: [0] },
    { query: 'jr:Learning', expectedQuery: 'jr:Learning', ids: [0] },
    {
      query: 'ti:transformer',
      category: 'cs',
      expectedQuery: '(ti:transformer) AND cat:cs*',
      ids: [0, 2],
    },
    {
      query: 'ti:transformer',
      submitted_from: '2024-01-15',
      submitted_to: '2024-01-31',
      expectedQuery: '(ti:transformer) AND submittedDate:[202401150000 TO 202402010000]',
      ids: [2],
    },
    {
      query: 'ti:transformer',
      expectedQuery: 'ti:transformer',
      ids: [0, 2],
      start: 1,
      max_results: 1,
    },
    { query: 'ti:transformer', expectedQuery: 'ti:transformer', ids: [0, 2], max_results: 1 },
    { query: 'ti:transformer', expectedQuery: 'ti:transformer', ids: [0, 2], start: 10_000 },
    { query: 'ti:unfindable', expectedQuery: 'ti:unfindable', ids: [] },
  ];

  for (const example of cases) {
    it(`${example.query}, start=${example.start ?? 0}, limit=${example.max_results ?? 10}`, async () => {
      const { ids, expectedQuery, ...args } = example;
      const input = { ...args, sort_by: 'submitted' as const, sort_order: 'ascending' as const };
      const start = example.start ?? 0;
      const limit = example.max_results ?? 10;
      const page = ids.slice(start, start + limit).map((index) => records[index]!);
      const fetch = vi.fn(async (request: string | URL | Request) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          search_query: expectedQuery,
          start: String(start),
          max_results: String(limit),
          sortBy: 'submittedDate',
          sortOrder: 'ascending',
        });
        return new Response(
          `<feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
          xmlns:arxiv="http://arxiv.org/schemas/atom">
          <opensearch:totalResults>${ids.length}</opensearch:totalResults>
          <opensearch:startIndex>${start}</opensearch:startIndex>
          ${page.map(atom).join('')}</feed>`,
          { headers: { 'content-type': 'application/atom+xml' } },
        );
      });
      vi.stubGlobal('fetch', fetch);
      const live = await runToolContract(arxivSearch, input);
      expect(live.isError, JSON.stringify(live)).not.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);

      vi.stubEnv('ARXIV_MIRROR_ENABLED', 'true');
      resetServerConfig();
      initArxivService();
      const mirror = await runToolContract(arxivSearch, input);
      expect(mirror.isError, JSON.stringify(mirror)).not.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mirror.structuredContent).toEqual(live.structuredContent);
      expect(mirror.content).toEqual(live.content);
      const papers = arxivSearch.output.parse(mirror.structuredContent).papers;
      expect(papers.map((paper) => paper.id)).toEqual(
        page.map((record) => `${record.paper_id}${record.versions.at(-1)!.version}`),
      );
      const text = mirror.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(expectedQuery);
      for (const paper of papers) {
        for (const value of [
          paper.id,
          paper.title,
          paper.abstract,
          paper.pdf_url,
          paper.abstract_url,
          paper.published,
          paper.updated,
          ...paper.authors,
          ...paper.categories,
          ...[paper.comment, paper.journal_ref, paper.doi].filter((value) => value !== undefined),
        ]) {
          expect(text).toContain(value);
        }
      }
    });
  }
});
