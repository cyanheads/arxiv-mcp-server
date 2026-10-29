/**
 * @fileoverview The checks a corpus fixture passes before its snapshot is compared:
 * the license and provenance record (`meta.json` against the stored source), and
 * the invariants of reading it through `readContent`. Each check returns the
 * violations it finds rather than throwing, so the runner asserts there are none
 * and the gate's own tests assert which check a broken copy trips.
 *
 * The invariants restate the read contract from the outside — the structural
 * heading and class sets are written out here rather than imported — so a change
 * to the cleaning passes that breaks the contract fails here instead of moving
 * the oracle with it.
 * @module tests/corpus/corpus-gate
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PaperContent, PaperContentSource } from '@/services/arxiv/types.js';

/** Fixture kinds, one directory each: the outcome a read of the fixture must reach. */
export const CORPUS_KINDS = ['render', 'empty', 'pdf'] as const;
/** Largest stored source a fixture may hold, in bytes (256 KB). */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Characters per page every fixture is read at: the tool's default `max_characters`. */
export const PAGE_CHARACTERS = 100_000;
/** Most entries an outline may carry. */
const OUTLINE_MAX_ENTRIES = 200;

/** The rungs in the order the read chain tries them. */
const RUNG_ORDER = ['arxiv_html', 'ar5iv', 'pdf_text'] as const satisfies PaperContentSource[];

/** Licenses a fixture may carry, by SPDX ID, each with the deed URL its record must name. */
const ALLOWED_LICENSES = new Map([
  ['CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  ['CC-BY-SA-4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
  ['CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
]);

/** A versioned arXiv ID: `2409.09856v3`, `hep-th/9711200v3`. */
const VERSIONED_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})v\d+$/;

export const FixtureMetaSchema = z.strictObject({
  id: z.string().min(1),
  paperId: z.string().regex(VERSIONED_ID),
  title: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  rung: z.enum(RUNG_ORDER),
  retrieved: z.iso.date(),
  license: z.strictObject({
    id: z.string().min(1),
    url: z.string().min(1),
    confirmedBy: z.string().min(1),
  }),
  attribution: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  notes: z.string().min(1).optional(),
});

export type FixtureMeta = z.infer<typeof FixtureMetaSchema>;

/** A fixture as loaded from `tests/corpus/<kind>/<dir>/`. */
export interface CorpusFixture {
  /** The fixture's directory name. */
  dir: string;
  /** The kind directory it sits in. */
  kind: string;
  /** `meta.json`, parsed as JSON but not yet validated. */
  meta: unknown;
  /** The document as served: the source file, gunzipped for `source.html.gz`. */
  served: Uint8Array;
  /** The stored source file's name. */
  sourceFile: string;
  /** Size of the stored source file, in bytes. */
  storedBytes: number;
}

/** What a read of a fixture produced, as the runner observed it. */
export type ReadOutcome =
  | {
      outcome: 'read';
      /** Reads at `start` 0, 100,000, … until one is not `truncated`. */
      pages: PaperContent[];
      /** A second read at `start` 0. */
      repeat: PaperContent;
      /** Content URLs the first read requested, in order. */
      requested: string[];
    }
  | { outcome: 'failed'; error: unknown; requested: string[] };

export type CheckName =
  | 'meta_schema'
  | 'kind'
  | 'fixture_id'
  | 'kind_rung'
  | 'source_file'
  | 'served_url'
  | 'license_allowlist'
  | 'license_confirmed_by'
  | 'sha256'
  | 'source_size'
  | 'outcome'
  | 'source'
  | 'next_rung'
  | 'page_join'
  | 'repeat'
  | 'outline_order'
  | 'outline_heading'
  | 'outline_cap'
  | 'outline_headings'
  | 'markup'
  | 'urls'
  | 'article_end'
  | 'pdf_shape';

export interface Violation {
  check: CheckName;
  detail: string;
}

/** The URL `rung` requests for `paperId`. */
export function rungUrl(rung: PaperContentSource, paperId: string): string {
  switch (rung) {
    case 'arxiv_html':
      return `https://arxiv.org/html/${paperId}`;
    case 'ar5iv':
      return `https://ar5iv.labs.arxiv.org/html/${paperId}`;
    case 'pdf_text':
      return `https://arxiv.org/pdf/${paperId}`;
  }
}

/** `paperId` without its version suffix. */
function baseId(paperId: string): string {
  return paperId.replace(/v\d+$/, '');
}

/**
 * Whether `confirmedBy` is a record of the license for that version: the abs
 * page of the exact version, or the OAI-PMH GetRecord for the paper (which
 * reports the latest version's license).
 */
