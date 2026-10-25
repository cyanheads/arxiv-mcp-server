-- arxiv-mcp-server OAI-PMH mirror schema v5 (issues #18 + #19 + #37 + #78 + #88 + #85)
-- v5's migration repairs the quote references a pre-v5 harvester stored
-- undecoded in the papers text columns (repairQuoteReferences in store.ts),
-- then defines the junction's paper_id index (the v5 block below).
-- Review copy of schema.ts, which the writers' MirrorStore.open executes one
-- statement at a time: the PRAGMAs first, then everything after them in one
-- write transaction (issue #71). The v4 and v5 blocks in the paper_categories
-- section run in that transaction only when it creates the file; on an older
-- file the same statements are the migration (migrateToV4 and migrateToV5 in
-- store.ts), so neither block's DDL runs up front against an older file. The
-- server's query-only connection runs none of it.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- migration_lease — the writer migrating the file (issue #71). One row while a
-- migration runs, none otherwise: claimed in the transaction that finds the
-- file on an older version, checked and renewed by every migration batch, and
-- dropped with the new version. A lease unrenewed for 5 minutes has lapsed.
-- Outside the schema version.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,                           -- random per claim
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,                       -- ISO 8601
  renewed_at TEXT NOT NULL                        -- ISO 8601
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
-- The date indexes on papers are defined in the v4 block below.

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
-- "cs.LG cs.AI stat.ML" yields three rows. The paper's ISO `updated` and, from
-- v4, `published` are denormalized in so a category group can range and order
-- on either date off the junction's indexes. The primary key answers whether a
-- paper carries a code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_categories (
  category TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  updated TEXT NOT NULL,                          -- ISO 8601, mirrors papers.updated
  PRIMARY KEY (category, paper_id)
);

-- ---------------------------------------------------------------------------
-- v4 (issue #78): the junction's `published` column, its fill trigger, and the
-- date-order indexes. A search without a free-text term reads these in order or by
-- range, so no statement reads a papers row it does not return or sorts more
-- than 50,000 index entries. Each index is a drop and a create run in one
-- transaction, so the dropped index's pages are reused.
-- ---------------------------------------------------------------------------
ALTER TABLE paper_categories ADD COLUMN published TEXT NOT NULL DEFAULT '';  -- ISO 8601, mirrors papers.published

-- Fills `published` for a row a writer built for v3 inserts without it (a
-- rollback writing to a v4 file), which would otherwise keep '' and drop out
-- of every group search with a window. A v4 writer always supplies it.
CREATE TRIGGER IF NOT EXISTS paper_categories_published_fill
AFTER INSERT ON paper_categories WHEN NEW.published = '' BEGIN
  UPDATE paper_categories SET published = (SELECT published FROM papers WHERE id = NEW.paper_id)
  WHERE rowid = NEW.rowid;
END;

-- A group's capped count and its page under the cap, with a submission window
-- tested in the index; its page in submission order at the cap, the paper ID
-- breaking ties.
DROP INDEX IF EXISTS paper_categories_cat_published_idx;
CREATE INDEX paper_categories_cat_published_idx
  ON paper_categories(category, published, paper_id);

-- A group's page in update order at the cap, the window tested in the index,
-- and the single-category browse, which pages in updated order straight off
-- the index, the paper ID breaking ties -- no sort, no papers scan (issue #19).
DROP INDEX IF EXISTS paper_categories_cat_updated_idx;
CREATE INDEX paper_categories_cat_updated_idx
  ON paper_categories(category, updated, paper_id, published);

-- A submission window's capped count, and its page under the cap or in
-- submission order.
DROP INDEX IF EXISTS papers_published_idx;
CREATE INDEX papers_published_idx ON papers(published, updated);

-- A submission window's page in update order at the cap.
DROP INDEX IF EXISTS papers_updated_idx;
CREATE INDEX papers_updated_idx ON papers(updated, published);

-- The papers arXiv dates a revision of before their first version (16 in the
-- full mirror, math/0002124 among them). An update order at the cap starts its
-- scan at the earliest such revision a window takes in, else at its opening.
DROP INDEX IF EXISTS papers_revised_early_idx;
CREATE INDEX papers_revised_early_idx ON papers(published, updated) WHERE updated < published;

-- ---------------------------------------------------------------------------
-- v5 (issue #85): the junction's index by paper, a drop and a create run in one
-- transaction. Each record write deletes the paper's junction rows by paper_id,
-- and a tombstone's ON DELETE CASCADE looks them up the same way (issue #50); a
-- search without a free-text term probes each candidate's entries here for a
-- group of several codes, one seek in all, where the primary key would cost one
-- per code. Before v5 the harvest runner built it as (paper_id) outside the
-- schema version; the migration ends a file with that definition, or with none,
-- at this one.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS paper_categories_paper_id_idx;
CREATE INDEX paper_categories_paper_id_idx ON paper_categories(paper_id, category);

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
