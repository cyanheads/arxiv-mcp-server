/**
 * @fileoverview Internal types for the OAI-PMH mirror — `arXivRaw` record
 * shape, harvest state, and store-facing row types.
 * @module services/arxiv/mirror/types
 */

/** Per-version record nested inside `arXivRaw`. */
export interface ArxivRawVersion {
  date: string;
  size?: string;
  source_type?: string;
  version: string;
}

/**
 * Decoded `arXivRaw` metadata record (one paper). Fields mirror arXiv's
 * internal storage shape; some are absent on older papers.
 */
export interface ArxivRawRecord {
  abstract: string;
  /** Author block in raw arXiv format — last names + colon-separated affiliations. */
  authors: string;
  /** Whitespace-separated category codes; primary is first. */
  categories: string;
  comments?: string;
  /** Datestamp of the OAI record (YYYY-MM-DD). */
  datestamp: string;
  doi?: string;
  /** OAI identifier (`oai:arXiv.org:<id>`). */
  identifier: string;
  journal_ref?: string;
  license?: string;
  /** Bare arXiv paper ID (no version, e.g. `2401.12345`). */
  paper_id: string;
  report_no?: string;
  title: string;
  /** Version history — at least one entry; latest is last. */
  versions: ArxivRawVersion[];
}

/**
 * Tombstone for a deleted record (OAI `<header status="deleted">`).
 * Only the identifier + datestamp are present.
 */
export interface ArxivTombstone {
  datestamp: string;
  paper_id: string;
}

/**
 * Single OAI `ListRecords` page parse result. Either a successful page with
 * records + optional resumption token, or an empty terminal page.
 */
export interface OaiPage {
  records: ArxivRawRecord[];
  /** Resumption token for the next page, or undefined when the harvest is complete. */
  resumptionToken?: string;
  tombstones: ArxivTombstone[];
}

/**
 * Persistent harvest progress + status. Optional fields accept `undefined`
 * explicitly so runner code can build state objects from partially-populated
 * checkpoints without conditional spreading on every assignment.
 */
export interface HarvestState {
  /** Wall-clock timestamp the last refresh completed (ISO 8601). */
  completed_at?: string | undefined;
  /** Error message if `status='error'`. */
  error_message?: string | undefined;
  /** Last OAI datestamp observed (max across all harvested records). YYYY-MM-DD. */
  last_datestamp?: string | undefined;
  /** Resumption token from the last page; used to resume an interrupted full harvest. */
  resumption_token?: string | undefined;
  /** Wall-clock timestamp the last refresh started (ISO 8601). */
  started_at?: string | undefined;
  /** `pending` (not started), `in_progress`, `complete`, `error`. */
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  /** Total record count, set when `status='complete'`. */
  total_records?: number | undefined;
}

/** Row shape stored in the `papers` table — flattened from `ArxivRawRecord` for FTS5 indexing. */
export interface PaperRow {
  abstract: string;
  authors: string;
  categories: string;
  comment?: string;
  doi?: string;
  id: string;
  journal_ref?: string;
  /** ISO 8601 — derived from latest version date. */
  latest_version: string;
  /** Primary category — first token of `categories`. */
  primary_category: string;
  /** ISO 8601 — derived from version 1 date. */
  published: string;
  title: string;
  /** ISO 8601 — same as latest_version (alias for query convenience). */
  updated: string;
  /** Latest version number as string (e.g. `"3"`). */
  version: string;
}
