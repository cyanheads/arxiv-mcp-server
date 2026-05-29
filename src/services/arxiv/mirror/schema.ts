/**
 * @fileoverview Mirror SQLite schema as a TypeScript constant. Inlined (vs.
 * a separate `.sql` file) so it ships in the compiled `dist/` without an
 * extra copy step. The companion `schema.sql` is kept under source control
 * for easier review and external tooling.
 *
 * v2 changes (issues #18 + #19):
 *   - `papers.published`, `papers.updated`, `papers.latest_version` are ISO
 *     8601 (e.g. `2018-10-31T14:58:30.000Z`). v1 stored RFC 2822 strings from
 *     the raw OAI version dates, making date-sort lexicographically wrong.
 *   - `paper_categories(category, paper_id, updated)` junction table with a
 *     composite index on `(category, updated)`. The leading column makes
 *     category-only COUNT and membership lookups index-backed; the trailing
 *     `updated` lets a single-category browse page in date order without a
 *     sort or a papers-table scan.
 * @module services/arxiv/mirror/schema
 */

export const MIRROR_SCHEMA_VERSION = 2;

export const MIRROR_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  abstract TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  categories TEXT NOT NULL,
  published TEXT NOT NULL,
  updated TEXT NOT NULL,
  latest_version TEXT NOT NULL,
  comment TEXT,
  journal_ref TEXT,
  doi TEXT
);

CREATE INDEX IF NOT EXISTS papers_primary_category_idx ON papers(primary_category);
CREATE INDEX IF NOT EXISTS papers_published_idx ON papers(published);
CREATE INDEX IF NOT EXISTS papers_updated_idx ON papers(updated);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title,
  authors,
  abstract,
  content='papers',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
);

CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, authors, abstract)
  VALUES (new.rowid, new.title, new.authors, new.abstract);
END;

CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract);
END;

CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract);
  INSERT INTO papers_fts(rowid, title, authors, abstract)
  VALUES (new.rowid, new.title, new.authors, new.abstract);
END;

-- Junction table: one row per (paper, category) pair, with the paper's ISO
-- updated value denormalized in. Enables index-backed category filtering
-- without a full-table scan or LIKE queries on the space-joined categories
-- column.
CREATE TABLE IF NOT EXISTS paper_categories (
  category TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  updated TEXT NOT NULL,
  PRIMARY KEY (category, paper_id)
);

-- Composite (category, updated): the leading column drives COUNT(*) and the
-- IN(...) membership lookups; the trailing column lets a single-category
-- browse page in updated order straight off the index -- no sort, no papers
-- scan, fast for common and rare categories alike (issue #19).
CREATE INDEX IF NOT EXISTS paper_categories_cat_updated_idx
  ON paper_categories(category, updated);

CREATE TABLE IF NOT EXISTS harvest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  last_datestamp TEXT,
  resumption_token TEXT,
  started_at TEXT,
  completed_at TEXT,
  total_records INTEGER,
  error_message TEXT
);

INSERT OR IGNORE INTO harvest_state(id, status) VALUES (1, 'pending');
`;
