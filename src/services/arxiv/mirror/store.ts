/**
 * @fileoverview SQLite-backed store for the OAI-PMH mirror.
 * Uses `bun:sqlite` under Bun (no native build) and `better-sqlite3` on Node.
 * Exposes batch upsert, FTS5 search, and harvest-state read/write.
 * @module services/arxiv/mirror/store
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { databaseError } from '@cyanheads/mcp-ts-core/errors';
import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';
import { MIRROR_SCHEMA_SQL, MIRROR_SCHEMA_VERSION } from './schema.js';
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

  /** Open or create the store at `path`. Applies migrations on open. */
  static async open(path: string): Promise<MirrorStore> {
    await mkdir(dirname(resolvePath(path)), { recursive: true });
    try {
      const db = await openSqliteHandle(path);
      db.exec(MIRROR_SCHEMA_SQL);
      db.prepare(`INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)`).run(
        MIRROR_SCHEMA_VERSION,
        new Date().toISOString(),
      );
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

  writeHarvestState(state: HarvestState): void {
    this.db
      .prepare(
        `UPDATE harvest_state
         SET status = ?, last_datestamp = ?, resumption_token = ?,
             started_at = ?, completed_at = ?, total_records = ?, error_message = ?
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
   * defense in depth — see `ArxivService.searchMirror`. `categoryFilters` are
   * expanded category codes (group/archive expansion handled upstream); each
   * matches against `primary_category` or any token in `categories`.
   */
  search(options: {
    categoryFilters?: readonly string[];
    limit: number;
    matchExpr?: string;
    offset: number;
    sortBy: 'relevance' | 'published' | 'updated';
    sortOrder: 'ascending' | 'descending';
  }): { papers: PaperRow[]; total: number } {
    const params: unknown[] = [];
    const where: string[] = [];

    if (options.matchExpr) {
      where.push(`papers.rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)`);
      params.push(options.matchExpr);
    }

    if (options.categoryFilters && options.categoryFilters.length > 0) {
      const cats = options.categoryFilters;
      const orClauses: string[] = [];
      for (const c of cats) {
        // Match primary or any space-separated category token (with word boundary safety).
        orClauses.push(`(papers.primary_category = ? OR papers.categories = ? OR
                        papers.categories LIKE ? OR papers.categories LIKE ? OR
                        papers.categories LIKE ?)`);
        params.push(c, c, `${c} %`, `% ${c}`, `% ${c} %`);
      }
      where.push(`(${orClauses.join(' OR ')})`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = this.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers ${whereClause}`)
      .get(...params);
    const total = totalRow?.n ?? 0;

    let orderBy: string;
    const dir = options.sortOrder === 'ascending' ? 'ASC' : 'DESC';
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
      SELECT papers.id, papers.version, papers.title, papers.authors,
             papers.abstract, papers.primary_category, papers.categories,
             papers.published, papers.updated, papers.latest_version,
             papers.comment, papers.journal_ref, papers.doi
      FROM papers ${ftsJoin}
      ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare<PaperRow>(rowsSql).all(...params, options.limit, options.offset);
    return { papers: rows, total };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

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

/** Convert an OAI `arXivRaw` record to a flattened `papers`-table row. */
export function rawToRow(r: ArxivRawRecord): PaperRow {
  const categoryTokens = r.categories.split(/\s+/).filter(Boolean);
  const primary = categoryTokens[0] ?? '';
  const versions = [...r.versions].sort(
    (a, b) => parseInt(a.version.replace(/^v/, ''), 10) - parseInt(b.version.replace(/^v/, ''), 10),
  );
  const first = versions[0];
  const last = versions[versions.length - 1];
  const published = first?.date ?? r.datestamp;
  const updated = last?.date ?? r.datestamp;
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
