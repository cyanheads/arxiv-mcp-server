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
 * `MirrorStore.open` runs the in-place migrations an existing DB still needs,
 * in order, before returning the handle.
 * @module services/arxiv/mirror/store
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { databaseError } from '@cyanheads/mcp-ts-core/errors';
import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';
import { MIRROR_FTS_SQL, MIRROR_SCHEMA_SQL, MIRROR_SCHEMA_VERSION } from './schema.js';
import type { ArxivRawRecord, HarvestState, PaperRow } from './types.js';

/**
 * Runtime-agnostic prepared statement. Matches the intersection of
 * `bun:sqlite` and `better-sqlite3` statement APIs.
 */
interface Statement<TRow = unknown> {
  all(...params: unknown[]): TRow[];
  get(...params: unknown[]): TRow | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface SqliteHandle {
  close(): void;
  exec(sql: string): void;
  prepare<TRow = unknown>(sql: string): Statement<TRow>;
  transaction<T>(fn: () => T): T;
}

async function openSqliteHandle(path: string): Promise<SqliteHandle> {
  if (runtimeCaps.isBun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { create: true });
    return {
      close: () => {
        db.close();
      },
      exec: (sql) => {
        db.exec(sql);
      },
      prepare: <TRow>(sql: string) => {
        const stmt = db.prepare(sql);
        return {
          all: (...params: unknown[]) => stmt.all(...(params as never[])) as TRow[],
          get: (...params: unknown[]) => stmt.get(...(params as never[])) as TRow | undefined,
          run: (...params: unknown[]) => {
            const r = stmt.run(...(params as never[]));
            return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
          },
        };
      },
      transaction: <T>(fn: () => T): T => {
        const tx = db.transaction(fn);
        return tx() as T;
      },
    };
  }
  const mod = (await import('better-sqlite3')) as unknown as {
    default: new (
      path: string,
    ) => {
      close: () => unknown;
      exec: (sql: string) => unknown;
      prepare: (sql: string) => {
        all: (...p: unknown[]) => unknown[];
        get: (...p: unknown[]) => unknown;
        run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
      };
      transaction: <T>(fn: () => T) => () => T;
    };
  };
  const db = new mod.default(path);
  return {
    close: () => {
      db.close();
    },
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: <TRow>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...params) as TRow[],
        get: (...params: unknown[]) => stmt.get(...params) as TRow | undefined,
        run: (...params: unknown[]) => stmt.run(...params),
      };
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

/**
 * Mirror data store. Wraps a SQLite handle with arXiv-specific reads and writes.
 * Open once per process via {@link openStore}; share the handle across readers.
 */
export class MirrorStore {
  private constructor(private readonly db: SqliteHandle) {}

