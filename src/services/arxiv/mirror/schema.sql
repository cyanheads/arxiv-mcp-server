-- arxiv-mcp-server OAI-PMH mirror schema v3 (issues #18 + #19 + #37)
-- Created by SqliteAdapter.migrate(); kept under source control for review.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- papers — one row per arXiv paper (latest version's metadata).
-- v2: published/updated/latest_version stored as ISO 8601 (issue #18).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY NOT NULL,                  -- bare arXiv id, e.g. "2401.12345"
  version TEXT NOT NULL,                          -- latest version number (string)
  title TEXT NOT NULL,
  authors TEXT NOT NULL,                          -- comma-joined display names
  abstract TEXT NOT NULL,
  primary_category TEXT NOT NULL,                 -- e.g. "cs.LG"
  categories TEXT NOT NULL,                       -- space-separated codes
  published TEXT NOT NULL,                        -- ISO 8601, version 1 date
  updated TEXT NOT NULL,                          -- ISO 8601, latest version date
  latest_version TEXT NOT NULL,                   -- alias of updated for explicit reads
  comment TEXT,
  journal_ref TEXT,
  doi TEXT
);

CREATE INDEX IF NOT EXISTS papers_primary_category_idx ON papers(primary_category);
CREATE INDEX IF NOT EXISTS papers_published_idx ON papers(published);
CREATE INDEX IF NOT EXISTS papers_updated_idx ON papers(updated);

-- ---------------------------------------------------------------------------
-- papers_fts — full-text index over title, authors, abstract, comment, and
-- journal_ref. The last two arrived in v3 so the documented `co:` and `jr:`
-- prefixes resolve on the mirror as they do on the live API (issue #37).
-- Tokenizer pinned: unicode61 with diacritic stripping and hyphen/underscore
-- preserved (issue #12 decision). No stemming — keeps results aligned with
-- arXiv's literal-match behavior.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title,
  authors,
  abstract,
  comment,
  journal_ref,
  content='papers',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
);

-- Sync triggers so writes to `papers` propagate to the FTS index. Every column
-- of papers_fts must appear in all three, or the index diverges from `papers`
-- on the next write.
CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
  VALUES (new.rowid, new.title, new.authors, new.abstract, new.comment, new.journal_ref);
END;

CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, comment, journal_ref)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.comment, old.journal_ref);
END;

CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, comment, journal_ref)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.comment, old.journal_ref);
  INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
  VALUES (new.rowid, new.title, new.authors, new.abstract, new.comment, new.journal_ref);
END;

-- ---------------------------------------------------------------------------
-- paper_categories — junction table for index-backed category filtering
-- (issue #19). One row per (paper, category) pair; a paper with categories
-- "cs.LG cs.AI stat.ML" yields three rows. The paper's ISO `updated` is
-- denormalized in so a category browse can page in date order off the index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_categories (
  category TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  updated TEXT NOT NULL,                          -- ISO 8601, mirrors papers.updated
  PRIMARY KEY (category, paper_id)
);

-- Composite (category, updated): the leading column drives COUNT(*) and the
-- IN(...) membership lookups; the trailing column lets a single-category
-- browse page in updated order straight off the index -- no sort, no papers
-- scan, fast for common and rare categories alike (issue #19).
CREATE INDEX IF NOT EXISTS paper_categories_cat_updated_idx
  ON paper_categories(category, updated);

-- ---------------------------------------------------------------------------
-- harvest_state — single-row table tracking init/refresh progress.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS harvest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,                           -- pending | in_progress | complete | error
  last_datestamp TEXT,                            -- YYYY-MM-DD
  resumption_token TEXT,
  started_at TEXT,
  completed_at TEXT,
  total_records INTEGER,
  error_message TEXT
);

INSERT OR IGNORE INTO harvest_state(id, status) VALUES (1, 'pending');
