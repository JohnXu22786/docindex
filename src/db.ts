/**
 * SQLite persistence layer over `node:sqlite` (built-in, no native deps).
 *
 * Storage layout (schema version 1):
 *
 *   documents   – one row per indexed file (path unique) with mtime/size for
 *                 incremental change detection.
 *   segments    – per-file text chunks with the 1-based starting line; the FTS
 *                 row id aliases the segment id.
 *   embeddings  – optional semantic vectors keyed by segment id (BLOB float32).
 *   segments_fts– FTS5 table (unicode61 tokenizer) over our CJK-aware token
 *                 stream; used only for `bm25()` scores and matched row ids.
 *
 * The FTS5 table is a plain (not contentless) table storing the token stream
 * only — its rows are keyed by the segment id, so deleting a segment also
 * removes its FTS row and full content stays authoritative in `segments`.
 */
import { DatabaseSync } from 'node:sqlite'
import { ensureParentDirSync } from './util.ts'

/** Application id stamped into every database (`"DOCI"`). */
export const APP_ID = 0x444f4349
/** Current on-disk schema version. */
export const SCHEMA_VERSION = 1

export interface DocumentRow {
  id: number
  path: string
  title: string
  mtime: number
  size: number
  hash: string | null
  indexedAt: number
}

export interface SegmentRow {
  id: number
  docId: number
  kind: string
  seq: number
  line: number
  content: string
}

export interface LexicalHit {
  segId: number
  /** Raw FTS5 bm25() value (negative; larger is better). */
  bm25: number
}

