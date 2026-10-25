/**
 * @fileoverview SQLite-backed store for the OAI-PMH mirror.
 * Uses `bun:sqlite` under Bun (no native build) and `better-sqlite3` on Node.
 * Exposes batch upsert, FTS5 search, and harvest-state read/write.
 *
 * Schema v2 (issues #18 + #19):
 *   - `rawToRow` normalizes version dates to ISO 8601.
 *   - `paper_categories` junction table populated in `applyBatch`; enables
 *     index-backed category COUNT and ORDER BY.
 *
 * Schema v3 (issue #37):
 *   - `papers_fts` gains `comment` and `journal_ref`, backing the `co:` and
 *     `jr:` query prefixes.
 *
 * Schema v4 (issue #78):
 *   - `paper_categories.published` and the date-order indexes that bound every
 *     search without a free-text term (see {@link MirrorStore.search}).
 *
 * Schema v5 (issues #88, #85):
 *   - The quote references a pre-v5 harvester stored undecoded are repaired in
 *     the text columns.
 *   - `paper_categories(paper_id, category)` joins the schema, so a term-less
 *     search probes each other group with one seek per candidate.
 *
 * Writers own the file (issue #55). `MirrorStore.open` is the writers' open
 * (`runHarvest`, `mirror:verify`): it creates the file, applies the schema, and
 * runs the in-place migrations an existing DB still needs, in order, before
 * returning the handle. `MirrorStore.openReader` is the server's: its
 * connection is query-only, and a file it cannot serve is reported as not
 * ready rather than created or migrated. Every SQL string runs one statement
 * at a time (issue #64).
 *
 * One writer migrates (issue #71). A writer creates the file and decides
 * whether to migrate it inside one write transaction, re-reading the version
 * under the lock; a migration runs under a lease the writer claims in that
 * transaction and every batch checks and renews. A second writer that opens
 * meanwhile fails with a `conflict` and changes nothing.
 * @module services/arxiv/mirror/store
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { conflict, databaseError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';
import {
  MIRROR_DATE_INDEXES,
  MIRROR_FTS_DROP_STATEMENTS,
  MIRROR_FTS_STATEMENTS,
  MIRROR_JUNCTION_PUBLISHED_SQL,
  MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL,
  MIRROR_PAPER_ID_INDEX,
  MIRROR_PRAGMA_STATEMENTS,
  MIRROR_SCHEMA_STATEMENTS,
  MIRROR_SCHEMA_VERSION,
  MIRROR_V4_STATEMENTS,
  MIRROR_V5_STATEMENTS,
} from './schema.js';
import type { ArxivRawRecord, HarvestState, PaperRow } from './types.js';

/**
 * Most matches a mirror search will count and rank. A free-text term that
 * reaches this many papers is answered by the live API instead — see
 * {@link MirrorStore.matchReachesCap} (issue #49). A search without one stops
 * its count here, a single category code excepted (issue #78).
 */
export const MIRROR_SEARCH_MATCH_CAP = 50_000;

/**
 * Most junction rows a term-less search over two or more category groups
 * counts per group to break a tie between groups that each reach the match cap
 * (issues #78, #85): past every single code of a full-size mirror (`cs.LG`,
 * the largest, holds 295,038), so the fewer rows drive whichever operand comes
 * first. Groups past it all are told apart by their code count.
 */
const DRIVER_ROWS_COUNTED = 6 * MIRROR_SEARCH_MATCH_CAP;

/** A page of matches and their count, as {@link MirrorStore.search} answers. */
export interface MirrorSearchPage {
  papers: PaperRow[];
  /** Exact, or {@link MIRROR_SEARCH_MATCH_CAP} when `totalIsLowerBound`. */
  total: number;
  /** The count stopped at the cap: at least `total` papers match. */
  totalIsLowerBound: boolean;
}

/** What {@link MirrorStore.search} takes. */
interface SearchOptions {
  categoryGroups?: readonly (readonly string[])[];
  limit: number;
  matchExpr?: string;
  offset: number;
  publishedFrom?: string;
  publishedTo?: string;
  sortBy: 'relevance' | 'published' | 'updated';
  sortOrder: 'ascending' | 'descending';
}

/** The `papers` columns a search returns, as `PaperRow` names them. */
const PAPER_COLUMNS = `papers.id, papers.version, papers.title, papers.authors,
  papers.abstract, papers.primary_category, papers.categories,
  papers.published, papers.updated, papers.latest_version,
  papers.comment, papers.journal_ref, papers.doi`;

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/**
 * Whether the paper `paperId` names carries a code from `group`, at one
 * covering seek whatever the group's size, so the group's list is never read
 * (issue #85): a lone code's primary-key entry, else the paper's few entries in
 * `paper_categories_paper_id_idx` (paper_id, category), tested against the
 * group. The `+` keeps the list off the index; without it SQLite expands the
 * `IN` into one primary-key seek per code, 41 for `cat:cs`. A term-less search
 * probes its candidates with it; a term's matches are tested by
 * {@link listsCodeFrom} instead. Binds the group's codes, in order.
 */
function carriesCodeFrom(group: readonly string[], paperId: string): string {
  return group.length === 1
    ? `EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.category = ? AND pc.paper_id = ${paperId})`
    : `EXISTS (SELECT 1 FROM paper_categories pc INDEXED BY paper_categories_paper_id_idx
        WHERE pc.paper_id = ${paperId} AND +pc.category IN (${placeholders(group)}))`;
}

/**
 * Whether the `papers` row lists a code from `group` as a whole token of its
 * space-separated `categories`, the list `applyBatch` writes the paper's
 * junction rows from, so the answer is the junction's. The test reads nothing
 * beyond the row the term path already reads for each match, where a junction
 * probe would add a seek per match, and before v5 one per code (issue #84). A code holding a
 * space is no token and matches nothing, as in the junction; a quoted `cat:`
 * operand can carry one.
 */
function listsCodeFrom(group: readonly string[]): { params: string[]; sql: string } {
  const codes = group.filter((code) => !code.includes(' '));
  const test = "instr(' ' || papers.categories || ' ', ' ' || ? || ' ') > 0";
  return {
    sql: codes.length === 0 ? '0' : `(${codes.map(() => test).join(' OR ')})`,
    params: codes,
  };
}

/** The window's bounds on `column`, as conditions each opening with ` AND `, and their values. */
function windowFilter(
  column: string,
  { publishedFrom, publishedTo }: Pick<SearchOptions, 'publishedFrom' | 'publishedTo'>,
): { params: string[]; sql: string } {
  return {
    sql: `${publishedFrom === undefined ? '' : ` AND ${column} >= ?`}${publishedTo === undefined ? '' : ` AND ${column} <= ?`}`,
    params: [publishedFrom, publishedTo].filter((bound) => bound !== undefined),
  };
}

/** Turns conditions that each open with ` AND ` into a WHERE clause; none stays empty. */
const asWhere = (conditions: string) => conditions.replace(/^ AND /, 'WHERE ');

/** The date a term-less search sorts on and its direction: with no term to rank by, relevance reduces to newest-updated first. */
function dateOrder({ sortBy, sortOrder }: Pick<SearchOptions, 'sortBy' | 'sortOrder'>) {
  return {
    key: sortBy === 'published' ? 'published' : 'updated',
    dir: sortBy !== 'relevance' && sortOrder === 'ascending' ? 'ASC' : 'DESC',
  } as const;
}

/**
 * Where an update-order scan of the window starts, as a condition on `column`
 * opening with ` AND `, and its values; none for a window open below. A paper
 * is revised after it is submitted, so the scan starts at the window's opening —
 * or, for a paper arXiv dates a revision of before its first version
 * (math/0002124: submitted 2000-02-15, revised 1999-11-17; 16 in the full
 * mirror), at the earliest such revision the window takes in, read from the
 * partial index that holds those papers alone (issue #78).
 */
function updateOpening(
  column: string,
  options: Pick<SearchOptions, 'publishedFrom' | 'publishedTo'>,
): { params: string[]; sql: string } {
  const { publishedFrom } = options;
  if (publishedFrom === undefined) return { sql: '', params: [] };
  const window = windowFilter('published', options);
  return {
    sql: ` AND ${column} >= coalesce((SELECT MIN(updated) FROM papers
      INDEXED BY papers_revised_early_idx
      WHERE updated < published${window.sql} AND updated < ?), ?)`,
    params: [...window.params, publishedFrom, publishedFrom],
  };
}

