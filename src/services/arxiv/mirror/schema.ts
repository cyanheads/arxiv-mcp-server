/**
 * @fileoverview Mirror SQLite schema as TypeScript constants. Inlined (vs.
 * a separate `.sql` file) so it ships in the compiled `dist/` without an
 * extra copy step. The companion `schema.sql` is kept under source control
 * for easier review and external tooling.
 *
 * The SQL constants hold one statement per entry, and the store runs them one
 * at a time (issue #64): `bun:sqlite`'s multi-statement `exec` drops the error
 * of every statement but the last, so a failed step would otherwise pass
 * unseen. Only writers run them — the server's connection never does (issue
 * #55) — and a writer runs the schema inside one write transaction, so a
 * file is created whole or not at all (issue #71).
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
 *
 * v3 changes (issue #37):
 *   - `papers_fts` indexes `comment` and `journal_ref` alongside title,
 *     authors, and abstract, so the documented `co:` and `jr:` field prefixes
 *     resolve on the mirror path the way they already do on the live API.
 *     FTS5 has no `ALTER TABLE`, so the migration drops and rebuilds the index
 *     and its sync triggers — see `migrateToV3` in `store.ts`.
 *
 * v4 changes (issue #78):
 *   - `paper_categories.published`, the paper's submission instant, beside the
 *     `updated` already there, so a category group ranges and orders on either
 *     date inside the junction's indexes without reading `papers`. A trigger
 *     fills it for a row a v3 writer inserts without it.
 *   - `paper_categories(category, published, paper_id)` and the partial
 *     `papers(published, updated) WHERE updated < published` are new, and three
 *     date indexes widen: `paper_categories(category, updated, paper_id, published)`,
 *     `papers(published, updated)`, `papers(updated, published)`. See
 *     {@link MIRROR_V4_STATEMENTS}.
 *
 * v5 changes (issues #88, #85):
 *   - The text columns of `papers` hold `'` and `"` where a pre-v5 harvester
 *     stored OAI's `&#39;` and `&#34;` undecoded; the migration repairs them in
 *     place (`repairQuoteReferences` in `store.ts`).
 *   - `paper_categories(paper_id, category)` joins the schema under the name
 *     the harvest runner gave its `(paper_id)` index, so a term-less search
 *     probes a group of any size with one seek per candidate. See
 *     {@link MIRROR_PAPER_ID_INDEX}.
 *
 * v6 changes (issue #89):
 *   - `title`, `authors`, `abstract`, `comment`, and `journal_ref` hold text
 *     after arXiv's TeX-to-Unicode conversion (`tex2utf.ts`), as the arXiv API
 *     serves it; the migration converts the rows a pre-v6 harvester stored with
 *     TeX in place (`convertTexText` in `store.ts`). No DDL changes.
 * @module services/arxiv/mirror/schema
 */

export const MIRROR_SCHEMA_VERSION = 6;

/**
 * The FTS5 index and its `papers` sync triggers. Split out of the main schema
 * so the v3 migration can drop and recreate them from this single definition
 * rather than a transcribed copy that would drift on the next column change.
 *
 * The triggers enumerate their columns explicitly, so every column added here
 * has to be added to all three of them — a column missing from a trigger leaves
 * the index silently diverging from `papers` on the next write.
 */
export const MIRROR_FTS_STATEMENTS: readonly string[] = [
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
];

/**
 * Drops the FTS index and its triggers so the v3 migration can recreate them
 * from {@link MIRROR_FTS_STATEMENTS}. Triggers go first: a v2 trigger firing
 * against a v3 index would leave the index diverging from `papers`.
 */
export const MIRROR_FTS_DROP_STATEMENTS: readonly string[] = [
  'DROP TRIGGER IF EXISTS papers_ai',
  'DROP TRIGGER IF EXISTS papers_ad',
  'DROP TRIGGER IF EXISTS papers_au',
  'DROP TABLE IF EXISTS papers_fts',
];

/**
 * Connection settings a writer applies before its schema transaction: SQLite
 * refuses a change into WAL inside a transaction and ignores `foreign_keys`
 * there.
 */
export const MIRROR_PRAGMA_STATEMENTS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
];

/**
 * The schema a writer applies on every open, in order, inside one write
 * transaction (issue #71). Each entry is idempotent. It holds the v3 shape v4
 * left as it was; what v4 adds or redefines is {@link MIRROR_V4_STATEMENTS},
 * which a new file runs in the same transaction and an older one runs as its
 * migration. Kept out of this list on purpose: against a v3 file, an index on
 * the junction's `published` fails (no such column) and a redefined index under
 * an existing name is skipped by `IF NOT EXISTS`.
 */