  /** Open or create the store at `path`. Applies schema + runs v1→v2 migration when needed. */
  static async open(path: string): Promise<MirrorStore> {
    await mkdir(dirname(resolvePath(path)), { recursive: true });
    try {
      const db = await openSqliteHandle(path);
      // Always run the idempotent DDL first so new tables/indexes exist before
      // reading schema_version on any path (fresh DB or upgrade).
      db.exec(MIRROR_SCHEMA_SQL);
      const stored = db
        .prepare<{ version: number }>(
          `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`,
        )
        .get();
      const storedVersion = stored?.version ?? 0;
      // Each step's version is written only after it returns, so an interrupted
      // upgrade resumes at the step it died in on the next open.
      if (storedVersion < 2) {
        migrateToV2(db);
        writeSchemaVersion(db, 2);
      }
      if (storedVersion < 3) {
        migrateToV3(db);
        writeSchemaVersion(db, 3);
      }
      return new MirrorStore(db);
    } catch (err) {
      throw databaseError(`Failed to open mirror store at ${path}`, { path }, { cause: err });
    }
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
   * Execute an FTS5 + filter search. The translator (`query.ts`) is responsible
   * for producing a `matchExpr` that parses against FTS5 for every input the
   * arXiv-syntax lexer accepts — specifically, it inserts explicit `AND` at any
   * boundary where implicit conjunction would cross a parenthesized form
   * (see issue #13). Callers still wrap this in a SQLite-error catch for
   * defense in depth — see `ArxivService.searchMirror`.
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
    // Build the WHERE clause for the papers table.
    // -------------------------------------------------------------------------
    const papersParams: unknown[] = [];
    const papersWhere: string[] = [];

    if (options.matchExpr) {
      papersWhere.push(`papers.rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)`);
      papersParams.push(options.matchExpr);
    }

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

    const whereClause = papersWhere.length > 0 ? `WHERE ${papersWhere.join(' AND ')}` : '';

    // -------------------------------------------------------------------------
    // COUNT — the single-group category-only path uses a direct junction query
    // to avoid a full papers-table scan (issue #19). Every other shape (an FTS
    // term, a date window, or a second category group to intersect against)
    // takes the generic papers-table COUNT below.
    // -------------------------------------------------------------------------
    const soleGroup = groups.length === 1 ? groups[0] : undefined;
    let total: number;
    if (soleGroup && !options.matchExpr && !hasDateWindow) {
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
    // Fast path: exactly one category, no FTS term, no date window, not sorted
    // by published. This covers the dominant category-browse shape (default and
    // updated sorts both order by `updated`). It pages straight off the
    // (category, updated) junction index — no sort, no papers scan — so it stays
    // fast for rare categories too, not just common ones (issue #19). Every
    // other shape (multiple categories, a second category group, an FTS term, a
    // date window, or sort_by:published) takes the generic papers-table path
    // below, which is the only one that applies `whereClause`.
    // -------------------------------------------------------------------------
    const columns = `papers.id, papers.version, papers.title, papers.authors,
             papers.abstract, papers.primary_category, papers.categories,
             papers.published, papers.updated, papers.latest_version,
             papers.comment, papers.journal_ref, papers.doi`;

    const singleCat =
      soleGroup &&
      !options.matchExpr &&
      !hasDateWindow &&
      soleGroup.length === 1 &&
      options.sortBy !== 'published'
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
          orderBy = options.matchExpr
            ? `ORDER BY bm25(papers_fts) ASC`
            : `ORDER BY papers.updated DESC`;
      }

      // bm25() needs the FTS5 table reference; only valid when matchExpr is present.
      const ftsJoin =
        options.matchExpr && options.sortBy === 'relevance'
          ? `JOIN papers_fts ON papers.rowid = papers_fts.rowid`
          : '';

      const rowsSql = `
        SELECT ${columns}
        FROM papers ${ftsJoin}
        ${whereClause}
        ${orderBy}
        LIMIT ? OFFSET ?
      `;
      rows = this.db.prepare<PaperRow>(rowsSql).all(...papersParams, options.limit, options.offset);
    }
    return { papers: rows, total };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Schema version this database carries, and the version the running code
   * expects. They diverge only mid-upgrade — {@link MirrorStore.open} migrates
   * before returning — so a mismatch reported here means a migration failed.
   */
  schemaVersion(): { current: number; expected: number } {
    const row = this.db
      .prepare<{ version: number }>(
        `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`,
      )
      .get();
    return { current: row?.version ?? 0, expected: MIRROR_SCHEMA_VERSION };
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

/** Record the schema version reached. Called only after a migration completes. */
function writeSchemaVersion(db: SqliteHandle, version: number): void {
  db.prepare(`DELETE FROM schema_version`).run();
  db.prepare(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`).run(
    version,
    new Date().toISOString(),
  );
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
 * commits each batch independently — never loads millions of rows at once, and
 * the WAL stays bounded. If the process is killed partway through, the stored
 * schema_version row is still 1 (the caller writes 2 only after this returns),
 * so re-opening resumes from the start without double-applying or corrupting.
 *
 * Progress: logs every batch to stdout so an operator can see the migration
 * advancing in container logs.
 */
function migrateToV2(db: SqliteHandle, batchSize = 5_000): void {
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
      db.transaction(() => {
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
      db.transaction(() => {
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
 * triggers are dropped and recreated from {@link MIRROR_FTS_SQL} — the same
 * definition a fresh database gets, so the two paths cannot drift. Dropping the
 * triggers first matters: they enumerate their columns, and a v2 trigger firing
 * against a v3 index would leave the index diverging from `papers` on every
 * subsequent write.
 *
 * Refill is batched by rowid window rather than FTS5's one-shot `'rebuild'`
 * command, for the same reasons as the v2 backfill: the WAL stays bounded on a
 * multi-million-row mirror, and an operator sees progress in container logs.
 *
 * Idempotent by construction — a re-run after a partial failure drops the
 * half-filled index and starts from an empty one. The caller writes
 * schema_version 3 only after this returns, so an interrupted run repeats.
 */
function migrateToV3(db: SqliteHandle, batchSize = 5_000): void {
  db.exec(`
    DROP TRIGGER IF EXISTS papers_ai;
    DROP TRIGGER IF EXISTS papers_ad;
    DROP TRIGGER IF EXISTS papers_au;
    DROP TABLE IF EXISTS papers_fts;
  `);
  db.exec(MIRROR_FTS_SQL);

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
    db.transaction(() => {
      fill.run(lowerRowid, upperRowid);
    });
    processed += rows.length;
    lastRowid = upperRowid;
    process.stdout.write(`mirror migration v2→v3 (fts rebuild): ${processed}/${total} rows\n`);
    if (rows.length < batchSize) break;
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _store: MirrorStore | undefined;

/** Open the shared mirror store for the current process. */
export async function openStore(path: string): Promise<MirrorStore> {
  _store ??= await MirrorStore.open(path);
  return _store;
}

/** Return the open store or undefined when not yet opened. */
export function getStore(): MirrorStore | undefined {
  return _store;
}

/** Close and clear the shared store — test-only. */
export function resetStore(): void {
  if (_store) {
    _store.close();
    _store = undefined;
  }
}
