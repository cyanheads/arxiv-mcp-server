/**
 * @fileoverview Domain types and shared Zod schemas for the arXiv service.
 * @module services/arxiv/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Shared schema for paper metadata — used by search, get_metadata, and resource outputs. */
export const PaperMetadataSchema = z
  .object({
    id: z.string().describe('arXiv paper ID (e.g., "2401.12345v1").'),
    title: z.string().describe('Paper title.'),
    authors: z.array(z.string()).describe('Author names.'),
    abstract: z.string().describe('Full abstract text.'),
    primary_category: z.string().describe('Primary arXiv category (e.g., "cs.CL").'),
    categories: z.array(z.string()).describe('All arXiv categories assigned to this paper.'),
    published: z.string().describe('Original submission date (ISO 8601).'),
    updated: z.string().describe('Last update date (ISO 8601).'),
    comment: z.string().optional().describe('Author comment (e.g., page count, conference).'),
    journal_ref: z.string().optional().describe('Journal reference if published.'),
    doi: z.string().optional().describe('DOI if available.'),
    pdf_url: z.string().describe('Direct PDF download URL.'),
    abstract_url: z.string().describe('arXiv abstract page URL.'),
  })
  .describe('arXiv paper metadata — identifier, title, authors, abstract, categories, and links.');

export type PaperMetadata = z.infer<typeof PaperMetadataSchema>;

export interface SearchOptions {
  category?: string;
  maxResults?: number;
  sortBy?: 'relevance' | 'submitted' | 'updated';
  sortOrder?: 'ascending' | 'descending';
  start?: number;
  /** Earliest submission date to include, inclusive, `YYYY-MM-DD` UTC. */
  submittedFrom?: string;
  /** Latest submission date to include, inclusive, `YYYY-MM-DD` UTC. */
  submittedTo?: string;
}

export interface SearchResult {
  /**
   * The query carrying every filter the search actually applied — the category
   * subtree and the submitted-date window folded into arXiv syntax alongside the
   * caller's terms. It is what the live API received verbatim, and replaying it
   * as `query` with no other options reproduces this result set on either path.
   * Both paths populate it, so the tool's echo never has to reconstruct it.
   */
  effective_query: string;
  papers: PaperMetadata[];
  /**
   * How many leading matches the backend that answered can serve: set on the
   * live path to {@link ARXIV_API_RESULT_LIMIT}, where a page crossing it is cut
   * short. Absent on the mirror, which serves any offset.
   */
  result_limit?: number;
  start: number;
  total_results: number;
}

/**
 * arXiv's API serves only the first 10,000 results of a query: a request whose
 * `start + max_results` passes it answers HTTP 500, whatever the total. Verified
 * live — `start=9990&max_results=10` answers 200, `max_results=11` answers 500,
 * as does `start=10000&max_results=1`. See issue #56.
 */
export const ARXIV_API_RESULT_LIMIT = 10_000;

/**
 * Why a requested ID returned no metadata. The tool layer advertises these
 * verbatim as its `not_found[].reason` enum, so a value added here widens that
 * tool's output schema.
 *
 * - `not_in_arxiv` — arXiv itself returned nothing for the ID.
 * - `version_not_in_mirror` — the paper exists and the local mirror holds it,
 *   but at a different version, and live fallback is disabled. The ID is
 *   unreachable in this configuration, not absent from arXiv. See issue #35.
 * - `version_not_served` — the ID pins a superseded version of an old-style
 *   paper that arXiv's API answered HTTP 500 for; the version exists, and
 *   `detail` names the latest one. See issue #53.
 * - `live_lookup_failed` — the local mirror could not serve the ID and the
 *   live lookup it fell back to failed (arXiv unavailable, timed out, or
 *   throttled); `detail` names the failure, and a later call may serve it.
 *   See issue #67.
 * - `invalid_id` — the input is not an arXiv identifier in any accepted
 *   spelling, so it was never looked up. See issue #41.
 */
export const PaperNotFoundReasonSchema = z
  .enum([
    'not_in_arxiv',
    'version_not_in_mirror',
    'version_not_served',
    'live_lookup_failed',
    'invalid_id',
  ])
  .describe('Why the paper ID could not be returned.');

export type PaperNotFoundReason = z.infer<typeof PaperNotFoundReasonSchema>;

/** One requested ID that returned no metadata, with the reason it could not be served. */
export interface PaperLookupMiss {
  /** Human-readable supplement — names the version that can be served, when known. */
  detail?: string;
  id: string;
  reason: PaperNotFoundReason;
}

export interface PaperLookupResult {
  /** Requested IDs that returned no data, each with a stable reason the tool layer forwards verbatim. */
  not_found?: PaperLookupMiss[];
  papers: PaperMetadata[];
}