export const MIRROR_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)`,
  // The writer migrating the file (issue #71): one row while a migration runs,
  // none otherwise. A writer claims it in the transaction that finds the file
  // on an older version, renews it with every migration batch, and drops it in
  // the transaction that records the new version. Outside the schema version:
  // a file without the table holds no claim.
  `CREATE TABLE IF NOT EXISTS migration_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS papers (
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
)`,
  'CREATE INDEX IF NOT EXISTS papers_primary_category_idx ON papers(primary_category)',
  ...MIRROR_FTS_STATEMENTS,
  // Junction table: one row per (paper, category) pair, with the paper's ISO
  // updated value (and, from v4, its published value) denormalized in. Enables
  // index-backed category filtering without a full-table scan or LIKE queries
  // on the space-joined categories column. The primary key answers whether a
  // paper carries a code.
  `CREATE TABLE IF NOT EXISTS paper_categories (
  category TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  updated TEXT NOT NULL,
  PRIMARY KEY (category, paper_id)
)`,
  `CREATE TABLE IF NOT EXISTS harvest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  last_datestamp TEXT,
  resumption_token TEXT,
  started_at TEXT,
  completed_at TEXT,
  total_records INTEGER,
  error_message TEXT
)`,
  `INSERT OR IGNORE INTO harvest_state(id, status) VALUES (1, 'pending')`,
];

/**
 * The junction's `published` column (v4, issue #78): the paper's submission
 * instant, as `papers.published` holds it. Added to every file by this one
 * statement, a new file's included, so new and migrated files define it alike.
 */
export const MIRROR_JUNCTION_PUBLISHED_SQL = `ALTER TABLE paper_categories ADD COLUMN published TEXT NOT NULL DEFAULT ''`;

/**
 * Fills the junction's `published` from `papers` for a row inserted without
 * it: the insert of a writer built for v3, should one write to a v4 file after
 * a rollback. Such a row would otherwise keep the column's `''` default and
 * drop out of every group search with a window, unseen by `mirror:verify`. A
 * v4 writer always supplies the value, so its inserts skip the trigger's body.
 */
export const MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS paper_categories_published_fill
AFTER INSERT ON paper_categories WHEN NEW.published = '' BEGIN
  UPDATE paper_categories SET published = (SELECT published FROM papers WHERE id = NEW.paper_id)
  WHERE rowid = NEW.rowid;
END`;

/**
 * The date-order indexes as v4 defines them, each a drop and a create that run
 * in one transaction, so the dropped index's pages are reused (issue #78).
 * Bounded term-less searches read them in order or by range:
 *
 * - `paper_categories(category, published, paper_id)` — a group's capped count
 *   and its page under the cap, with a submission window tested in the index,
 *   and its page in submission order at the cap, the paper ID breaking ties.
 * - `paper_categories(category, updated, paper_id, published)` — a group's page
 *   in update order at the cap and the single-code browse (issue #19), both in
 *   index order with the paper ID breaking ties, the window tested in the index.
 * - `papers(published, updated)` — a window's capped count, and its page under
 *   the cap or in submission order.
 * - `papers(updated, published)` — a window's page in update order at the cap.
 * - `papers(published, updated) WHERE updated < published` — the papers arXiv
 *   dates a revision of before their first version (16 in the full mirror), so
 *   an update order at the cap starts its scan at the earliest such revision a
 *   window takes in rather than at the window's opening.
 */
export const MIRROR_DATE_INDEXES: readonly (readonly [drop: string, create: string])[] = [
  [
    'DROP INDEX IF EXISTS paper_categories_cat_published_idx',
    'CREATE INDEX paper_categories_cat_published_idx ON paper_categories(category, published, paper_id)',
  ],
  [
    'DROP INDEX IF EXISTS paper_categories_cat_updated_idx',
    'CREATE INDEX paper_categories_cat_updated_idx ON paper_categories(category, updated, paper_id, published)',
  ],
  [
    'DROP INDEX IF EXISTS papers_published_idx',
    'CREATE INDEX papers_published_idx ON papers(published, updated)',
  ],
  [
    'DROP INDEX IF EXISTS papers_updated_idx',
    'CREATE INDEX papers_updated_idx ON papers(updated, published)',
  ],
  [
    'DROP INDEX IF EXISTS papers_revised_early_idx',
    'CREATE INDEX papers_revised_early_idx ON papers(published, updated) WHERE updated < published',
  ],
];

/**
 * Everything v4 adds to the v3 shape of {@link MIRROR_SCHEMA_STATEMENTS}, in
 * order. A new file runs it in the transaction that creates it; a v3 file runs
 * the same statements as its migration, one transaction per index and its
 * column backfilled between (`migrateToV4` in `store.ts`), so the two cannot
 * drift.
 */
export const MIRROR_V4_STATEMENTS: readonly string[] = [
  MIRROR_JUNCTION_PUBLISHED_SQL,
  MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL,
  ...MIRROR_DATE_INDEXES.flat(),
];

/**
 * The junction's index by paper, as v5 defines it, a drop and a create that run
 * in one transaction (issue #85). It serves two lookups:
 *
 * - the write path's (issue #50): every record write deletes the paper's
 *   junction rows by `paper_id`, and a tombstone's `ON DELETE CASCADE` looks
 *   them up the same way;
 * - a term-less search's probe into a group of several codes: one seek on the
 *   candidate's `paper_id` reads its few entries, `category` included, and
 *   tests them against the group's list, where the primary key would cost a
 *   seek per code.
 *
 * Before v5 the harvest runner built it as `(paper_id)` outside the schema
 * version, so a harvested v4 file holds that definition and a store-created one
 * none; the v5 migration ends both at this one (`migrateToV5` in `store.ts`).
 * The name stays, and with it every write-path plan; a pre-v5 writer's
 * `CREATE INDEX IF NOT EXISTS` of that name finds it and changes nothing.
 */
export const MIRROR_PAPER_ID_INDEX: readonly [drop: string, create: string] = [
  'DROP INDEX IF EXISTS paper_categories_paper_id_idx',
  'CREATE INDEX paper_categories_paper_id_idx ON paper_categories(paper_id, category)',
];

/**
 * Everything v5 adds to the shape {@link MIRROR_V4_STATEMENTS} leaves, in order:
 * a new file runs it in the transaction that creates it, a v4 file the same
 * statements as its migration's second part, so the two define it alike. Kept
 * out of the up-front list for the reason v4's are: a redefined index under an
 * existing name is skipped by `IF NOT EXISTS`.
 */
export const MIRROR_V5_STATEMENTS: readonly string[] = [...MIRROR_PAPER_ID_INDEX];
