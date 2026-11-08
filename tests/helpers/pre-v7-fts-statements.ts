/**
 * @fileoverview The mirror's FTS5 index and its three sync triggers as schema
 * v3 through v6 define them, verbatim: `authors` indexed as stored, with
 * `papers` itself as the external content (issue #100 folds it from v7). A
 * fixture for a file a pre-v7 writer left runs these on the file it builds.
 * @module tests/helpers/pre-v7-fts-statements
 */

/**
 * Replace whatever FTS index a file holds — none, the v7 one, or this one —
 * with the v3–v6 index and triggers, filled from the rows `papers` holds. One
 * statement per entry, each run on its own.
 */
export const PRE_V7_FTS_STATEMENTS: readonly string[] = [
  'DROP TRIGGER IF EXISTS papers_ai',
  'DROP TRIGGER IF EXISTS papers_ad',
  'DROP TRIGGER IF EXISTS papers_au',
  'DROP TABLE IF EXISTS papers_fts',
  'DROP VIEW IF EXISTS papers_fts_source',
  `CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title,
  authors,
  abstract,
  comment,
  journal_ref,
  content='papers',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
)`,
  `CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
  VALUES (new.rowid, new.title, new.authors, new.abstract, new.comment, new.journal_ref);
END`,
  `CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, comment, journal_ref)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.comment, old.journal_ref);
END`,
  `CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, comment, journal_ref)
  VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.comment, old.journal_ref);
  INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
  VALUES (new.rowid, new.title, new.authors, new.abstract, new.comment, new.journal_ref);
END`,
  `INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
  SELECT rowid, title, authors, abstract, comment, journal_ref FROM papers`,
];