/** An index or trigger the schema defines, as a file holds it ({@link MirrorStore.checkSchemaObjects}). */
export interface SchemaObjectCheck {
  name: string;
  /** The statements that rebuild it as the schema module defines it, in order. */
  restore: readonly string[];
  /** `differs`: the file holds an object of that name under another definition. */
  status: 'ok' | 'missing' | 'differs';
  type: 'index' | 'trigger';
}

/** The name a `CREATE INDEX` or `CREATE TRIGGER` statement gives its object. */
function createdName(create: string): string {
  const name = /^CREATE (?:INDEX|TRIGGER) (?:IF NOT EXISTS )?(\w+)/.exec(create)?.[1];
  if (name === undefined) throw new Error(`Not a CREATE INDEX or TRIGGER statement: ${create}`);
  return name;
}

const FILL_TRIGGER = createdName(MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL);

/**
 * The indexes and the trigger v4 and v5 define, each with the statements that
 * rebuild it: everything a migration redefines, which `IF NOT EXISTS` would
 * never repair.
 */
const SCHEMA_OBJECTS: readonly (Omit<SchemaObjectCheck, 'status'> & { create: string })[] = [
  ...[...MIRROR_DATE_INDEXES, MIRROR_PAPER_ID_INDEX].map(([drop, create]) => ({
    type: 'index' as const,
    name: createdName(create),
    create,
    restore: [drop, create],
  })),
  {
    type: 'trigger',
    name: FILL_TRIGGER,
    create: MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL,
    restore: [`DROP TRIGGER IF EXISTS ${FILL_TRIGGER}`, MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL],
  },
];

/** `sql` with `IF NOT EXISTS` removed, as SQLite stores it, and its whitespace collapsed. */
const comparableSql = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Runtime-agnostic prepared statement. Matches the intersection of
 * `bun:sqlite` and `better-sqlite3` statement APIs.
 */
interface Statement<TRow = unknown> {
  all(...params: unknown[]): TRow[];
  get(...params: unknown[]): TRow | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** The driver calls the store makes — the intersection of `bun:sqlite` and `better-sqlite3`. */
interface Driver {
  close(): void;
  prepare<TRow = unknown>(sql: string): Statement<TRow>;
  /**
   * Run `fn` in a write transaction begun with `BEGIN IMMEDIATE`, committed when
   * it returns and rolled back when it throws. Every transaction here writes,
   * so it takes the write lock up front — waiting out another writer's for the
   * busy timeout — and a read inside it is never overtaken by another commit.
   */
  transaction<T>(fn: () => T): T;
}

interface SqliteHandle extends Driver {
  /**
   * Run each statement on its own, in order, through `prepare().run()`; the
   * first failure throws and the statements after it never run, on both
   * drivers (issue #64). Never a driver `exec`: `bun:sqlite`'s reports only
   * the last statement of a string and runs on past an earlier failure.
   */
  exec(statements: readonly string[]): void;
}

/**
 * How long a writer connection waits out another writer's lock before failing
 * with `SQLITE_BUSY`: better-sqlite3's default, set on both drivers. The
 * server's query-only connection waits for nothing.
 */
const WRITER_BUSY_TIMEOUT_MS = 5_000;

/**
 * How long a migration lease holds without a renewal (issue #71). Its holder
 * renews it as each migration transaction commits, so a running migration's
 * lease ages by at most one transaction: the longest is a v4 index rebuild,
 * 60–85 s for a `papers` date index on a full-size mirror (issue #78), and
 * the TTL stays well clear of it so a lease is never read as
 * lapsed while its holder works. One left older
 * than this belongs to a writer that died or stalled, and the next writer takes
 * the migration over. A stalled holder that resumes finds the lease gone at its
 * next transaction and stops, so the value bounds how long a dead writer blocks
 * the file, never whether two writers can rebuild the index together.
 */
const MIGRATION_LEASE_TTL_MS = 5 * 60_000;

/**
 * Open a connection to `path`. A `writer` creates the file when it is missing;
 * a `reader` requires it to exist and creates nothing.
 */
async function openSqliteHandle(path: string, mode: 'reader' | 'writer'): Promise<SqliteHandle> {
  const driver = runtimeCaps.isBun
    ? await openBunDriver(path, mode)
    : await openBetterSqlite3Driver(path, mode);
  return {
    ...driver,
    exec: (statements) => {
      for (const sql of statements) driver.prepare(sql).run();
    },
  };
}

async function openBunDriver(path: string, mode: 'reader' | 'writer'): Promise<Driver> {
  const { Database } = await import('bun:sqlite');
  const db = new Database(path, { readwrite: true, create: mode === 'writer' });
  return {
    // `close(true)` finalizes the statements still alive with the connection,
    // so the file is released now; `close()` would hold it until each
    // statement is garbage-collected.
    close: () => {
      db.close(true);
    },
    prepare: <TRow>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...(params as never[])) as TRow[],
        // bun:sqlite answers no row with `null`; better-sqlite3 with `undefined`.
        get: (...params: unknown[]) =>
          (stmt.get(...(params as never[])) ?? undefined) as TRow | undefined,
        run: (...params: unknown[]) => {
          const r = stmt.run(...(params as never[]));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
  };
}

async function openBetterSqlite3Driver(path: string, mode: 'reader' | 'writer'): Promise<Driver> {
  const mod = (await import('better-sqlite3')) as unknown as {
    default: new (
      path: string,
      options: { fileMustExist: boolean },
    ) => {
      close: () => unknown;
      prepare: (sql: string) => {
        all: (...p: unknown[]) => unknown[];
        get: (...p: unknown[]) => unknown;
        run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
      };
      transaction: <T>(fn: () => T) => { immediate: () => T };
    };
  };
  const db = new mod.default(path, { fileMustExist: mode === 'reader' });
  return {
    close: () => {
      db.close();
    },
    prepare: <TRow>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...params) as TRow[],
        get: (...params: unknown[]) => stmt.get(...params) as TRow | undefined,
        run: (...params: unknown[]) => stmt.run(...params),
      };
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
  };
}

/**
 * What {@link MirrorStore.openReader} found at a path: an open store, or why the
 * file cannot be served yet. No status but `open` leaves a connection behind.
 *
 * - `missing_file` — nothing at the path.
 * - `missing_schema` — no recorded schema version: not a mirror, or one a
 *   writer has not finished creating.
 * - `migrating` — on an older version, with a writer migrating it now.
 * - `older_schema` — written by an older build, with no writer migrating it; a
 *   writer that opens it migrates it.
 */
export type MirrorReaderOpen =
  | { status: 'open'; store: MirrorStore }
  | { status: 'missing_file' }
  | { status: 'missing_schema' }
  | { status: 'migrating'; version: number }
  | { status: 'older_schema'; version: number };

/**
 * Mirror data store. Wraps a SQLite handle with arXiv-specific reads and writes.
 * Writers open it through {@link openStore}; the server reads through
 * {@link openReaderStore}, whose connection refuses every write.
 */
export class MirrorStore {
  private constructor(private readonly db: SqliteHandle) {}

  /**
   * The writers' open (`runHarvest`, `mirror:verify`): open or create the store
   * at `path`, apply the schema, and run each migration the file still needs
   * (v1→v2, v2→v3, v3→v4, v4→v5) before returning. A failed open closes its
   * connection.
   *
   * One writer migrates a file (issue #71). The schema is applied in one write
   * transaction that also re-reads the version under the lock: a file this
   * writer creates records the current version in that same commit, and a file
   * on an older version is claimed for this writer there, under a migration
   * lease. While another writer holds a live lease the open changes nothing and
   * throws a `conflict` with `reason: 'migration_in_progress'`; a writer whose
   * lease was taken over mid-migration throws one with
   * `reason: 'migration_lease_lost'` (see {@link isMigrationConflict}).
   */
  static async open(path: string): Promise<MirrorStore> {
    await mkdir(dirname(resolvePath(path)), { recursive: true });
    let db: SqliteHandle | undefined;
    try {
      db = await openSqliteHandle(path, 'writer');
      db.exec([`PRAGMA busy_timeout = ${WRITER_BUSY_TIMEOUT_MS}`, ...MIRROR_PRAGMA_STATEMENTS]);
      const claimed = applySchema(db, path);
      if (claimed) migrate(db, path, claimed);
      return new MirrorStore(db);
    } catch (err) {
      db?.close();
      if (isMigrationConflict(err)) throw err;
      throw databaseError(`Failed to open mirror store at ${path}`, { path }, { cause: err });
    }
  }