export interface DbOptions {
  journalMode?: 'wal' | 'truncate' | 'delete'
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id        INTEGER PRIMARY KEY,
  path      TEXT    NOT NULL UNIQUE,
  title     TEXT    NOT NULL DEFAULT '',
  mtime     INTEGER NOT NULL DEFAULT 0,
  size      INTEGER NOT NULL DEFAULT 0,
  hash      TEXT,
  indexedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS segments (
  id      INTEGER PRIMARY KEY,
  docId   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL DEFAULT 'text',
  seq     INTEGER NOT NULL DEFAULT 0,
  line    INTEGER NOT NULL DEFAULT 0,
  content TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_doc ON segments(docId);
CREATE TABLE IF NOT EXISTS embeddings (
  segmentId INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  vec       BLOB NOT NULL,
  dim       INTEGER NOT NULL,
  norm      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS embeddings_dim ON embeddings(dim);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  tokenized
);
`

export class IndexDb {
  readonly path: string
  private readonly db: DatabaseSync

  private constructor(path: string, db: DatabaseSync) {
    this.path = path
    this.db = db
  }

  /** Open (or create) an index database. `path` may be `:memory:`. */
  static open(path: string, options: DbOptions = {}): IndexDb {
    if (path !== ':memory:') {
      ensureParentDirSync(path)
    }
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      if (path !== ':memory:') {
        db.exec('PRAGMA journal_mode = ' + (options.journalMode ?? 'wal'))
      }
      const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
      if (appId !== 0 && appId !== APP_ID) {
        throw new Error(`database ${path} belongs to another application (application_id ${appId})`)
      }
      db.exec('PRAGMA application_id = ' + APP_ID)
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION)
      db.exec(SCHEMA_SQL)
      return new IndexDb(path, db)
    } catch (error) {
      try {
        db.close()
      } catch {
        // ignore
      }
      throw error
    }
  }

  get userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    return row.user_version
  }

  /** Run `fn` inside a transaction; rolls back on error. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- documents -----------------------------------------------------------

  getDocumentByPath(path: string): DocumentRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as DocumentRow | undefined
  }

  listDocuments(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents').all() as unknown as DocumentRow[]
  }

  countDocuments(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
    return row.n
  }

  /** Insert or update a document by path; returns its id. */
  upsertDocument(doc: { path: string; title: string; mtime: number; size: number; hash?: string | null }): number {
    const existing = this.getDocumentByPath(doc.path)
    if (existing) {
      this.db
        .prepare(
          'UPDATE documents SET title = ?, mtime = ?, size = ?, hash = ?, indexedAt = ? WHERE id = ?',
        )
        .run(doc.title, doc.mtime, doc.size, doc.hash ?? null, Date.now(), existing.id)
      return existing.id
    }
    const result = this.db
      .prepare('INSERT INTO documents (path, title, mtime, size, hash, indexedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(doc.path, doc.title, doc.mtime, doc.size, doc.hash ?? null, Date.now())
    return Number(result.lastInsertRowid)
  }

  deleteDocument(docId: number): void {
    // Deleting a segment touches four tables (FTS row, embeddings, segment,
    // document); wrap it so a mid-way failure can never leave orphans.
    this.tx(() => {
      this.deleteSegmentsOfDoc(docId)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    })
  }

  // ---- segments + FTS ------------------------------------------------------

  /**
   * Remove every segment, its FTS row and embeddings for one document.
   * NOTE: callers wrap this in a transaction; it must not open its own, since
   * SQLite does not allow nested `BEGIN`s.
   */
  deleteSegmentsOfDoc(docId: number): void {
    const rows = this.db.prepare('SELECT id FROM segments WHERE docId = ?').all(docId) as Array<{ id: number }>
    for (const row of rows) {
      this.db.prepare('DELETE FROM segments_fts WHERE rowid = ?').run(row.id)
    }
    if (rows.length > 0) {
      this.db.prepare('DELETE FROM embeddings WHERE segmentId IN (SELECT id FROM segments WHERE docId = ?)').run(docId)
    }
    this.db.prepare('DELETE FROM segments WHERE docId = ?').run(docId)
  }

  countSegments(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }
    return row.n
  }

  countSegmentsOfDoc(docId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM segments WHERE docId = ?').get(docId) as { n: number }
    return row.n
  }

  /** Insert one segment plus its tokenized FTS row; returns the segment id. */
  insertSegment(docId: number, seg: { kind: string; seq: number; line: number; content: string }, tokenized: string): number {
    const result = this.db
      .prepare('INSERT INTO segments (docId, kind, seq, line, content) VALUES (?, ?, ?, ?, ?)')
      .run(docId, seg.kind, seg.seq, seg.line, seg.content)
    const segId = Number(result.lastInsertRowid)
    // FTS row id aliases the segment id.
    if (tokenized) {
      this.db.prepare('INSERT INTO segments_fts (rowid, tokenized) VALUES (?, ?)').run(segId, tokenized)
    }
    return segId
  }

  getSegment(segId: number): SegmentRow | undefined {
    return this.db.prepare('SELECT * FROM segments WHERE id = ?').get(segId) as SegmentRow | undefined
  }

  /**
   * Lexical search over the FTS table. Returns the best `limit` segments by
   * FTS5 `bm25()` (best-first; bm25 is negative, so sort descending).
   */
  searchLexical(matchQuery: string, limit: number): LexicalHit[] {
    const stmt = this.db.prepare(
      'SELECT rowid AS segId, bm25(segments_fts) AS bm25 FROM segments_fts WHERE segments_fts MATCH ? ORDER BY bm25(segments_fts) DESC LIMIT ?',
    )
    return stmt.all(matchQuery, limit) as unknown as LexicalHit[]
  }

  /** Rebuild the FTS index with `optimize` (call after bulk writes). */
  optimizeFts(): void {
    try {
      this.db.exec("INSERT INTO segments_fts(segments_fts) VALUES ('optimize')")
    } catch {
      // Optimization is best-effort; failure is not fatal.
    }
  }

  // ---- embeddings ----------------------------------------------------------

  upsertEmbedding(segmentId: number, vec: Float32Array): void {
    const norm = vectorNorm(vec)
    this.db
      .prepare(
        'INSERT INTO embeddings (segmentId, vec, dim, norm) VALUES (?, ?, ?, ?) ON CONFLICT(segmentId) DO UPDATE SET vec = excluded.vec, dim = excluded.dim, norm = excluded.norm',
      )
      .run(segmentId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), vec.length, norm)
  }

  countEmbeddings(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }
    return row.n
  }

  /**
   * Stream every stored embedding row-by-row (no full-table materialization).
   * Used for in-memory cosine search; the caller should stop early when it has
   * enough candidates.
   */
  *iterateEmbeddings(): Generator<{ segId: number; vec: Float32Array }> {
    const stmt = this.db.prepare('SELECT segmentId, vec FROM embeddings ORDER BY segmentId')
    for (const row of stmt.iterate()) {
      const r = row as unknown as { segmentId: number; vec: Buffer }
      yield {
        segId: r.segmentId,
        vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
      }
    }
  }

  // ---- stats ---------------------------------------------------------------

  fileSize(): number {
    if (this.path === ':memory:') return 0
    const pageCount = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    return pageCount * pageSize
  }

  /** Delete every row (used by full rebuild). */
  clear(): void {
    this.tx(() => {
      this.db.exec('DELETE FROM segments_fts')
      this.db.exec('DELETE FROM embeddings')
      this.db.exec('DELETE FROM segments')
      this.db.exec('DELETE FROM documents')
    })
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }
}

/** L2 norm of a float32 vector. */
function vectorNorm(vec: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!
    sum += v * v
  }
  return Math.sqrt(sum)
}