/**
 * Which upstream artifact the paper body was read from. The tool layer advertises
 * these verbatim as its `source` enum, so a value added here widens that tool's
 * output schema.
 *
 * - `arxiv_html` — arXiv's own LaTeXML render at `arxiv.org/html/{id}`.
 * - `ar5iv` — the ar5iv LaTeXML conversion at `ar5iv.labs.arxiv.org/html/{id}`.
 *   ar5iv keeps one render per paper, whatever version is requested. See issue #63.
 * - `pdf_text` — text extracted from the PDF, used when neither render exists.
 *   Both HTML pipelines run LaTeXML, so a submission that breaks one usually
 *   breaks the other and the PDF is the only artifact left. See issue #23.
 */
export const PaperContentSourceSchema = z
  .enum(['arxiv_html', 'ar5iv', 'pdf_text'])
  .describe(
    'Which upstream artifact the body was read from. arxiv_html and ar5iv are HTML renders; pdf_text is text extracted from the PDF, where prose is reliable but math, tables, and heading structure are flattened. ar5iv keeps one render per paper, so an ar5iv body can be another revision than paper_id (see revision_unconfirmed).',
  );

export type PaperContentSource = z.infer<typeof PaperContentSourceSchema>;

export interface ReadContentOptions {
  /**
   * Maximum characters of cleaned body to return. `null` returns the entire
   * body; omitted leaves the bound to the caller (the tool layer defaults it).
   */
  maxCharacters?: number | null;
  /** Character offset into the cleaned body to begin the slice. Defaults to 0. */
  start?: number;
}

/** One sectioning heading of a paper body, located by its offset in the cleaned body. */
export const OutlineEntrySchema = z
  .object({
    level: z
      .number()
      .int()
      .describe(
        'Heading depth from its tag number minus one: h2 = 1, h3 = 2, and so on to h6 = 5.',
      ),
    title: z
      .string()
      .describe(
        'Heading text with markup removed, e.g. "3.1 Encoder and Decoder Stacks"; cut at 120 characters.',
      ),
    start: z
      .number()
      .int()
      .describe('Offset of the heading in the cleaned body. Pass as start to read from it.'),
  })
  .describe(
    'A part, chapter, section, subsection, subsubsection, paragraph, appendix, or bibliography heading.',
  );

export type OutlineEntry = z.infer<typeof OutlineEntrySchema>;

export interface PaperContent {
  abstract_url: string;
  body_characters: number;
  content: string;
  /**
   * Sectioning headings of the cleaned body, in document order. Present only
   * on a read from `start` 0; empty for `pdf_text`, whose text carries no
   * reliable headings.
   */
  outline?: OutlineEntry[];
  /**
   * Offset of the first heading left out of `outline` when its shallowest level
   * alone passes the entry cap and is cut there. Present only on such a cut.
   */
  outline_continues_at?: number;
  /**
   * Heading levels left out of `outline` to keep it within its entry cap,
   * deepest first. Present only when levels were dropped.
   */
  outline_omitted_levels?: number[];
  paper_id: string;
  pdf_url: string;
  /**
   * Set on an ar5iv body, which may be another revision than `paper_id`: ar5iv
   * keeps one render per paper. Absent on every other body, and on an
   * unversioned read of a paper whose only version is v1. See issue #63.
   */
  revision_unconfirmed?: true;
  source: PaperContentSource;
  /** Character offset of the first character in `content` within the cleaned body. */
  start: number;
  title: string;
  total_characters: number;
  truncated: boolean;
}

/** Format a PaperMetadata into a readable text block. Shared by search and get_metadata tools. */
export function formatPaper(p: PaperMetadata): string {
  const cats = [p.primary_category, ...p.categories.filter((c) => c !== p.primary_category)]
    .filter(Boolean)
    .join(', ');
  const published = p.published?.split('T')[0];
  const updated = p.updated?.split('T')[0];
  const dateStr =
    published && updated && updated !== published
      ? `${published} (updated ${updated})`
      : published || updated;
  const meta = [`arXiv:${p.id}`, cats, dateStr].filter(Boolean).join(' | ');

  const lines = [`**${p.title}**`, meta, p.authors.join(', '), '', p.abstract];
  if (p.comment) lines.push(`\nComment: ${p.comment}`);
  if (p.journal_ref) lines.push(`Journal: ${p.journal_ref}`);
  if (p.doi) lines.push(`DOI: ${p.doi}`);
  lines.push(`Published: ${p.published} | Updated: ${p.updated}`);
  lines.push(`Abstract: ${p.abstract_url}`);
  lines.push(`PDF: ${p.pdf_url}`);
  return lines.join('\n');
}