function confirmsVersion(confirmedBy: string, paperId: string): boolean {
  const url = URL.parse(confirmedBy);
  if (url?.protocol !== 'https:' || url.hash !== '' || url.port !== '') return false;
  if (url.hostname === 'arxiv.org') return url.pathname === `/abs/${paperId}` && url.search === '';
  if (url.hostname !== 'oaipmh.arxiv.org' || url.pathname !== '/oai') return false;
  const params = url.searchParams;
  return (
    [...params.keys()].length === 3 &&
    params.get('verb') === 'GetRecord' &&
    params.get('identifier') === `oai:arXiv.org:${baseId(paperId)}` &&
    params.get('metadataPrefix') === 'arXiv'
  );
}

/**
 * The license gate: `meta.json` is well-formed, names an allowlisted license
 * confirmed at a record of that version, matches its directory, kind, and
 * source file, and carries the SHA-256 of the served bytes; the stored source
 * fits the size cap.
 */
export function licenseViolations(fixture: CorpusFixture): Violation[] {
  const violations: Violation[] = [];
  const add = (check: CheckName, detail: string) => violations.push({ check, detail });

  if (!(CORPUS_KINDS as readonly string[]).includes(fixture.kind)) {
    add('kind', `'${fixture.kind}' is not one of ${CORPUS_KINDS.join(', ')}`);
  }
  if (fixture.storedBytes > MAX_SOURCE_BYTES) {
    add(
      'source_size',
      `${fixture.sourceFile} is ${fixture.storedBytes} B, over ${MAX_SOURCE_BYTES} B`,
    );
  }

  const parsed = FixtureMetaSchema.safeParse(fixture.meta);
  if (!parsed.success) {
    add('meta_schema', z.prettifyError(parsed.error));
    return violations;
  }
  const meta = parsed.data;

  if (meta.id !== fixture.dir) add('fixture_id', `id '${meta.id}' in directory '${fixture.dir}'`);

  const htmlRung = meta.rung !== 'pdf_text';
  const kindRungs: Record<string, boolean> = {
    render: htmlRung,
    empty: htmlRung,
    pdf: !htmlRung,
  };
  if (kindRungs[fixture.kind] === false) {
    add('kind_rung', `a ${fixture.kind} fixture cannot come from rung ${meta.rung}`);
  }
  const expectedFile = htmlRung ? 'source.html.gz' : 'source.pdf';
  if (fixture.sourceFile !== expectedFile) {
    add('source_file', `rung ${meta.rung} stores ${expectedFile}, found ${fixture.sourceFile}`);
  }

  const servedUrls =
    meta.rung === 'ar5iv'
      ? [rungUrl('ar5iv', meta.paperId), rungUrl('ar5iv', baseId(meta.paperId))]
      : [rungUrl(meta.rung, meta.paperId)];
  if (!servedUrls.includes(meta.url)) {
    add('served_url', `${meta.url} is not where rung ${meta.rung} serves ${meta.paperId}`);
  }

  const deed = ALLOWED_LICENSES.get(meta.license.id);
  if (deed === undefined) {
    add(
      'license_allowlist',
      `${meta.license.id} is not one of ${[...ALLOWED_LICENSES.keys()].join(', ')}`,
    );
  } else if (meta.license.url !== deed) {
    add('license_allowlist', `${meta.license.id} names ${meta.license.url}, not ${deed}`);
  }
  if (!confirmsVersion(meta.license.confirmedBy, meta.paperId)) {
    add(
      'license_confirmed_by',
      `${meta.license.confirmedBy} is neither https://arxiv.org/abs/${meta.paperId} nor the oaipmh.arxiv.org GetRecord for ${baseId(meta.paperId)}`,
    );
  }

  const sha256 = createHash('sha256').update(fixture.served).digest('hex');
  if (sha256 !== meta.sha256)
    add('sha256', `served bytes hash to ${sha256}, meta says ${meta.sha256}`);

  return violations;
}

/** A structural heading opener: the headings the outline lists. */
const STRUCTURAL_HEADING =
  /<h([1-6])\s[^<>]*\bltx_title_(?:part|chapter|section|subsection|subsubsection|paragraph|appendix|bibliography)\b/g;
/** Class tokens the cleaning pass keeps on an `ltx_` class value. */
const STRUCTURAL_CLASS =
  /\bltx_(?:section|subsection|subsubsection|paragraph|subparagraph|appendix|bibliography|abstract|acknowledgements?|title|part|chapter)\b/;
const LTX_CLASS_VALUE = /\sclass="(ltx_[^"]*)"/gi;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** The first few items of `list`, for a violation's detail. */
function sample(list: readonly unknown[]): string {
  return `${list.length}: ${JSON.stringify(list.slice(0, 3))}`;
}

