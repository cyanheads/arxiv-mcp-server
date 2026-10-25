/**
 * @fileoverview The real-document corpus: every fixture under
 * `tests/corpus/<kind>/<fixture-id>/` is read through `ArxivService.readContent`
 * with the network rungs answering from its stored bytes (the PDF through the
 * real extractor), checked against the license gate and the read invariants in
 * `corpus-gate.ts`, and only then matched against its `expected.json` with
 * `toMatchFileSnapshot` — so `vitest run -u` rewrites a snapshot only for a
 * fixture whose checks held. The `corpus gate` block proves each check fails on
 * a broken copy of a fixture.
 * @module tests/corpus/corpus.test
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArxivService, initArxivService } from '@/services/arxiv/arxiv-service.js';
import type { PaperContentSource } from '@/services/arxiv/types.js';
import {
  biomeJson,
  type CheckName,
  CORPUS_KINDS,
  type CorpusFixture,
  type FixtureMeta,
  FixtureMetaSchema,
  licenseViolations,
  MAX_SOURCE_BYTES,
  PAGE_CHARACTERS,
  type ReadOutcome,
  readViolations,
  rungUrl,
  snapshotOf,
} from './corpus-gate.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
    readTimeoutMs: 50_000,
  }),
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

const CORPUS_ROOT = fileURLToPath(new URL('./', import.meta.url));

/** Every fixture directory under the corpus root: `<kind>/<fixture-id>/` holding a `meta.json`. */
function loadCorpus(): CorpusFixture[] {
  return readdirSync(CORPUS_ROOT)
    .filter((kind) => statSync(join(CORPUS_ROOT, kind)).isDirectory())
    .flatMap((kind) =>
      readdirSync(join(CORPUS_ROOT, kind))
        .filter((dir) => existsSync(join(CORPUS_ROOT, kind, dir, 'meta.json')))
        .map((dir) => loadFixture(kind, dir)),
    );
}

function loadFixture(kind: string, dir: string): CorpusFixture {
  const path = join(CORPUS_ROOT, kind, dir);
  const sourceFile = readdirSync(path).find((name) => name.startsWith('source.')) ?? '';
  const stored = readFileSync(join(path, sourceFile));
  return {
    dir,
    kind,
    meta: JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')),
    served: sourceFile.endsWith('.gz') ? gunzipSync(stored) : stored,
    sourceFile,
    storedBytes: stored.length,
  };
}

/** The rung a content request goes to, or `undefined` for any other host or path. */
function rungOf(url: URL): PaperContentSource | undefined {
  if (url.hostname === 'ar5iv.labs.arxiv.org') return 'ar5iv';
  if (url.hostname !== 'arxiv.org') return undefined;
  if (url.pathname.startsWith('/html/')) return 'arxiv_html';
  if (url.pathname.startsWith('/pdf/')) return 'pdf_text';
  return undefined;
}

/** How a rung answers when it is not the fixture's: ar5iv's 307 for "not converted", a 404 elsewhere. */
function absent(rung: PaperContentSource): Response {
  return new Response('', { status: rung === 'ar5iv' ? 307 : 404 });
}

function atomFor(meta: FixtureMeta): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/${meta.paperId}</id>
    <title>${meta.title}</title><summary>x</summary>
    <author><name>X</name></author>
    <published>2020-01-01T00:00:00Z</published><updated>2020-01-01T00:00:00Z</updated>
  </entry>
