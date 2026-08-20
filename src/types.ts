/**
 * Public result shapes shared across the engine, tools and CLI.
 */

/** Why a file was not indexed. */
export type SkipReason =
  | 'ignored'
  | 'hidden'
  | 'symlink'
  | 'too-large'
  | 'binary'
  | 'no-text-layer'
  | 'unsupported'
  | 'empty'
  | 'max-docs'
  | 'max-segments'
  | 'max-embedded'
  | 'missing-root'
  | 'walk-limit'
  | 'error'

/** Tally of files skipped per reason. */
export type SkipCounts = Partial<Record<SkipReason, number>>

export interface ScanReport {
  mode: 'incremental' | 'full' | 'cleanup'
  roots: string[]
  scanned: number
  indexed: number
  updated: number
  removed: number
  unchanged: number
  skipped: SkipCounts
  /** Up to N example error messages to help diagnose failures. */
  errors: Array<{ path: string; message: string }>
  errorsTotal: number
  tookMs: number
}

export type QueryMode = 'auto' | 'lexical' | 'semantic'

export interface QueryOptions {
  query: string
  topK?: number
  mode?: QueryMode
  /** Reject fused results below this normalized score. */
  minScore?: number
  snippetChars?: number
  highlight?: boolean
}

export interface Hit {
  /** FTS segment row id (stable within one query). */
  id: number
  docId: number
  /** Absolute path of the containing document. */
  path: string
  /** Document title (file name or heading). */
  title: string
  /** 1-based source line where the segment starts. */
  line: number
  /** Full raw segment content. */
  content: string
  /** Truncated, optionally highlighted snippet. */
  snippet: string
  /** Combined normalized relevance in [0, 1]. */
  score: number
  /** Which retrieval modes contributed to this hit. */
  from: Array<'lexical' | 'semantic'>
}

export interface QueryResult {
  query: string
  mode: QueryMode
  /** Which modes actually ran (semantic can be dropped on missing model). */
  used: Array<'lexical' | 'semantic'>
  hits: Hit[]
  total: number
  tookMs: number
  /** True when a requested capability silently degraded (e.g. no semantic model). */
  degraded: boolean
}

export interface IndexStats {
  dbPath: string
  dbBytes: number
  docs: number
  segments: number
  embedded: number
  roots: string[]
  userVersion: number
  schemaVersion: number
  lastScannedAt: number | null
}

/** Options accepted by `scan()` / `reindex()`. */
export interface ScanRequest {
  path?: string
  force?: boolean
  /** `reindex` only: clear the index before rebuilding. */
  full?: boolean
}