/** The `data.reason` an error carries, if any. */
function reasonOf(error: unknown): unknown {
  return (error as { data?: { reason?: unknown } } | null)?.data?.reason;
}

/**
 * The read invariants. A `render` or `pdf` fixture is served from its rung and
 * paged at 100,000 characters; an `empty` fixture is no render, so the chain
 * requests the next rung (served here as absent, ending in `content_unavailable`).
 */
export function readViolations(kind: string, meta: FixtureMeta, read: ReadOutcome): Violation[] {
  const violations: Violation[] = [];
  const add = (check: CheckName, detail: string) => violations.push({ check, detail });

  if (kind === 'empty') {
    const rungIndex = RUNG_ORDER.indexOf(meta.rung);
    const next = RUNG_ORDER[rungIndex + 1];
    const chain = RUNG_ORDER.map((rung) => rungUrl(rung, meta.paperId));
    if (
      read.requested[rungIndex] !== chain[rungIndex] ||
      next === undefined ||
      read.requested[rungIndex + 1] !== chain[rungIndex + 1]
    ) {
      add('next_rung', `requested ${sample(read.requested)} after the ${meta.rung} page`);
    }
    if (read.outcome !== 'failed' || reasonOf(read.error) !== 'content_unavailable') {
      add(
        'outcome',
        `expected content_unavailable with every other rung absent, got ${read.outcome === 'read' ? `a ${read.pages[0]?.source} body` : String(reasonOf(read.error))}`,
      );
    }
    return violations;
  }

  if (read.outcome !== 'read') {
    add('outcome', `the read failed: ${String(reasonOf(read.error) ?? read.error)}`);
    return violations;
  }
  const [first] = read.pages;
  if (first === undefined) {
    add('page_join', 'no page was read');
    return violations;
  }

  if (first.source !== meta.rung)
    add('source', `served from ${first.source}, fixture rung ${meta.rung}`);

  // Paging: start 0, 100,000, … rebuilds the body exactly.
  const body = read.pages.map((page) => page.content).join('');
  const pageFaults = read.pages.flatMap((page, i) => {
    const last = i === read.pages.length - 1;
    const faults: string[] = [];
    if (page.start !== i * PAGE_CHARACTERS) faults.push(`page ${i} starts at ${page.start}`);
    if (page.body_characters !== first.body_characters)
      faults.push(`page ${i} body_characters ${page.body_characters}`);
    if (page.truncated !== !last) faults.push(`page ${i} truncated ${page.truncated}`);
    if (!last && page.content.length !== PAGE_CHARACTERS)
      faults.push(`page ${i} holds ${page.content.length}`);
    if (i > 0 && page.outline !== undefined) faults.push(`page ${i} carries an outline`);
    return faults;
  });
  if (body.length !== first.body_characters) {
    pageFaults.push(`pages join to ${body.length}, body_characters ${first.body_characters}`);
  }
  if (pageFaults.length > 0) add('page_join', pageFaults.join('; '));

  if (!isDeepStrictEqual(first, read.repeat))
    add('repeat', 'a second read at start 0 differs from the first');

  if (meta.rung === 'pdf_text') {
    const faults: string[] = [];
    if (first.total_characters !== first.body_characters) {
      faults.push(
        `total_characters ${first.total_characters}, body_characters ${first.body_characters}`,
      );
    }
    if (!isDeepStrictEqual(first.outline, []))
      faults.push(`outline ${sample(first.outline ?? [])}`);
    if (first.outline_omitted_levels !== undefined || first.outline_continues_at !== undefined) {
      faults.push('outline cap fields set');
    }
    if (faults.length > 0) add('pdf_shape', faults.join('; '));
    return violations;
  }

  // Outline: ordered, on its headings, capped, and exactly the structural headings it keeps.
  const outline = first.outline ?? [];
  const omitted = first.outline_omitted_levels ?? [];
  const unordered = outline.filter(
    (entry, i) => i > 0 && entry.start <= (outline[i - 1]?.start ?? -1),
  );
  if (first.outline === undefined || unordered.length > 0) {
    add(
      'outline_order',
      first.outline === undefined ? 'no outline at start 0' : `out of order ${sample(unordered)}`,
    );
  }
  const offHeading = outline.filter(
    (entry) => !body.startsWith(`<h${entry.level + 1}`, entry.start),
  );
  if (offHeading.length > 0) add('outline_heading', `not at <h{level+1} ${sample(offHeading)}`);

  const headings = [...body.matchAll(STRUCTURAL_HEADING)].map((m) => ({
    level: Number(m[1]) - 1,
    start: m.index,
  }));
  const levelsDeepestFirst = [...new Set(headings.map((h) => h.level))].sort((a, b) => b - a);
  const capFaults: string[] = [];
  if (outline.length > OUTLINE_MAX_ENTRIES) capFaults.push(`${outline.length} entries`);
  if (!isDeepStrictEqual(omitted, levelsDeepestFirst.slice(0, omitted.length))) {
    capFaults.push(
      `omitted ${JSON.stringify(omitted)} are not the deepest levels of ${JSON.stringify(levelsDeepestFirst)}`,
    );
  }
  const lastOmitted = omitted.at(-1);
  if (lastOmitted !== undefined) {
    const withLastLevel = headings.filter(
      (h) => !omitted.includes(h.level) || h.level === lastOmitted,
    ).length;
    if (withLastLevel <= OUTLINE_MAX_ENTRIES) {
      capFaults.push(
        `level ${lastOmitted} dropped though keeping it gives ${withLastLevel} entries`,
      );
    }
  }
  if (capFaults.length > 0) add('outline_cap', capFaults.join('; '));

  const kept = headings.filter((h) => !omitted.includes(h.level));
  const listed = outline.map(({ level, start }) => ({ level, start }));
  const continuesAt = first.outline_continues_at;
  const expected = continuesAt === undefined ? kept : kept.slice(0, OUTLINE_MAX_ENTRIES);
  if (
    !isDeepStrictEqual(listed, expected) ||
    (continuesAt !== undefined && continuesAt !== kept[OUTLINE_MAX_ENTRIES]?.start)
  ) {
    add(
      'outline_headings',
      `outline lists ${listed.length} headings, the body holds ${kept.length} outside omitted levels ${JSON.stringify(omitted)}`,
    );
  }

  // Cleaning: no MathML, ids, styles, link titles, bare spans, non-structural classes, or relative links.
  const markup: string[] = [];
  if (/<math\b/i.test(body)) markup.push('<math');
  if (/\sid="/i.test(body)) markup.push('id="');
  if (/<[a-zA-Z][^<>]*\sstyle="/.test(body)) markup.push('style="');
  if (/<a\s(?:[^<>]*\s)?title="/.test(body)) markup.push('<a title="');
  if (/<span\s*>/.test(body)) markup.push('<span>');
  const noisyClasses = [...body.matchAll(LTX_CLASS_VALUE)]
    .map((m) => m[1] ?? '')
    .filter((value) => !STRUCTURAL_CLASS.test(value));
  if (noisyClasses.length > 0) markup.push(`classes ${sample(noisyClasses)}`);
  if (markup.length > 0) add('markup', markup.join('; '));

  const relative = [...body.matchAll(/<[a-zA-Z][^<>]*>/g)].flatMap(([tag]) =>
    [...tag.matchAll(/\s(?:src|href|data)="([^"]*)"/g)]
      .map((m) => m[1] ?? '')
      .filter((value) => value !== '' && !value.startsWith('#') && !URL_SCHEME.test(value)),
  );
  if (relative.length > 0) add('urls', `relative values ${sample(relative)}`);

  if (!body.endsWith('</article>'))
    add('article_end', `body ends ${JSON.stringify(body.slice(-40))}`);

  return violations;
}

/** Biome's line width; `expected.json` must already be in its layout or `devcheck` rewrites it. */
const LINE_WIDTH = 80;

/**
 * `value` as JSON in the layout Biome formats it to, so the formatter leaves a
 * written `expected.json` byte-for-byte as the snapshot compares it: objects
 * expanded one property per line, an array of scalars on one line when that
 * line fits in 80 columns and one element per line when it does not.
 * `lineStart` is the width of what precedes the value on its line.
 */
export function biomeJson(value: unknown, indent = '', lineStart = 0): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      const flat = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (lineStart + flat.length + 1 <= LINE_WIDTH) return flat;
    }
    const items = value.map((item) => `${inner}${biomeJson(item, inner, inner.length)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([key, v]) => {
      const prefix = `${inner}${JSON.stringify(key)}: `;
      return `${prefix}${biomeJson(v, inner, prefix.length)}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** What `expected.json` pins for a fixture whose invariants held. */
export function snapshotOf(kind: string, read: ReadOutcome): Record<string, unknown> {
  if (read.outcome === 'failed') {
    return { kind, outcome: 'no_render', reason: reasonOf(read.error), requested: read.requested };
  }
  const [first] = read.pages;
  const body = read.pages.map((page) => page.content).join('');
  return {
    kind,
    source: first?.source,
    body_characters: first?.body_characters,
    total_characters: first?.total_characters,
    pages: read.pages.length,
    body_sha256: createHash('sha256').update(body).digest('hex'),
    outline_omitted_levels: first?.outline_omitted_levels ?? [],
    ...(first?.outline_continues_at !== undefined && {
      outline_continues_at: first.outline_continues_at,
    }),
    outline: first?.outline,
  };
}
