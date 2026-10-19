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
  MIRROR_FTS_DROP_STATEMENTS,
  MIRROR_FTS_STATEMENTS,
  MIRROR_PRAGMA_STATEMENTS,
  MIRROR_SCHEMA_STATEMENTS,
  MIRROR_SCHEMA_VERSION,
  MIRROR_WRITE_INDEX_SQL,
} from './schema.js';
import type { ArxivRawRecord, HarvestState, PaperRow } from './types.js';

/**
 * Most FTS matches a mirror search will count and rank (issue #49). A free-text
 * term that reaches this many papers is answered by the live API instead — see
 * {@link MirrorStore.matchReachesCap}.
 */
export const MIRROR_SEARCH_MATCH_CAP = 50_000;

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
 * lease ages by at most one transaction: the longest is the drop of the old
 * index, tens of seconds on a full corpus, and the TTL stays well clear of it
 * so a lease is never read as lapsed while its holder works. One left older
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
   * (v1→v2, v2→v3) before returning. A failed open closes its connection.
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
   * Ensure the write-path index on `paper_categories(paper_id)` exists (issue
   * #50). A no-op when it already does; the first call on a full-corpus mirror
   * builds it in one pass over the junction. Called by the harvest runner, never
   * by {@link MirrorStore.open} — see `MIRROR_WRITE_INDEX_SQL`. Another writer's
   * lock is waited out up to the writer busy timeout, then fails with
   * `SQLITE_BUSY` (issue #64).
   */
  ensureWriteIndex(): void {
    this.db.exec([MIRROR_WRITE_INDEX_SQL]);
  }

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
      `INSERT OR IGNORE INTO paper_categories(category, paper_id, updated) VALUES (?, ?, ?)`,
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
        // IGNORE). `updated` is denormalized in so category browse pages in date order.
        catDelete.run(row.id);
        for (const cat of row.categories.split(' ').filter(Boolean)) {
          catInsert.run(cat, row.id, row.updated);
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
   * Execute an FTS5 + filter search. The translator (`query.ts`) is responsible
   * for producing a `matchExpr` that parses against FTS5 for every input the
   * arXiv-syntax lexer accepts — specifically, it inserts explicit `AND` at any
   * boundary where implicit conjunction would cross a parenthesized form
   * (see issue #13). Callers still wrap this in a SQLite-error catch for
   * defense in depth — see `ArxivService.searchMirror`.
   *
   * With a `matchExpr`, both the count and the page are driven from the FTS
   * index, so their cost follows the match set rather than the corpus; callers
   * bound that set first with {@link MirrorStore.matchReachesCap} (issue #49).
   * Relevance order is BM25 (best first; `sortOrder` does not apply), with rowid
   * breaking ties so pages never overlap.
   *
   * `categoryGroups` holds expanded category codes (subtree expansion handled
   * upstream), matched via the `paper_categories` junction table (index-backed —
   * see issue #19). Codes within a group are OR-ed; groups are AND-ed, which is
   * how the live API composes a `cat:` operand in the query text with the
   * `category` parameter's own operand — a paper must carry a code from every
   * group. One group per independent filter the caller supplied.
   *
   * `publishedFrom` / `publishedTo` bound `papers.published` inclusively (the
   * `papers_published_idx` index backs the range). They are ISO 8601 instants in
   * the normalized form `rawToRow` writes, so lexicographic comparison is
   * chronological. Each bound names one exact instant, not a minute or a day: the
   * upper bound for `submitted_to: 2021-03-10` is `2021-03-11T00:00:00.000Z`, the
   * following midnight, so a record at `23:59:30Z` stays inside the window and one
   * submitted exactly on the seam falls in both neighbours. See `date-window.ts`.
   */
  search(options: {
    categoryGroups?: readonly (readonly string[])[];
    limit: number;
    matchExpr?: string;
    offset: number;
    publishedFrom?: string;
    publishedTo?: string;
    sortBy: 'relevance' | 'published' | 'updated';
    sortOrder: 'ascending' | 'descending';
  }): { papers: PaperRow[]; total: number } {
    const groups = (options.categoryGroups ?? []).filter((g) => g.length > 0);
    const hasDateWindow = options.publishedFrom !== undefined || options.publishedTo !== undefined;
    const dir = options.sortOrder === 'ascending' ? 'ASC' : 'DESC';

    // -------------------------------------------------------------------------
    // Build the filters on `papers` columns, shared by every search shape.
    // -------------------------------------------------------------------------
    const papersParams: unknown[] = [];
    const papersWhere: string[] = [];

    // Category filtering via the junction table: index-backed exact match. One
    // subquery per group, AND-ed by the surrounding WHERE — a paper matches when
    // it carries at least one code from each group.
    for (const group of groups) {
      const placeholders = group.map(() => '?').join(', ');
      papersWhere.push(
        `papers.id IN (SELECT paper_id FROM paper_categories WHERE category IN (${placeholders}))`,
      );
      papersParams.push(...group);
    }

    if (options.publishedFrom !== undefined) {
      papersWhere.push(`papers.published >= ?`);
      papersParams.push(options.publishedFrom);
    }
    if (options.publishedTo !== undefined) {
      papersWhere.push(`papers.published <= ?`);
      papersParams.push(options.publishedTo);
    }

    const columns = `papers.id, papers.version, papers.title, papers.authors,
             papers.abstract, papers.primary_category, papers.categories,
             papers.published, papers.updated, papers.latest_version,
             papers.comment, papers.journal_ref, papers.doi`;

    // -------------------------------------------------------------------------
    // FTS term: count and page both enumerate the match set from the index
    // (issue #49). CROSS JOIN pins `papers_fts` as the outer loop, so each match
    // costs one rowid lookup into `papers` and the filters run per match.
    // `rank` / `bm25()` score only on the cursor the MATCH constrains.
    // -------------------------------------------------------------------------
    if (options.matchExpr) {
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
        return { papers: this.getPapersByRowids(rowids, columns), total: totalRow?.n ?? 0 };
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
        papers: this.getPapersByRowids(
          page.map((r) => r.rid),
          columns,
        ),
        total,
      };
    }

    const whereClause = papersWhere.length > 0 ? `WHERE ${papersWhere.join(' AND ')}` : '';

    // -------------------------------------------------------------------------
    // COUNT — the single-group category-only path uses a direct junction query
    // to avoid a full papers-table scan (issue #19). Every other shape (a date
    // window, or a second category group to intersect against) takes the
    // generic papers-table COUNT below.
    // -------------------------------------------------------------------------
    const soleGroup = groups.length === 1 ? groups[0] : undefined;
    let total: number;
    if (soleGroup && !hasDateWindow) {
      // Pure category filter: COUNT directly on the junction, which is indexed
      // on category. Multiple categories → UNION on primary keys (no dups).
      if (soleGroup.length === 1) {
        const row = this.db
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM paper_categories WHERE category = ?`)
          .get(soleGroup[0]);
        total = row?.n ?? 0;
      } else {
        // UNION removes duplicates across categories so a paper in cs.LG AND
        // cs.AI counts once.
        const placeholders = soleGroup.map(() => '?').join(', ');
        const row = this.db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT paper_id FROM paper_categories
               WHERE category IN (${placeholders})
             )`,
          )
          .get(...soleGroup);
        total = row?.n ?? 0;
      }
    } else {
      const totalRow = this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers ${whereClause}`)
        .get(...papersParams);
      total = totalRow?.n ?? 0;
    }

    // -------------------------------------------------------------------------
    // Row page.
    //
    // Fast path: exactly one category, no date window, not sorted by published.
    // This covers the dominant category-browse shape (default and updated sorts
    // both order by `updated`). It pages straight off the (category, updated)
    // junction index — no sort, no papers scan — so it stays fast for rare
    // categories too, not just common ones (issue #19). Every other shape
    // (multiple categories, a second category group, a date window, or
    // sort_by:published) takes the generic papers-table path below, which is the
    // only one that applies `whereClause`.
    // -------------------------------------------------------------------------
    const singleCat =
      soleGroup && !hasDateWindow && soleGroup.length === 1 && options.sortBy !== 'published'
        ? soleGroup[0]
        : undefined;

    let rows: PaperRow[];
    if (singleCat !== undefined) {
      // 'updated' respects sortOrder; 'relevance'/default reduce to updated-desc.
      const junctionDir = options.sortBy === 'updated' ? dir : 'DESC';
      const rowsSql = `
        SELECT ${columns}
        FROM paper_categories
        JOIN papers ON papers.id = paper_categories.paper_id
        WHERE paper_categories.category = ?
        ORDER BY paper_categories.updated ${junctionDir}
        LIMIT ? OFFSET ?
      `;
      rows = this.db.prepare<PaperRow>(rowsSql).all(singleCat, options.limit, options.offset);
    } else {
      let orderBy: string;
      switch (options.sortBy) {
        case 'published':
          orderBy = `ORDER BY papers.published ${dir}`;
          break;
        case 'updated':
          orderBy = `ORDER BY papers.updated ${dir}`;
          break;
        default:
          // No term to rank by: relevance reduces to newest-updated first.
          orderBy = `ORDER BY papers.updated DESC`;
      }

      const rowsSql = `
        SELECT ${columns}
        FROM papers
        ${whereClause}
        ${orderBy}
        LIMIT ? OFFSET ?
      `;
      rows = this.db.prepare<PaperRow>(rowsSql).all(...papersParams, options.limit, options.offset);
    }
    return { papers: rows, total };
  }

  /** Read `columns` for a page of rowids, in the order given. */
  private getPapersByRowids(rowids: number[], columns: string): PaperRow[] {
    if (rowids.length === 0) return [];
    const rows = this.db
      .prepare<PaperRow & { rid: number }>(
        `SELECT papers.rowid AS rid, ${columns} FROM papers
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
 * or the drop of a full-corpus index. The open then reads the lease without the
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
      if (created) writeSchemaVersion(db, MIRROR_SCHEMA_VERSION);
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
    if (from < 3) migrateToV3(db, fenced);
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