</feed>`;
}

/**
 * Answer the arXiv API with the fixture's paper, the fixture's rung with its
 * served bytes, and every other rung as absent; any other request is refused.
 * Returns the content URLs requested, in order.
 */
function serveFixture(meta: FixtureMeta, served: Uint8Array): string[] {
  const requested: string[] = [];
  mockFetch.mockImplementation(async (request) => {
    const url = new URL(String(request));
    if (url.hostname === 'export.arxiv.org') {
      return new Response(atomFor(meta), { headers: { 'content-type': 'application/atom+xml' } });
    }
    const rung = rungOf(url);
    if (rung === undefined) throw new Error(`Unexpected request: ${url}`);
    requested.push(url.href);
    if (rung !== meta.rung) return absent(rung);
    const response = new Response(Uint8Array.from(served), {
      headers: {
        'content-type': rung === 'pdf_text' ? 'application/pdf' : 'text/html; charset=UTF-8',
      },
    });
    // `new Response()` leaves `url` empty; the service resolves links against it.
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  });
  return requested;
}

/** Read `meta.paperId` the way the corpus checks it: paged at 100,000 characters, then once more at 0. */
async function readThrough(meta: FixtureMeta, served: Uint8Array): Promise<ReadOutcome> {
  const service = getArxivService();
  const ctx = createMockContext();
  const requested = serveFixture(meta, served);
  const read = (start: number) =>
    service.readContent(meta.paperId, { maxCharacters: PAGE_CHARACTERS, start }, ctx);

  let first: Awaited<ReturnType<typeof read>>;
  try {
    first = await read(0);
  } catch (error) {
    return { outcome: 'failed', error, requested: [...requested] };
  }
  const firstRequested = [...requested];
  const pages = [first];
  const pageLimit = Math.ceil(first.body_characters / PAGE_CHARACTERS) + 1;
  while (pages.at(-1)?.truncated && pages.length < pageLimit) {
    pages.push(await read(pages.length * PAGE_CHARACTERS));
  }
  return { outcome: 'read', pages, repeat: await read(0), requested: firstRequested };
}

/** The meta of a fixture whose license gate passed. */
function metaOf(fixture: CorpusFixture): FixtureMeta {
  return FixtureMetaSchema.parse(fixture.meta);
}

const fixtures = loadCorpus();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url) => {
    throw new Error(`Unmocked request: ${url}`);
  });
  initArxivService();
});

describe('corpus', () => {
  it.each(CORPUS_KINDS)('holds at least one %s fixture', (kind) => {
    expect(fixtures.filter((fixture) => fixture.kind === kind).length).toBeGreaterThan(0);
  });

  describe.each(fixtures.map((fixture) => [`${fixture.kind}/${fixture.dir}`, fixture] as const))(
    '%s',
    (_name, fixture) => {
      it('carries an allowlisted, confirmed license and a matching provenance record', () => {
        expect(licenseViolations(fixture)).toEqual([]);
      });

      it('reads within every invariant, then matches expected.json', async () => {
        // A failed check throws here, so the snapshot below is never compared or written.
        expect(licenseViolations(fixture)).toEqual([]);
        const meta = metaOf(fixture);
        const read = await readThrough(meta, fixture.served);
        expect(readViolations(fixture.kind, meta, read)).toEqual([]);
        await expect(`${biomeJson(snapshotOf(fixture.kind, read))}\n`).toMatchFileSnapshot(
          join(CORPUS_ROOT, fixture.kind, fixture.dir, 'expected.json'),
        );
      });
    },
  );
});

// ---------------------------------------------------------------------------
// The gate has teeth: each check fails on a broken copy of a fixture
// ---------------------------------------------------------------------------

/** The named fixture, which the gate tests break copies of. */
function fixtureNamed(kind: string, dir: string): CorpusFixture {
  const fixture = fixtures.find((f) => f.kind === kind && f.dir === dir);
  if (!fixture) throw new Error(`No corpus fixture ${kind}/${dir}`);
  return fixture;
}

/** The checks `violations` names. */
const checks = (violations: { check: CheckName }[]) => violations.map((v) => v.check);

describe('corpus gate', () => {
  describe('license and provenance', () => {
    const base = fixtureNamed('render', 'arxiv-2409.09856v3');
    const baseMeta = metaOf(base);
    /** `base` with `meta` fields replaced. */
    const withMeta = (patch: Record<string, unknown>): CorpusFixture => ({
      ...base,
      meta: { ...baseMeta, ...patch },
    });
    const withLicense = (patch: Partial<FixtureMeta['license']>) =>
      withMeta({ license: { ...baseMeta.license, ...patch } });

    it('passes the unbroken fixture', () => {
      expect(licenseViolations(base)).toEqual([]);
    });

    it.each([
      [
        'an NC license',
        withLicense({ id: 'CC-BY-NC-4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' }),
      ],
      [
        'an ND license',
        withLicense({ id: 'CC-BY-ND-4.0', url: 'https://creativecommons.org/licenses/by-nd/4.0/' }),
      ],
      [
        'arXiv’s non-exclusive license',
        withLicense({
          id: 'LicenseRef-arXiv-nonexclusive-distrib-1.0',
          url: 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/',
        }),
      ],
      [
        'an allowlisted id beside another license’s deed',
        withLicense({ url: 'https://creativecommons.org/licenses/by-nc/4.0/' }),
      ],
    ])('refuses %s', (_case, fixture) => {
      expect(checks(licenseViolations(fixture))).toEqual(['license_allowlist']);
    });

    it.each([
      ['CC BY-SA', { id: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }],
      ['CC0', { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }],
    ])('accepts %s', (_case, license) => {
      expect(licenseViolations(withLicense(license))).toEqual([]);
    });

    it.each([
      ['another version’s abs page', 'https://arxiv.org/abs/2409.09856v2'],
      ['the unversioned abs page', 'https://arxiv.org/abs/2409.09856'],
      ['an http abs page', 'http://arxiv.org/abs/2409.09856v3'],
      ['a lookalike host', 'https://arxiv.org.example.com/abs/2409.09856v3'],
      [
        'the retired OAI host',
        'https://export.arxiv.org/oai2?verb=GetRecord&identifier=oai:arXiv.org:2409.09856&metadataPrefix=arXiv',
      ],
      [
        'an OAI record of another paper',
        'https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:2409.09857&metadataPrefix=arXiv',
      ],
      [
        'an OAI record in another format',
        'https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:2409.09856&metadataPrefix=oai_dc',
      ],
      ['the license deed itself', 'https://creativecommons.org/licenses/by/4.0/'],
    ])('refuses confirmedBy as %s', (_case, confirmedBy) => {
      expect(checks(licenseViolations(withLicense({ confirmedBy })))).toEqual([
        'license_confirmed_by',
      ]);
    });

    it('accepts confirmedBy as the OAI-PMH GetRecord for the paper', () => {
      const confirmedBy =
        'https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:2409.09856&metadataPrefix=arXiv';
      expect(licenseViolations(withLicense({ confirmedBy }))).toEqual([]);
    });

    it('refuses a sha256 that is not the served bytes’', () => {
      const flipped = `${baseMeta.sha256.startsWith('0') ? '1' : '0'}${baseMeta.sha256.slice(1)}`;
      expect(checks(licenseViolations(withMeta({ sha256: flipped })))).toEqual(['sha256']);
    });

    it('refuses served bytes changed by one byte', () => {
      const served = Uint8Array.from(base.served);
      served[served.length - 2] = (served[served.length - 2] ?? 0) ^ 1;
      expect(checks(licenseViolations({ ...base, served }))).toEqual(['sha256']);
    });

    it('allows a stored source at the size cap and refuses one byte over', () => {
      expect(licenseViolations({ ...base, storedBytes: MAX_SOURCE_BYTES })).toEqual([]);
      expect(checks(licenseViolations({ ...base, storedBytes: MAX_SOURCE_BYTES + 1 }))).toEqual([
        'source_size',
      ]);
    });

    it.each([
      ['no attribution', { attribution: undefined }],
      ['an unversioned paperId', { paperId: '2409.09856' }],
      ['a field the record does not define', { mirroredFrom: 'elsewhere' }],
    ])('refuses a meta.json with %s', (_case, patch) => {
      expect(checks(licenseViolations(withMeta(patch)))).toEqual(['meta_schema']);
    });

    it('refuses a kind directory outside the set, an id that is not its directory, and a URL its rung does not serve', () => {
      expect(checks(licenseViolations({ ...base, kind: 'failure' }))).toEqual(['kind']);
      expect(checks(licenseViolations({ ...base, dir: 'arxiv-2409.09856v2' }))).toEqual([
        'fixture_id',
      ]);
      expect(
        checks(licenseViolations(withMeta({ url: 'https://arxiv.org/html/2409.09856v2' }))),
      ).toEqual(['served_url']);
    });

    it('refuses a pdf fixture stored as HTML, and an HTML rung under pdf/', () => {
      const pdf = fixtureNamed('pdf', 'arxiv-1906.00591v1');
      expect(checks(licenseViolations({ ...pdf, sourceFile: 'source.html.gz' }))).toEqual([
        'source_file',
      ]);
      expect(checks(licenseViolations({ ...base, kind: 'pdf' }))).toEqual(['kind_rung']);
    });
  });

  describe('read invariants', () => {
    const render = fixtureNamed('render', 'arxiv-2409.09856v3');
    const renderMeta = metaOf(render);
    let read: Extract<ReadOutcome, { outcome: 'read' }>;

    beforeAll(async () => {
      initArxivService();
      const outcome = await readThrough(renderMeta, render.served);
      if (outcome.outcome !== 'read') throw new Error('arxiv-2409.09856v3 did not read');
      read = outcome;
    });

    /** A deep copy of the render's read with `mutate` applied. */
    function broken(mutate: (copy: typeof read) => void): typeof read {
      const copy = structuredClone(read);
      mutate(copy);
      return copy;
    }
    /** The first page of a read, which every one of them has. */
    const firstPage = (copy: typeof read) => {
      const page = copy.pages[0];
      if (!page) throw new Error('no first page');
      return page;
    };
    /** Replace `from` with `to` in the first page that holds it. */
    const inject = (copy: typeof read, from: string, to: string) => {
      const page = copy.pages.find((p) => p.content.includes(from));
      if (!page) throw new Error(`no page holds ${from}`);
      page.content = page.content.replace(from, to);
    };

    it('passes the unbroken read, which spans several pages and drops an outline level', () => {
      expect(read.pages.length).toBeGreaterThan(1);
      expect(read.pages[0]?.outline_omitted_levels?.length).toBeGreaterThan(0);
      expect(readViolations('render', renderMeta, read)).toEqual([]);
    });

    it.each<[string, CheckName, (copy: typeof read) => void]>([
      [
        'a body served from another rung',
        'source',
        (c) => {
          firstPage(c).source = 'ar5iv';
        },
      ],
      [
        'a missing last page',
        'page_join',
        (c) => {
          c.pages.pop();
        },
      ],
      [
        'a page one character short',
        'page_join',
        (c) => {
          const p = c.pages[1];
          if (p) p.content = p.content.slice(1);
        },
      ],
      [
        'a page at the wrong start',
        'page_join',
        (c) => {
          const p = c.pages[1];
          if (p) p.start += 1;
        },
      ],
      [
        'a page reporting another body length',
        'page_join',
        (c) => {
          const p = c.pages[1];
          if (p) p.body_characters += 1;
        },
      ],
      [
        'an outline on a later page',
        'page_join',
        (c) => {
          const p = c.pages[1];
          if (p) p.outline = [];
        },
      ],
      [
        'a repeat read that differs',
        'repeat',
        (c) => {
          c.repeat.content = `${c.repeat.content} `;
        },
      ],
      [
        'no outline at start 0',
        'outline_order',
        (c) => {
          delete firstPage(c).outline;
        },
      ],
      [
        'two outline entries swapped',
        'outline_order',
        (c) => {
          const o = firstPage(c).outline ?? [];
          [o[3], o[4]] = [o[4] as (typeof o)[number], o[3] as (typeof o)[number]];
        },
      ],
      [
        'an entry off its heading tag',
        'outline_heading',
        (c) => {
          const e = firstPage(c).outline?.[5];
          if (e) e.start += 1;
        },
      ],
      [
        'an entry at the wrong level',
        'outline_heading',
        (c) => {
          const e = firstPage(c).outline?.[5];
          if (e) e.level += 1;
        },
      ],
      [
        'an outline past 200 entries',
        'outline_cap',
        (c) => {
          const page = firstPage(c);
          const o = page.outline ?? [];
          page.outline = Array.from({ length: 201 }, (_, i) => ({
            ...(o[0] as (typeof o)[number]),
            start: i,
          }));
        },
      ],
      [
        'a level dropped that fits',
        'outline_cap',
        (c) => {
          firstPage(c).outline_omitted_levels = [3, 2];
        },
      ],
      [
        'a shallower level dropped than the deepest',
        'outline_cap',
        (c) => {
          firstPage(c).outline_omitted_levels = [2];
        },
      ],
      [
        'an entry missing from the outline',
        'outline_headings',
        (c) => {
          firstPage(c).outline?.splice(10, 1);
        },
      ],
      ['an unclosed <math> left in', 'markup', (c) => inject(c, '<p>', '<math')],
      ['an id left in', 'markup', (c) => inject(c, '<p>', '<p id="S1.p1">')],
      [
        'a non-structural LaTeXML class left in',
        'markup',
        (c) => inject(c, '<p>', '<p class="ltx_p">'),
      ],
      ['a relative link', 'urls', (c) => inject(c, '<p>', '<p><img src="x1.png">')],
      ['a root-relative link', 'urls', (c) => inject(c, '<p>', '<p><a href="/abs/2409.09856">')],
      [
        'text after </article>',
        'article_end',
        (c) => {
          const p = c.pages.at(-1);
          if (p) p.content += '\n<footer>';
        },
      ],
    ])('fails %s with %s', (_case, check, mutate) => {
      expect(checks(readViolations('render', renderMeta, broken(mutate)))).toContain(check);
    });

    it('fails a render whose read failed', () => {
      const failed: ReadOutcome = {
        outcome: 'failed',
        error: { data: { reason: 'content_unavailable' } },
        requested: read.requested,
      };
      expect(checks(readViolations('render', renderMeta, failed))).toEqual(['outcome']);
    });

    it('lets a structural class, fragment, empty, and scheme-bearing link stand', () => {
      // Added on the last page, after every outline entry, so only the length moves.
      const copy = broken((c) => {
        const last = c.pages.at(-1);
        if (!last || c.pages.length < 2) throw new Error('the read has one page');
        last.content = last.content.replace(
          /<\/article>$/,
          '<p class="ltx_section"><a href="#bib.bib1"><a href=""><a href="mailto:a@b.c"><img src="data:image/png;base64,AA"></article>',
        );
      });
      expect(checks(readViolations('render', renderMeta, copy))).toEqual(['page_join']);
    });

    it('fails a fixture whose served page leaves an unclosed <math> in the article, read end to end', async () => {
      const ar5iv = fixtureNamed('render', 'ar5iv-1906.00591');
      const meta = metaOf(ar5iv);
      const page = new TextDecoder().decode(ar5iv.served);
      const end = page.lastIndexOf('</article>');
      const tampered = new TextEncoder().encode(
        `${page.slice(0, end)}<math display="block">${page.slice(end)}`,
      );

      const outcome = await readThrough(meta, tampered);

      expect(outcome.outcome).toBe('read');
      expect(checks(readViolations('render', meta, outcome))).toEqual(['markup']);
      expect(checks(licenseViolations({ ...ar5iv, served: tampered }))).toEqual(['sha256']);
    });

    it('fails a PDF read whose text and total lengths differ or which carries an outline or cap field', async () => {
      const pdf = fixtureNamed('pdf', 'arxiv-1906.00591v1');
      const meta = metaOf(pdf);
      const outcome = await readThrough(meta, pdf.served);
      if (outcome.outcome !== 'read') throw new Error('arxiv-1906.00591v1 did not read');
      expect(readViolations('pdf', meta, outcome)).toEqual([]);

      const longer = structuredClone(outcome);
      if (longer.pages[0]) longer.pages[0].total_characters += 1;
      longer.repeat.total_characters += 1;
      const outlined = structuredClone(outcome);
      if (outlined.pages[0])
        outlined.pages[0].outline = [{ level: 1, title: 'Introduction', start: 0 }];
      outlined.repeat.outline = [{ level: 1, title: 'Introduction', start: 0 }];
      const capped = structuredClone(outcome);
      if (capped.pages[0]) capped.pages[0].outline_omitted_levels = [3];
      capped.repeat.outline_omitted_levels = [3];

      expect(checks(readViolations('pdf', meta, longer))).toEqual(['pdf_shape']);
      expect(checks(readViolations('pdf', meta, outlined))).toEqual(['pdf_shape']);
      expect(checks(readViolations('pdf', meta, capped))).toEqual(['pdf_shape']);
      expect(
        checks(
          readViolations('pdf', meta, {
            ...outcome,
            pages: outcome.pages.map((p) => ({ ...p, source: 'ar5iv' as const })),
            repeat: { ...outcome.repeat, source: 'ar5iv' },
          }),
        ),
      ).toEqual(['source']);
    });

    it('fails an empty fixture whose chain stops at its page or ends in another way', async () => {
      const empty = fixtureNamed('empty', 'arxiv-2411.15218v2');
      const meta = metaOf(empty);
      const outcome = await readThrough(meta, empty.served);
      expect(readViolations('empty', meta, outcome)).toEqual([]);

      const stopped = { ...outcome, requested: outcome.requested.slice(0, 1) };
      const otherEnd = { ...outcome, error: { data: { reason: 'pdf_extraction_failed' } } };
      const served: ReadOutcome = {
        outcome: 'read',
        pages: read.pages,
        repeat: read.repeat,
        requested: [rungUrl('arxiv_html', meta.paperId)],
      };

      expect(checks(readViolations('empty', meta, stopped))).toEqual(['next_rung']);
      expect(checks(readViolations('empty', meta, otherEnd))).toEqual(['outcome']);
      expect(checks(readViolations('empty', meta, served))).toEqual(['next_rung', 'outcome']);
    });
  });
});