  /**
   * The server's open: a query-only connection to the store at `path` that
   * never writes — no schema, seed, or migration, `query_only` refusing every
   * write, and no busy timeout, since a WAL reader never waits on the writer.
   * A file at the current schema version (or a later one) opens; any other
   * comes back as its {@link MirrorReaderOpen} status, with its connection
   * closed and nothing created. A failed open closes its connection too. Each
   * call opens a connection of its own, on whichever thread calls it. Only an
   * older file costs a read of the migration lease, to tell `migrating` from
   * `older_schema` (issue #71).
   */
  static async openReader(path: string): Promise<MirrorReaderOpen> {
    if (!existsSync(path)) return { status: 'missing_file' };
    let db: SqliteHandle | undefined;
    let version: number | undefined;
    let lease: MigrationLease | undefined;
    try {
      db = await openSqliteHandle(path, 'reader');
      db.exec(['PRAGMA busy_timeout = 0', 'PRAGMA query_only = ON']);
      version = readSchemaVersion(db);
      if (version !== undefined && version >= MIRROR_SCHEMA_VERSION) {
        return { status: 'open', store: new MirrorStore(db) };
      }
      if (version !== undefined) lease = readLease(db);
    } catch (err) {
      db?.close();
      throw databaseError(`Failed to open mirror store at ${path}`, { path }, { cause: err });
    }
    db.close();
    if (version === undefined) return { status: 'missing_schema' };
    return lease && leaseIsLive(lease)
      ? { status: 'migrating', version }
      : { status: 'older_schema', version };
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Harvest state
  // -------------------------------------------------------------------------

  readHarvestState(): HarvestState {
    const row = this.db
      .prepare<{
        status: string;
        last_datestamp: string | null;
        resumption_token: string | null;
        started_at: string | null;
        completed_at: string | null;
        total_records: number | null;
        error_message: string | null;
      }>(
        `SELECT status, last_datestamp, resumption_token, started_at,
                completed_at, total_records, error_message
         FROM harvest_state WHERE id = 1`,
      )
      .get();
    if (!row) return { status: 'pending' };
    return {
      status: row.status as HarvestState['status'],
      ...(row.last_datestamp != null && { last_datestamp: row.last_datestamp }),
      ...(row.resumption_token != null && { resumption_token: row.resumption_token }),
      ...(row.started_at != null && { started_at: row.started_at }),
      ...(row.completed_at != null && { completed_at: row.completed_at }),
      ...(row.total_records != null && { total_records: row.total_records }),
      ...(row.error_message != null && { error_message: row.error_message }),
    };
  }

  /**
   * Persist harvest state. `completed_at` and `total_records` are durable
   * "last successful harvest" markers — preserved via COALESCE when a write
   * omits them, so an in-progress or failed refresh on top of a complete mirror
   * keeps the completion marker that readiness keys off. Only the success path
   * supplies (and thus advances) them. Every other column is current-harvest
   * progress, overwritten on each write. See issue #21.
   */
  writeHarvestState(state: HarvestState): void {
    this.db
      .prepare(
        `UPDATE harvest_state
         SET status = ?, last_datestamp = ?, resumption_token = ?, started_at = ?,
             completed_at = COALESCE(?, completed_at),
             total_records = COALESCE(?, total_records),
             error_message = ?
         WHERE id = 1`,
      )
      .run(
        state.status,
        state.last_datestamp ?? null,
        state.resumption_token ?? null,
        state.started_at ?? null,
        state.completed_at ?? null,
        state.total_records ?? null,
        state.error_message ?? null,
      );
  }

  // -------------------------------------------------------------------------
  // Paper writes
  // -------------------------------------------------------------------------

  /**
   * Batch upsert records inside a single transaction. Tombstones are deleted
   * by paper ID; live records replace existing rows (FTS triggers handle sync).
   * Also maintains the `paper_categories` junction table.
   */
  applyBatch(records: ArxivRawRecord[], tombstones: { paper_id: string }[]): void {
    if (records.length === 0 && tombstones.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO papers(id, version, title, authors, abstract,
                          primary_category, categories, published, updated,
                          latest_version, comment, journal_ref, doi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         title = excluded.title,
         authors = excluded.authors,
         abstract = excluded.abstract,
         primary_category = excluded.primary_category,
         categories = excluded.categories,
         published = excluded.published,
         updated = excluded.updated,
         latest_version = excluded.latest_version,
         comment = excluded.comment,
         journal_ref = excluded.journal_ref,
         doi = excluded.doi`,
    );
    const catDelete = this.db.prepare(`DELETE FROM paper_categories WHERE paper_id = ?`);
    const catInsert = this.db.prepare(
      `INSERT OR IGNORE INTO paper_categories(category, paper_id, updated, published)
       VALUES (?, ?, ?, ?)`,
    );
    const remove = this.db.prepare(`DELETE FROM papers WHERE id = ?`);
    this.db.transaction(() => {
      for (const r of records) {
        const row = rawToRow(r);
        upsert.run(
          row.id,
          row.version,
          row.title,
          row.authors,
          row.abstract,
          row.primary_category,
          row.categories,
          row.published,
          row.updated,
          row.latest_version,
          row.comment ?? null,
          row.journal_ref ?? null,
          row.doi ?? null,
        );
        // Rebuild junction rows for this paper (idempotent via DELETE + INSERT OR
        // IGNORE). Both dates are denormalized in so a category search ranges and
        // pages in date order off the junction's indexes.
        catDelete.run(row.id);
        for (const cat of row.categories.split(' ').filter(Boolean)) {
          catInsert.run(cat, row.id, row.updated, row.published);
        }
      }
      for (const t of tombstones) remove.run(t.paper_id);
    });
  }

  /** Total paper count — used as the source of truth for `total_records`. */
  countPapers(): number {
    const row = this.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers`).get();
    return row?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Paper reads
  // -------------------------------------------------------------------------

  /** Fetch papers by ID list, preserving input order. Missing IDs are skipped. */
  getPapersByIds(ids: string[]): PaperRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare<PaperRow>(
        `SELECT id, version, title, authors, abstract, primary_category,
                categories, published, updated, latest_version, comment,
                journal_ref, doi
         FROM papers WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is PaperRow => r !== undefined);
  }

  /**
   * Bounded probe: whether `matchExpr` matches at least
   * {@link MIRROR_SEARCH_MATCH_CAP} papers. Stops at that many matches and never
   * touches `papers`. Category and date filters play no part — the cost a
   * search incurs is set by the FTS match set they would narrow. A malformed
   * expression raises the same `fts5:` error {@link MirrorStore.search} would.
   */
  matchReachesCap(matchExpr: string): boolean {
    const row = this.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM papers_fts WHERE papers_fts MATCH ? LIMIT ?)`,
      )
      .get(matchExpr, MIRROR_SEARCH_MATCH_CAP);
    return (row?.n ?? 0) >= MIRROR_SEARCH_MATCH_CAP;
  }

  /**
   * Execute a mirror search: one page of matches and their count. Callers
   * still wrap this in a SQLite-error catch for defense in depth — see
   * `ArxivService.searchMirror`.
   *
   * With a `matchExpr` — FTS5 syntax from the translator (`query.ts`), which
   * parenthesizes every compound operand and joins adjacent operands with `OR`,
   * so neither FTS5's own precedence nor its implicit `AND` decides a grouping
   * (issues #65, #82) — both the count and the page are driven from the FTS
   * index, so their cost follows the match set rather than the corpus; callers
   * bound that set first with {@link MirrorStore.matchReachesCap} (issue #49).
   * A category group is tested per match against the match's own `categories`,
   * never read from the junction (issue #84). The count is exact. Relevance
   * order is BM25 (best first; `sortOrder` does not apply), with rowid breaking
   * ties so pages never overlap.
   *
   * Without one, no statement reads a `papers` row it does not return or sorts
   * more than {@link MIRROR_SEARCH_MATCH_CAP} index entries (issue #78). A
   * single category code, with or without a window, counts exactly; any other
   * search counts up to the cap, and one that reaches it reports
   * `totalIsLowerBound`. Under the cap, the page sorts the entries the count
   * read; at it, the page reads an index in sort order and stops after
   * `offset + limit` matches. Relevance reduces to newest-updated first. Ties
   * break on the paper ID when a category group filters and on the rowid
   * otherwise, so consecutive pages never overlap or skip.
   *
   * `categoryGroups` holds expanded category codes (subtree expansion handled
   * upstream), matched via the `paper_categories` junction table when there is
   * no `matchExpr` (index-backed — issues #19, #78) and against each match's
   * `categories` when there is (issue #84). Codes within a group are OR-ed; groups are AND-ed, which is
   * how the live API composes a `cat:` operand in the query text with the
   * `category` parameter's own operand — a paper must carry a code from every
   * group. One group per independent filter the caller supplied.
   *
   * `publishedFrom` / `publishedTo` bound the paper's `published` instant
   * inclusively. They are ISO 8601 instants in the normalized form `rawToRow`
   * writes, so lexicographic comparison is chronological. Each bound names one
   * exact instant, not a minute or a day: the upper bound for
   * `submitted_to: 2021-03-10` is `2021-03-11T00:00:00.000Z`, the following
   * midnight, so a record at `23:59:30Z` stays inside the window and one
   * submitted exactly on the seam falls in both neighbours. See `date-window.ts`.
   */
  search(options: SearchOptions): MirrorSearchPage {
    const groups = (options.categoryGroups ?? []).filter((g) => g.length > 0);
    if (!options.matchExpr) {
      return groups.length > 0 ? this.searchGroups(groups, options) : this.searchWindow(options);
    }
    const dir = options.sortOrder === 'ascending' ? 'ASC' : 'DESC';

    // -------------------------------------------------------------------------
    // Build the filters on `papers` columns.
    // -------------------------------------------------------------------------
    const papersParams: unknown[] = [];
    const papersWhere: string[] = [];

    // One test per group, AND-ed by the surrounding WHERE — a paper matches when
    // it lists at least one code from each group (issue #84).
    for (const group of groups) {
      const listed = listsCodeFrom(group);
      papersWhere.push(listed.sql);
      papersParams.push(...listed.params);
    }

    if (options.publishedFrom !== undefined) {
      papersWhere.push(`papers.published >= ?`);
      papersParams.push(options.publishedFrom);
    }
    if (options.publishedTo !== undefined) {
      papersWhere.push(`papers.published <= ?`);
      papersParams.push(options.publishedTo);
    }

    // -------------------------------------------------------------------------
    // Count and page both enumerate the match set from the FTS index (issue
    // #49). CROSS JOIN pins `papers_fts` as the outer loop, so each match costs
    // one rowid lookup into `papers` and the filters run per match. `rank` /
    // `bm25()` score only on the cursor the MATCH constrains.
    // -------------------------------------------------------------------------
    const from = `FROM papers_fts CROSS JOIN papers ON papers.rowid = papers_fts.rowid`;
    const where = `WHERE ${['papers_fts MATCH ?', ...papersWhere].join(' AND ')}`;
    const params = [options.matchExpr, ...papersParams];
    const orderBy =
      options.sortBy === 'published'
        ? `papers.published ${dir}`
        : options.sortBy === 'updated'
          ? `papers.updated ${dir}`
          : 'papers_fts.rank';
    // Every page query sorts rowids only; columns are read for the page it keeps.
    const pageOrder = `ORDER BY ${orderBy}, papers.rowid LIMIT ? OFFSET ?`;

    if (papersWhere.length === 0) {
      // Nothing to filter: the index alone gives the count and the BM25 order
      // — every indexed rowid is a `papers` row, kept so by the sync triggers —
      // so neither reads a `papers` row per match.
      const totalRow = this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers_fts WHERE papers_fts MATCH ?`)
        .get(options.matchExpr);
      const pageSql =
        options.sortBy === 'relevance'
          ? `SELECT rowid AS rid FROM papers_fts WHERE papers_fts MATCH ?
             ORDER BY rank, rowid LIMIT ? OFFSET ?`
          : `SELECT papers.rowid AS rid ${from} ${where} ${pageOrder}`;
      const rowids = this.db
        .prepare<{ rid: number }>(pageSql)
        .all(...params, options.limit, options.offset)
        .map((r) => r.rid);
      return {
        papers: this.getPapersByRowids(rowids),
        total: totalRow?.n ?? 0,
        totalIsLowerBound: false,
      };
    }

    // A filter reads each match's `papers` row, so count and page share that
    // one pass: the window counts every surviving row before LIMIT cuts the page.
    const page = this.db
      .prepare<{ n: number; rid: number }>(
        `SELECT papers.rowid AS rid, COUNT(*) OVER () AS n ${from} ${where} ${pageOrder}`,
      )
      .all(...params, options.limit, options.offset);
    // An offset past the end leaves no row to carry the count; count alone.
    const total =
      page[0]?.n ??
      (options.offset === 0
        ? 0
        : (this.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params)
            ?.n ?? 0));
    return {
      papers: this.getPapersByRowids(page.map((r) => r.rid)),
      total,
      totalIsLowerBound: false,
    };
  }

  /**
   * A term-less search filtered by category groups (issue #78). Every statement
   * reads `paper_categories` indexes only, `papers` rows for the page alone.
   * The group with the fewest junction rows drives; each other group is tested
   * per candidate with one covering seek ({@link carriesCodeFrom}, issue #85).
   */
  private searchGroups(
    groups: readonly (readonly string[])[],
    options: SearchOptions,
  ): MirrorSearchPage {
    const { limit, offset } = options;
    const { key, dir } = dateOrder(options);
    const window = windowFilter('d.published', options);
    // A single category code: the one search whose count stays exact.
    const sole = groups.length === 1 && groups[0]?.length === 1 ? groups[0]?.[0] : undefined;

    // One code in update order, no window (issue #19): count it and page it
    // straight off (category, updated, paper_id, …), ties already in ID order,
    // with no sort and no `papers` scan.
    if (sole !== undefined && window.params.length === 0 && key === 'updated') {
      const total =
        this.db
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM paper_categories WHERE category = ?`)
          .get(sole)?.n ?? 0;
      const papers = this.db
        .prepare<PaperRow>(
          `SELECT ${PAPER_COLUMNS}
           FROM paper_categories
           JOIN papers ON papers.id = paper_categories.paper_id
           WHERE paper_categories.category = ?
           ORDER BY paper_categories.updated ${dir}, paper_categories.paper_id ${dir}
           LIMIT ? OFFSET ?`,
        )
        .all(sole, limit, offset);
      return { papers, total, totalIsLowerBound: false };
    }

    const ordered = groups.length > 1 ? this.fewestJunctionRowsFirst(groups, window) : groups;
    if (ordered === undefined) return { papers: [], total: 0, totalIsLowerBound: false };
    const [driver = [], ...others] = ordered;
    const probes = others.map((group) => ` AND ${carriesCodeFrom(group, 'd.paper_id')}`).join('');
    const filterParams = [...window.params, ...others.flat()];
    const filter = `${window.sql}${probes}`;
    // A paper has one junction row per code, so only a driver of several codes repeats one.
    const distinct = driver.length > 1 ? 'DISTINCT ' : '';

    // One code counts exactly; anything else stops at the cap.
    const counted =
      sole !== undefined
        ? `SELECT 1 FROM paper_categories d INDEXED BY paper_categories_cat_published_idx
           WHERE d.category = ?${filter}`
        : `SELECT ${distinct}d.paper_id FROM paper_categories d
           INDEXED BY paper_categories_cat_published_idx
           WHERE d.category IN (${placeholders(driver)})${filter} LIMIT ${MIRROR_SEARCH_MATCH_CAP}`;
    const total =
      this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM (${counted})`)
        .get(...driver, ...filterParams)?.n ?? 0;

    let pageSql: string;
    let pageParams: unknown[];
    if (total < MIRROR_SEARCH_MATCH_CAP) {
      // Sort the entries the count read: fewer than the cap. With no window to
      // range on, an update order reads them from the index that holds
      // `updated`, so no entry costs a read of its junction row (issue #85).
      const index =
        key === 'updated' && window.params.length === 0
          ? 'paper_categories_cat_updated_idx'
          : 'paper_categories_cat_published_idx';
      pageSql = `SELECT ${distinct}d.${key} AS k, d.paper_id FROM paper_categories d
                 INDEXED BY ${index}
                 WHERE d.category IN (${placeholders(driver)})${filter}
                 ORDER BY 1 ${dir}, 2 ${dir} LIMIT ? OFFSET ?`;
      pageParams = [...driver, ...filterParams, limit, offset];
    } else {
      // Read in sort order, one arm per code, and stop at `offset + limit`
      // matches; an update order starts its scan where the window's papers can
      // first have been revised.
      const index =
        key === 'updated'
          ? 'paper_categories_cat_updated_idx'
          : 'paper_categories_cat_published_idx';
      const opening =
        key === 'updated' ? updateOpening('d.updated', options) : { sql: '', params: [] };
      const arm = `SELECT d.${key} AS k, d.paper_id FROM paper_categories d INDEXED BY ${index}
                   WHERE d.category = ?${opening.sql}${filter}`;
      pageSql = `${driver.map(() => arm).join(' UNION ')} ORDER BY 1 ${dir}, 2 ${dir} LIMIT ? OFFSET ?`;
      pageParams = [
        ...driver.flatMap((code) => [code, ...opening.params, ...filterParams]),
        limit,
        offset,
      ];
    }
    const ids = this.db
      .prepare<{ paper_id: string }>(pageSql)
      .all(...pageParams)
      .map((r) => r.paper_id);
    return {
      papers: this.getPapersByIds(ids),
      total,
      totalIsLowerBound: sole === undefined && total >= MIRROR_SEARCH_MATCH_CAP,
    };
  }

  /**
   * A term-less search with no category group: a submission window, or nothing
   * (issue #78). Its count and page read the `papers` date indexes only, its
   * rows for the page alone.
   */
  private searchWindow(options: SearchOptions): MirrorSearchPage {
    const { limit, offset } = options;
    const { key, dir } = dateOrder(options);
    const window = windowFilter('published', options);
    const where = asWhere(window.sql);

    const total =
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM papers INDEXED BY papers_published_idx
           ${where} LIMIT ${MIRROR_SEARCH_MATCH_CAP})`,
        )
        .get(...window.params)?.n ?? 0;

    // Under the cap, sort the entries the count read; at it, read in sort order
    // and stop at `offset + limit`. Submission order is the counted index's own;
    // an update order starts its scan where the window's papers can first have
    // been revised.
    const opening = updateOpening('updated', options);
    const page =
      key === 'published' || total < MIRROR_SEARCH_MATCH_CAP
        ? {
            sql: `SELECT rowid AS rid FROM papers INDEXED BY papers_published_idx ${where}`,
            params: window.params,
          }
        : {
            sql: `SELECT rowid AS rid FROM papers INDEXED BY papers_updated_idx
                  ${asWhere(`${opening.sql}${window.sql}`)}`,
            params: [...opening.params, ...window.params],
          };
    const rowids = this.db
      .prepare<{ rid: number }>(`${page.sql} ORDER BY ${key} ${dir}, rowid ${dir} LIMIT ? OFFSET ?`)
      .all(...page.params, limit, offset)
      .map((r) => r.rid);
    return {
      papers: this.getPapersByRowids(rowids),
      total,
      totalIsLowerBound: total >= MIRROR_SEARCH_MATCH_CAP,
    };
  }

