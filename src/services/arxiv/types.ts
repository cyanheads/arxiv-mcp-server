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
}

export interface SearchResult {
  papers: PaperMetadata[];
  start: number;
  total_results: number;
}

/**
 * Why a requested ID returned no metadata. The tool layer advertises these
 * verbatim as its `not_found[].reason` enum, so a value added here widens that
 * tool's output schema.
 *
 * - `not_in_arxiv` — arXiv itself returned nothing for the ID.
 * - `version_not_in_mirror` — the paper exists and the local mirror holds it,
 *   but at a different version, and live fallback is disabled. The ID is
 *   unreachable in this configuration, not absent from arXiv. See issue #35.
 */
export const PaperNotFoundReasonSchema = z
  .enum(['not_in_arxiv', 'version_not_in_mirror'])
  .describe('Why the paper ID could not be returned.');

export type PaperNotFoundReason = z.infer<typeof PaperNotFoundReasonSchema>;

/** One requested ID that returned no metadata, with the reason it could not be served. */
export interface PaperLookupMiss {
  /** Human-readable supplement — names the version the mirror holds, when known. */
  detail?: string;
  id: string;
  reason: PaperNotFoundReason;
}

export interface PaperLookupResult {
  /** Requested IDs that returned no data, each with a stable reason the tool layer forwards verbatim. */
  not_found?: PaperLookupMiss[];
  papers: PaperMetadata[];
}

export interface ReadContentOptions {
  maxCharacters?: number;
  /** Character offset into the cleaned body to begin the slice. Defaults to 0. */
  start?: number;
}

export interface PaperContent {
  abstract_url: string;
  body_characters: number;
  content: string;
  paper_id: string;
  pdf_url: string;
  source: 'arxiv_html' | 'ar5iv';
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