  /**
   * `groups` reordered so the one holding the fewest junction rows in the
   * window comes first, the rest keeping their order, or `undefined` when a
   * group holds none, so no paper matches (issue #85). Each group is tested
   * for a row before any is counted, so an empty one ends the search there.
   *
   * Every other group costs one seek per candidate ({@link carriesCodeFrom}),
   * so the driver's row count alone sets the probes, whatever any group's code
   * count. Fewest codes first, each group is counted up to the cap or the
   * fewest rows found so far, whichever is lower, and one that comes in under
   * them drives; no count reads past the cap. When every group reaches it,
   * each is counted on, up to the fewest found so far and at most
   * {@link DRIVER_ROWS_COUNTED}, and the fewest drive again, ties going to the
   * fewer codes: beside `cat:cs`, `stat`'s 186,680 rows drive rather than
   * `cs`'s 1.58 million, and `cs.AI` drives beside `cs.LG` in either order.
   */
  private fewestJunctionRowsFirst(
    groups: readonly (readonly string[])[],
    window: { params: string[]; sql: string },
  ): (readonly string[])[] | undefined {
    const rowsIn = (group: readonly string[]) =>
      `FROM paper_categories d INDEXED BY paper_categories_cat_published_idx
       WHERE d.category IN (${placeholders(group)})${window.sql}`;
    const holdsRow = (group: readonly string[]) =>
      this.db
        .prepare<{ found: number }>(`SELECT EXISTS (SELECT 1 ${rowsIn(group)}) AS found`)
        .get(...group, ...window.params)?.found === 1;
    if (!groups.every(holdsRow)) return;
    const rows = (group: readonly string[], limit: number) =>
      this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 ${rowsIn(group)} LIMIT ?)`)
        .get(...group, ...window.params, limit)?.n ?? 0;

    // A stable sort: groups with as many codes keep their order.
    const visit = [...groups.keys()].sort(
      (a, b) => (groups[a]?.length ?? 0) - (groups[b]?.length ?? 0),
    );
    let first = visit[0] ?? 0;
    let fewest = MIRROR_SEARCH_MATCH_CAP;
    for (const i of visit) {
      const n = rows(groups[i] ?? [], fewest);
      if (n < fewest) {
        fewest = n;
        first = i;
      }
    }
    if (fewest === MIRROR_SEARCH_MATCH_CAP) {
      let deepest = DRIVER_ROWS_COUNTED;
      for (const i of visit) {
        const n = rows(groups[i] ?? [], deepest);
        if (n < deepest) {
          deepest = n;
          first = i;
        }
      }
    }
    return [groups[first] ?? [], ...groups.filter((_, i) => i !== first)];
  }

  /** Read a page of papers by rowid, in the order given. */
  private getPapersByRowids(rowids: number[]): PaperRow[] {
    if (rowids.length === 0) return [];
    const rows = this.db
      .prepare<PaperRow & { rid: number }>(
        `SELECT papers.rowid AS rid, ${PAPER_COLUMNS} FROM papers
         WHERE papers.rowid IN (${rowids.map(() => '?').join(',')})`,
      )
      .all(...rowids);
    const byRowid = new Map(rows.map(({ rid, ...row }) => [rid, row]));
    return rowids.map((rid) => byRowid.get(rid)).filter((r): r is PaperRow => r !== undefined);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Schema version this database carries, and the version the running code
   * expects. They diverge only mid-upgrade — {@link MirrorStore.open} migrates
   * before returning, and {@link MirrorStore.openReader} opens nothing older —
   * so a mismatch reported here means a migration failed.
   */
  schemaVersion(): { current: number; expected: number } {
    return { current: readSchemaVersion(this.db) ?? 0, expected: MIRROR_SCHEMA_VERSION };
  }

  /**
   * Each index and trigger v4 and v5 define, as this file holds it against the
   * schema module's definition. A file can record its version and still lack
   * one an operator or another build dropped or redefined — a search naming a
   * missing index fails with a driver error and goes live — and no open
   * recreates it: the module runs these definitions only when it creates a file
   * and as the migration that introduced each. Text is compared with
   * `IF NOT EXISTS`, which SQLite does not store, removed and whitespace
   * collapsed.
   */
  checkSchemaObjects(): SchemaObjectCheck[] {
    const stored = this.db.prepare<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`,
    );
    return SCHEMA_OBJECTS.map(({ type, name, create, restore }) => {
      const sql = stored.get(type, name)?.sql;
      const status =
        sql == null ? 'missing' : comparableSql(sql) === comparableSql(create) ? 'ok' : 'differs';
      return { type, name, status, restore };
    });
  }

  integrityCheck(): { ok: boolean; results: string[] } {
    const integrity = this.db.prepare<{ integrity_check: string }>(`PRAGMA integrity_check`).all();
    const quick = this.db.prepare<{ quick_check: string }>(`PRAGMA quick_check`).all();
    const results = [
      ...integrity.map((r) => `integrity_check: ${r.integrity_check}`),
      ...quick.map((r) => `quick_check: ${r.quick_check}`),
    ];
    const ok = results.every((r) => r.endsWith('ok'));
    return { ok, results };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw date string to ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * Accepts RFC 2822 (`Wed, 31 Oct 2018 14:58:30 GMT`), ISO 8601 (already
 * correct — re-parsing is a fixed point), and the OAI YYYY-MM-DD datestamp.
 * Returns the original string on parse failure so a bad date surfaces as a
 * visible corrupt value rather than silently as `Invalid Date`.
 */
export function normalizeDateToIso(raw: string): string {
  if (!raw) return raw;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  return new Date(ms).toISOString();
}

/** Convert an OAI `arXivRaw` record to a flattened `papers`-table row. */
export function rawToRow(r: ArxivRawRecord): PaperRow {
  const categoryTokens = r.categories.split(/\s+/).filter(Boolean);
  const primary = categoryTokens[0] ?? '';
  const versions = [...r.versions].sort(
    (a, b) => parseInt(a.version.replace(/^v/, ''), 10) - parseInt(b.version.replace(/^v/, ''), 10),
  );
  const first = versions[0];
  const last = versions[versions.length - 1];
  // Normalize to ISO 8601. OAI version dates are RFC 2822 (e.g. "Wed, 31 Oct
  // 2018 14:58:30 GMT"); the datestamp fallback is YYYY-MM-DD — both parse
  // correctly via Date.parse. Without normalization, `ORDER BY published` is
  // lexicographic over the weekday prefix, not chronological. See issue #18.
  const published = normalizeDateToIso(first?.date ?? r.datestamp);
  const updated = normalizeDateToIso(last?.date ?? r.datestamp);
  const versionLabel = (last?.version ?? 'v1').replace(/^v/, '');

  return {
    id: r.paper_id,
    version: versionLabel,
    title: r.title.replace(/\s+/g, ' ').trim(),
    authors: r.authors.replace(/\s+/g, ' ').trim(),
    abstract: r.abstract.replace(/\s+/g, ' ').trim(),
    primary_category: primary,
    categories: categoryTokens.join(' '),
    published,
    updated,
    latest_version: updated,
    ...(r.comments && { comment: r.comments.replace(/\s+/g, ' ').trim() }),
    ...(r.journal_ref && { journal_ref: r.journal_ref.replace(/\s+/g, ' ').trim() }),
    ...(r.doi && { doi: r.doi.trim() }),
  };
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

function hasTable(db: SqliteHandle, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

/**
 * The schema version the file records, or `undefined` when it records none: no
 * `schema_version` table, or no row in it yet (a writer records the version in
 * the transaction that creates the schema, or once every migration is in place).
 */
function readSchemaVersion(db: SqliteHandle): number | undefined {
  if (!hasTable(db, 'schema_version')) return;
  return db
    .prepare<{ version: number }>(
      `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`,
    )
    .get()?.version;
}

/** Record the schema version reached. Called only after a migration completes. */
function writeSchemaVersion(db: SqliteHandle, version: number): void {
  db.prepare(`DELETE FROM schema_version`).run();
  db.prepare(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`).run(
    version,
    new Date().toISOString(),
  );
}

// ---------------------------------------------------------------------------
// Migration lease (issue #71)
// ---------------------------------------------------------------------------

/** The `migration_lease` row: which writer is migrating the file, and since when. */
interface MigrationLease {
  /** Random per claim, so a writer recognizes its own lease. */
  holder: string;
  pid: number;
  /** ISO 8601. */
  renewed_at: string;
  /** ISO 8601. */
  started_at: string;
}

/** A migration this writer claimed: the version it starts from and the lease it holds. */
interface ClaimedMigration {
  from: number;
  lease: MigrationLease;
}

/** Runs a function in one write transaction. */
type InTransaction = <T>(fn: () => T) => T;

/**
 * Whether `err` is the `conflict` a writer open throws when another writer owns
 * the file's migration: it holds a live lease (`migration_in_progress`, nothing
 * changed), or it took the lease over from this writer mid-migration
 * (`migration_lease_lost`). Either way that writer finishes the migration, and
 * running again once it has is the remedy.
 */
export function isMigrationConflict(err: unknown): err is McpError {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.Conflict) return false;
  const reason = (err.data as { reason?: unknown } | undefined)?.reason;
  return reason === 'migration_in_progress' || reason === 'migration_lease_lost';
}

/**
 * Whether `err` is an error the SQLite driver raised — `bun:sqlite`'s
 * `SQLiteError` or better-sqlite3's `SqliteError`, `fts5:` parse errors
 * included — rather than one this code threw. Keyed on the driver's error
 * class name, which survives the reader worker's wire, never on the message:
 * SQLite's wording is not this server's to depend on (issue #76).
 */
export function isDriverError(err: unknown): err is Error {
  return err instanceof Error && (err.name === 'SQLiteError' || err.name === 'SqliteError');
}

/** The lease the file records, or `undefined` for none (or a file without the table). */
function readLease(db: SqliteHandle): MigrationLease | undefined {
  if (!hasTable(db, 'migration_lease')) return;
  return db
    .prepare<MigrationLease>(
      `SELECT holder, pid, started_at, renewed_at FROM migration_lease WHERE id = 1`,
    )
    .get();
}

function leaseLapsesAt(lease: MigrationLease): number {
  return Date.parse(lease.renewed_at) + MIGRATION_LEASE_TTL_MS;
}

/** A lease renewed within the TTL. One whose timestamp does not parse has lapsed. */
function leaseIsLive(lease: MigrationLease): boolean {
  return Date.now() < leaseLapsesAt(lease);
}

function migrationInProgress(path: string, held: MigrationLease, from: number): McpError {
  const lapsesAt = new Date(leaseLapsesAt(held)).toISOString();
  return conflict(
    `Mirror file ${path} is being migrated from schema v${from} to v${MIRROR_SCHEMA_VERSION} by another writer (pid ${held.pid}, started ${held.started_at}); this run changed nothing. Run it again once that migration finishes. If pid ${held.pid} is no longer running, its claim lapses at ${lapsesAt}.`,
    {
      reason: 'migration_in_progress',
      path,
      schemaVersion: from,
      holderPid: held.pid,
      startedAt: held.started_at,
      renewedAt: held.renewed_at,
      lapsesAt,
    },
  );
}

function leaseLost(path: string, held: MigrationLease | undefined): McpError {
  return conflict(
    `Another writer took over the schema migration of mirror file ${path}${held ? ` (pid ${held.pid})` : ''} after this one went ${MIGRATION_LEASE_TTL_MS / 60_000} min without committing; this writer stopped before its next batch. Run it again once that migration finishes.`,
    { reason: 'migration_lease_lost', path, ...(held && { holderPid: held.pid }) },
  );
}

/**
 * Apply the schema in one write transaction and decide, under that lock, what
 * this open still owes the file. A file without a `papers` table is new and
 * records the current version in the same commit, so no reader or writer ever
 * sees it at an older one. A file on an older version is claimed for this
 * writer, unless another writer holds a live lease on it.
 *
 * Another writer's transaction can outlast the busy wait — a migration batch,
 * or the drop of the old index. The open then reads the lease without the
 * lock (WAL serves the last commit) and reports a live one as the migration it
 * is; any other `SQLITE_BUSY` is rethrown.
 *
 * @returns The migration this writer now owns, or `undefined` for a current file.
 */
function applySchema(db: SqliteHandle, path: string): ClaimedMigration | undefined {
  try {
    return db.transaction(() => {
      const created = !hasTable(db, 'papers');
      db.exec(MIRROR_SCHEMA_STATEMENTS);
      if (created) {
        db.exec(MIRROR_V4_STATEMENTS);
        db.exec(MIRROR_V5_STATEMENTS);
        writeSchemaVersion(db, MIRROR_SCHEMA_VERSION);
      }
      const from = readSchemaVersion(db) ?? 0;
      if (from >= MIRROR_SCHEMA_VERSION) return;
      const held = readLease(db);
      if (held && leaseIsLive(held)) throw migrationInProgress(path, held, from);
      const now = new Date().toISOString();
      const lease: MigrationLease = {
        holder: randomUUID(),
        pid: process.pid,
        started_at: now,
        renewed_at: now,
      };
      db.prepare(
        `INSERT OR REPLACE INTO migration_lease(id, holder, pid, started_at, renewed_at)
         VALUES (1, ?, ?, ?, ?)`,
      ).run(lease.holder, lease.pid, lease.started_at, lease.renewed_at);
      return { from, lease };
    });
  } catch (err) {
    if (String((err as { code?: unknown }).code).startsWith('SQLITE_BUSY')) {
      const held = readLease(db);
      if (held && leaseIsLive(held)) {
        throw migrationInProgress(path, held, readSchemaVersion(db) ?? 0);
      }
    }
    throw err;
  }
}

/**
 * Run the migrations a claimed file needs, each batch in a transaction that
 * first checks the lease still names this writer and renews it as it commits.
 * The transaction that records the final version drops the lease. A writer
 * whose lease was taken over stops before writing again; one that fails for
 * any other reason drops its lease so the next writer need not wait it out.
 */
function migrate(db: SqliteHandle, path: string, { from, lease }: ClaimedMigration): void {
  const assertHeld = () => {
    const held = readLease(db);
    if (held?.holder !== lease.holder) throw leaseLost(path, held);
  };
  const fenced: InTransaction = (fn) =>
    db.transaction(() => {
      assertHeld();
      const result = fn();
      db.prepare(`UPDATE migration_lease SET renewed_at = ? WHERE id = 1 AND holder = ?`).run(
        new Date().toISOString(),
        lease.holder,
      );
      return result;
    });
  const release = () =>
    db.prepare(`DELETE FROM migration_lease WHERE id = 1 AND holder = ?`).run(lease.holder);

  try {
    // Each step's version is written only after it returns, so an interrupted
    // upgrade resumes at the step it died in on the next open.
    if (from < 2) {
      migrateToV2(db, fenced);
      fenced(() => writeSchemaVersion(db, 2));
    }
    if (from < 3) {
      migrateToV3(db, fenced);
      fenced(() => writeSchemaVersion(db, 3));
    }
    if (from < 4) {
      migrateToV4(db, fenced);
      fenced(() => writeSchemaVersion(db, 4));
    }
    if (from < 5) migrateToV5(db, fenced);
    db.transaction(() => {
      assertHeld();
      writeSchemaVersion(db, MIRROR_SCHEMA_VERSION);
      release();
    });
  } catch (err) {
    if (!isMigrationConflict(err)) {
      try {
        db.transaction(release);
      } catch {
        // The lease lapses after its TTL instead; the migration's own failure is what surfaces.
      }
    }
    throw err;
  }
}

/**
 * Migrate an existing v1 mirror DB to v2 in place. Safe to re-run on a DB that
 * already carries the v2 shape — every step is written idempotently.
 *
 * v1→v2 changes:
 *   1. Backfill `published`, `updated`, `latest_version` from RFC 2822 → ISO 8601.
 *   2. Populate `paper_categories` (category, paper_id, updated) for every row.
 *
 * Memory safety: streams rows via rowid windows (default 5 000 per batch) and
 * commits each batch independently, through `inTransaction` (the lease-fenced
 * transaction of {@link migrate}) — never loads millions of rows at once, and
 * the WAL stays bounded. If the process is killed partway through, the stored
 * schema_version row is still 1 (the caller writes 2 only after this returns),
 * so re-opening resumes from the start without double-applying or corrupting.
 *
 * Progress: logs every batch to stdout so an operator can see the migration
 * advancing in container logs.
 */
function migrateToV2(db: SqliteHandle, inTransaction: InTransaction, batchSize = 5_000): void {
  // --- Step 1: Date backfill ---
  // Check if there is actually anything to migrate (skip on empty DB).
  const countRow = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers`).get();
  const total = countRow?.n ?? 0;

  if (total > 0) {
    let lastRowid = 0;
    let processed = 0;
    const select = db.prepare<{ rowid: number; published: string; updated: string }>(
      `SELECT rowid, published, updated FROM papers WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    const update = db.prepare(
      `UPDATE papers SET published = ?, updated = ?, latest_version = ? WHERE rowid = ?`,
    );

    while (true) {
      const rows = select.all(lastRowid, batchSize);
      if (rows.length === 0) break;
      inTransaction(() => {
        for (const row of rows) {
          const pub = normalizeDateToIso(row.published);
          const upd = normalizeDateToIso(row.updated);
          update.run(pub, upd, upd, row.rowid);
        }
      });
      processed += rows.length;
      lastRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
      process.stdout.write(`mirror migration v1→v2 (dates): ${processed}/${total} rows\n`);
      if (rows.length < batchSize) break;
    }
  }

  // --- Step 2: Populate paper_categories junction ---
  // Runs after step 1, so `papers.updated` is already ISO 8601 and gets
  // denormalized into the junction for index-backed date-ordered browse.
  // INSERT OR IGNORE keeps a re-run after a partial migration idempotent.
  {
    let lastRowid = 0;
    let processed = 0;
    const select = db.prepare<{ rowid: number; id: string; categories: string; updated: string }>(
      `SELECT rowid, id, categories, updated FROM papers WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    const catInsert = db.prepare(
      `INSERT OR IGNORE INTO paper_categories(category, paper_id, updated) VALUES (?, ?, ?)`,
    );

    while (true) {
      const rows = select.all(lastRowid, batchSize);
      if (rows.length === 0) break;
      inTransaction(() => {
        for (const row of rows) {
          for (const cat of row.categories.split(' ').filter(Boolean)) {
            catInsert.run(cat, row.id, row.updated);
          }
        }
      });
      processed += rows.length;
      lastRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
      process.stdout.write(`mirror migration v1→v2 (categories): ${processed}/${total} rows\n`);
      if (rows.length < batchSize) break;
    }
  }
}

/**
 * Migrate a v2 mirror DB to v3 in place: rebuild `papers_fts` with the
 * `comment` and `journal_ref` columns so the documented `co:` and `jr:` field
 * prefixes resolve on the mirror path (issue #37).
 *
 * FTS5 has no `ALTER TABLE ADD COLUMN`, so the index and its three sync
 * triggers are dropped ({@link MIRROR_FTS_DROP_STATEMENTS}) and recreated from
 * {@link MIRROR_FTS_STATEMENTS} — the same definition a fresh database gets, so
 * the two paths cannot drift. Dropping the triggers first matters: they
 * enumerate their columns, and a v2 trigger firing against a v3 index would
 * leave the index diverging from `papers` on every subsequent write.
 *
 * Refill is batched by rowid window rather than FTS5's one-shot `'rebuild'`
 * command, for the same reasons as the v2 backfill: the WAL stays bounded on a
 * multi-million-row mirror, and an operator sees progress in container logs.
 * The drop and the recreate commit together, and every batch commits on its
 * own, each through `inTransaction` (the lease-fenced transaction of
 * {@link migrate}), so no other writer's rebuild can interleave with this one
 * (issue #71).
 *
 * Idempotent by construction — a re-run after a partial failure drops the
 * half-filled index and starts from an empty one. The caller writes
 * schema_version 3 only after this returns, so an interrupted run repeats.
 */
function migrateToV3(db: SqliteHandle, inTransaction: InTransaction, batchSize = 5_000): void {
  inTransaction(() => {
    db.exec(MIRROR_FTS_DROP_STATEMENTS);
    db.exec(MIRROR_FTS_STATEMENTS);
  });

  const countRow = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers`).get();
  const total = countRow?.n ?? 0;
  if (total === 0) return;

  let lastRowid = 0;
  let processed = 0;
  const select = db.prepare<{ rowid: number }>(
    `SELECT rowid FROM papers WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  // Reads straight from the content table, so the indexed text is by
  // construction the text `papers` holds.
  const fill = db.prepare(
    `INSERT INTO papers_fts(rowid, title, authors, abstract, comment, journal_ref)
     SELECT rowid, title, authors, abstract, comment, journal_ref
     FROM papers WHERE rowid > ? AND rowid <= ?`,
  );

  while (true) {
    const rows = select.all(lastRowid, batchSize);
    if (rows.length === 0) break;
    const upperRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
    const lowerRowid = lastRowid;
    inTransaction(() => {
      fill.run(lowerRowid, upperRowid);
    });
    processed += rows.length;
    lastRowid = upperRowid;
    process.stdout.write(`mirror migration v2→v3 (fts rebuild): ${processed}/${total} rows\n`);
    if (rows.length < batchSize) break;
  }
}

/**
 * Migrate a v3 mirror DB to v4 in place (issue #78): add the junction's
 * `published` column ({@link MIRROR_JUNCTION_PUBLISHED_SQL}) and the trigger
 * that fills it for a v3 writer's insert ({@link MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL}),
 * fill it from `papers` in rowid batches, then build each of {@link MIRROR_DATE_INDEXES} —
 * the two new ones and the three it widens — dropping the old definition and
 * creating the new one in the same transaction. These are the statements a new
 * file runs when it is created, so a migrated file and a new one end alike.
 *
 * Every transaction goes through `inTransaction` (the lease-fenced transaction
 * of {@link migrate}). On a full-size mirror the backfill commits ~1,100
 * batches of under 2 s each and the longest index build runs 60–85 s, well
 * inside the lease's TTL. The caller writes schema_version 4 only after this
 * returns, so an interrupted run repeats the step: the column, once added,
 * stays; the backfill and every index are redone.
 */
function migrateToV4(db: SqliteHandle, inTransaction: InTransaction, batchSize = 5_000): void {
  inTransaction(() => {
    const columns = db.prepare<{ name: string }>(`PRAGMA table_info(paper_categories)`).all();
    if (!columns.some((c) => c.name === 'published')) db.exec([MIRROR_JUNCTION_PUBLISHED_SQL]);
    db.exec([MIRROR_JUNCTION_PUBLISHED_TRIGGER_SQL]);
  });

  const total =
    db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM paper_categories`).get()?.n ?? 0;
  let lastRowid = 0;
  let processed = 0;
  const select = db.prepare<{ rowid: number }>(
    `SELECT rowid FROM paper_categories WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const fill = db.prepare(
    `UPDATE paper_categories
     SET published = (SELECT published FROM papers WHERE papers.id = paper_categories.paper_id)
     WHERE rowid > ? AND rowid <= ?`,
  );
  while (total > 0) {
    const rows = select.all(lastRowid, batchSize);
    if (rows.length === 0) break;
    const upperRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
    const lowerRowid = lastRowid;
    inTransaction(() => {
      fill.run(lowerRowid, upperRowid);
    });
    processed += rows.length;
    lastRowid = upperRowid;
    process.stdout.write(
      `mirror migration v3→v4 (junction published): ${processed}/${total} rows\n`,
    );
    if (rows.length < batchSize) break;
  }

  for (const [drop, create] of MIRROR_DATE_INDEXES) {
    inTransaction(() => db.exec([drop, create]));
    process.stdout.write(`mirror migration v3→v4 (index): ${create}\n`);
  }
}

/**
 * Migrate a v4 mirror DB to v5 in place: its parts in order, each one
 * idempotent and run through `inTransaction` (the lease-fenced transaction of
 * {@link migrate}) on its own. The caller writes schema_version 5 once every
 * part has returned, so an interrupted run repeats them all on the next open,
 * each skipping the work it already committed.
 */
function migrateToV5(db: SqliteHandle, inTransaction: InTransaction): void {
  repairQuoteReferences(db, inTransaction);
  definePaperIdIndex(db, inTransaction);
}

/**
 * v5, second part (issue #85): end `paper_categories_paper_id_idx` at
 * {@link MIRROR_PAPER_ID_INDEX}'s `(paper_id, category)`, from the `(paper_id)`
 * the harvest runner built in a harvested file or from none in one the store
 * created, so a migrated file and a new one define it alike. The drop and the
 * create run in one transaction, which reuses the dropped index's pages; one
 * that finds the definition already in place, as a repeat after an
 * interruption does, changes nothing. The repair touches only `papers`, so the
 * order of the two parts is free. On a full-size mirror the transaction runs
 * 13–24 s and writes a WAL of about 160 MB.
 */
function definePaperIdIndex(db: SqliteHandle, inTransaction: InTransaction): void {
  const [drop, create] = MIRROR_PAPER_ID_INDEX;
  const built = inTransaction(() => {
    const stored = db
      .prepare<{ sql: string | null }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      )
      .get(createdName(create))?.sql;
    if (stored != null && comparableSql(stored) === comparableSql(create)) return false;
    db.exec([drop, create]);
    return true;
  });
  if (built) process.stdout.write(`mirror migration v4→v5 (index): ${create}\n`);
}

/** The `papers` columns that hold arXiv's text, as the harvester stores them. */
const TEXT_COLUMNS = ['title', 'authors', 'abstract', 'comment', 'journal_ref', 'doi'] as const;

/**
 * v5, first part (issue #88): decode the `&#39;` and `&#34;` a harvester stored
 * before it resolved numeric references, in each of {@link TEXT_COLUMNS}. OAI
 * writes every `'` and `"` of arXiv's text as one of the two and no other
 * character as a numeric reference, so any other reference a row holds is
 * arXiv's own text (OAI sends it with its `&` escaped) and stays. The repaired
 * row is what the harvester now stores for the same record.
 *
 * Batched by rowid window, each window one transaction. The update touches only
 * the rows that hold one of the two, so every other row stays byte for byte,
 * and a repeat after an interruption writes no row it already repaired: a
 * replacement never forms another reference. `papers_au` keeps `papers_fts` in
 * step with each row it rewrites. On a full-size mirror a window commits in
 * under 3 s.
 */
function repairQuoteReferences(
  db: SqliteHandle,
  inTransaction: InTransaction,
  batchSize = 5_000,
): void {
  const holdsOne = TEXT_COLUMNS.map(
    (c) => `instr(${c}, '&#39;') > 0 OR instr(${c}, '&#34;') > 0`,
  ).join(' OR ');
  const repair = db.prepare(
    `UPDATE papers
     SET ${TEXT_COLUMNS.map((c) => `${c} = replace(replace(${c}, '&#39;', ''''), '&#34;', '"')`).join(', ')}
     WHERE rowid > ? AND rowid <= ? AND (${holdsOne})`,
  );
  const select = db.prepare<{ rowid: number }>(
    `SELECT rowid FROM papers WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const total = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers`).get()?.n ?? 0;
  let lastRowid = 0;
  let processed = 0;
  let repaired = 0;
  while (total > 0) {
    const rows = select.all(lastRowid, batchSize);
    if (rows.length === 0) break;
    const upperRowid = rows[rows.length - 1]?.rowid ?? lastRowid;
    const lowerRowid = lastRowid;
    repaired += inTransaction(() => repair.run(lowerRowid, upperRowid).changes);
    processed += rows.length;
    lastRowid = upperRowid;
    process.stdout.write(
      `mirror migration v4→v5 (quote references): ${processed}/${total} rows, ${repaired} repaired\n`,
    );
    if (rows.length < batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// Per-process shared stores
// ---------------------------------------------------------------------------

let _store: MirrorStore | undefined;
let _reader: MirrorStore | undefined;

/** Open the process's shared writer store, creating or migrating the file. Writers only. */
export async function openStore(path: string): Promise<MirrorStore> {
  _store ??= await MirrorStore.open(path);
  return _store;
}

/**
 * The server's shared query-only store, opened through
 * {@link MirrorStore.openReader} and kept once it opens. A file that is not
 * ready is reported and opened afresh on the next call, never kept.
 */
export async function openReaderStore(path: string): Promise<MirrorReaderOpen> {
  if (_reader) return { status: 'open', store: _reader };
  const opened = await MirrorStore.openReader(path);
  if (opened.status !== 'open') return opened;
  // A concurrent call can have opened one first; keep that one.
  _reader ??= opened.store;
  if (_reader !== opened.store) opened.store.close();
  return { status: 'open', store: _reader };
}

/** Close and clear both shared stores — test-only. */
export function resetStore(): void {
  _store?.close();
  _store = undefined;
  _reader?.close();
  _reader = undefined;
}
