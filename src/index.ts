/**
 * dsh bundle entry — `dsh-doc-index`.
 *
 * A Cordis Service that exposes a local workspace document index through
 * `ctx.docIndex` and registers four model-facing tools (`doc_scan`,
 * `doc_query`, `doc_reindex`, `doc_stats`).
 *
 * The plugin mirrors the shape used by `@deepseek-ai/dsh-session-query-sqlite`:
 * a `Service` subclass default export with `static inject` and `static Config`.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DocIndexEngine, type EngineOptions } from './engine.ts'
import { createDocTools } from './tools.ts'
import type { IndexStats, QueryOptions, QueryResult, ScanReport, ScanRequest } from './types.ts'
import { defaultDbPath } from './util.ts'

export const name = 'doc-index'

export interface Config {
  /** Workspace roots (absolute or relative). Empty → process.cwd(). */
  roots?: string[]
  /** SQLite database path. Empty → $DSH_HOME/doc-index/index.db. */
  dbPath?: string
  openAt?: 'startup' | 'first-use' | 'never'
  update?: 'watch' | 'manual'
  watchDebounceMs?: number
  excludes?: string[]
  includeHidden?: boolean
  followSymlinks?: boolean
  maxDocs?: number
  maxSegments?: number
  maxEmbeddedSegments?: number
  maxFileBytes?: number
  maxDepth?: number
  maxWalkedFiles?: number
  tokenizer?: { cjkN?: 1 | 2 | 3 }
  segmentChars?: number
  snippetChars?: number
  textExtensions?: string[]
  search?: {
    topK?: number
    minScore?: number
    mode?: 'auto' | 'lexical' | 'semantic'
    highlight?: boolean
    matchOp?: 'and' | 'or'
    rrfK?: number
    semanticWeight?: number
  }
  embedding?: {
    provider?: 'none' | 'ngram' | 'transformers'
    dim?: number
    model?: string
    device?: 'auto' | 'cpu' | 'gpu' | 'wasm'
    cacheDir?: string
    quantized?: boolean
  }
  journalMode?: 'wal' | 'truncate' | 'delete'
}

const cjkN = z.union([1, 2, 3] as const).default(2)
const searchMode = z.union(['auto', 'lexical', 'semantic'] as const).default('auto')
const matchOp = z.union(['and', 'or'] as const).default('and')
const embedProvider = z.union(['none', 'ngram', 'transformers'] as const).default('ngram')

/** Plugin configuration schema (Schemastery). */
export const pluginConfig = z.object({
  roots: z.array(z.string()).default([]),
  dbPath: z.string().default(''),
  openAt: z.union(['startup', 'first-use', 'never'] as const).default('startup'),
  update: z.union(['watch', 'manual'] as const).default('watch'),
  watchDebounceMs: z.number().min(0).default(1500),
  excludes: z.array(z.string()).default([]),
  includeHidden: z.boolean().default(false),
  followSymlinks: z.boolean().default(false),
  maxDocs: z.number().step(1).min(1).default(20000),
  maxSegments: z.number().step(1).min(1).default(300000),
  maxEmbeddedSegments: z.number().step(1).min(0).default(50000),
  maxFileBytes: z.number().step(1).min(1).default(5 * 1024 * 1024),
  maxDepth: z.number().step(1).min(0).default(64),
  maxWalkedFiles: z.number().step(1).min(1).default(200000),
  tokenizer: z
    .object({ cjkN })
    .default({ cjkN: 2 }),
  segmentChars: z.number().step(1).min(32).default(400),
  snippetChars: z.number().step(1).min(16).default(240),
  textExtensions: z.array(z.string()).default([]),
  search: z
    .object({
      topK: z.number().step(1).min(1).max(50).default(10),
      minScore: z.number().min(0).max(1).default(0),
      mode: searchMode,
      highlight: z.boolean().default(true),
      matchOp,
      rrfK: z.number().step(1).min(1).default(60),
      semanticWeight: z.number().min(0).max(1).default(0.5),
    })
    .default({ topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 }),
  embedding: z
    .object({
      provider: embedProvider,
      dim: z.number().step(1).min(16).max(8192).default(256),
      model: z.string().default(''),
      device: z.union(['auto', 'cpu', 'gpu', 'wasm'] as const).default('auto'),
      cacheDir: z.string().default(''),
      quantized: z.boolean().default(true),
    })
    .default({ provider: 'ngram', dim: 256, model: '', device: 'auto', cacheDir: '', quantized: true }),
  journalMode: z.union(['wal', 'truncate', 'delete'] as const).default('wal'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local workspace document index service provided by this bundle. */
    docIndex: DocIndexService
  }
}

/**
 * The `ctx.docIndex` service.
 *
 * Registers the four `doc_*` tools and keeps the index up to date when
 * `update: 'watch'` (the default).
 */
export class DocIndexService extends Service {
  static inject = ['tools']
  static Config = pluginConfig

  private readonly engine: DocIndexEngine
  private watcher: { close: () => void } | null = null
  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'docIndex')
    this.config = config ?? {}
    this.engine = new DocIndexEngine(this.toEngineOptions())
    if (this.config.openAt === 'startup') this.engine.open()

    // Release the SQLite handle and stop the watcher when the plugin unloads.
    ctx.effect(() => [
      () => this.watcher?.close(),
      () => this.engine.close(),
    ])
  }

  protected async [Service.init](): Promise<void> {
    for (const definition of createDocTools(this.handle)) {
      this.ctx.tools.register(definition)
    }
    if (this.config.update === 'watch') {
      this.watcher = this.engine.watch((report) => {
        if (report.indexed + report.updated + report.removed > 0) {
          this.log('info', `doc-index updated: +${report.indexed} ~${report.updated} -${report.removed}`)
        }
      })
    }
  }

  /** Engine handle passed to the tools (keeps the surface stable). */
  private get handle() {
    return {
      scan: (request?: ScanRequest) => this.scan(request),
      query: (request: QueryOptions) => this.query(request),
      reindex: (request?: ScanRequest) => this.reindex(request),
      stats: () => this.stats(),
    }
  }

  scan(request?: ScanRequest): Promise<ScanReport> {
    return this.engine.scan(request)
  }

  query(request: QueryOptions): Promise<QueryResult> {
    return this.engine.query(request)
  }

  reindex(request: ScanRequest = {}): Promise<ScanReport> {
    return this.engine.reindex(request)
  }

  stats(): Promise<IndexStats> {
    return this.engine.stats()
  }

  private toEngineOptions(): EngineOptions {
    const config = this.config
    return {
      dbPath: config.dbPath || defaultDbPath(),
      roots: config.roots && config.roots.length > 0 ? config.roots : [process.cwd()],
      excludes: config.excludes ?? [],
      includeHidden: config.includeHidden ?? false,
      followSymlinks: config.followSymlinks ?? false,
      capacity: {
        maxDocs: config.maxDocs ?? 20000,
        maxSegments: config.maxSegments ?? 300000,
        maxEmbeddedSegments: config.maxEmbeddedSegments ?? 50000,
        maxFileBytes: config.maxFileBytes ?? 5 * 1024 * 1024,
        maxDepth: config.maxDepth ?? 64,
        maxWalkedFiles: config.maxWalkedFiles ?? 200000,
      },
      tokenizerCjkN: (config.tokenizer?.cjkN ?? 2) as 1 | 2 | 3,
      segmentChars: config.segmentChars ?? 400,
      snippetChars: config.snippetChars ?? 240,
      search: {
        topK: config.search?.topK ?? 10,
        minScore: config.search?.minScore ?? 0,
        mode: config.search?.mode ?? 'auto',
        highlight: config.search?.highlight ?? true,
        matchOp: config.search?.matchOp ?? 'and',
        rrfK: config.search?.rrfK ?? 60,
        semanticWeight: config.search?.semanticWeight ?? 0.5,
      },
      embedding: {
        provider: config.embedding?.provider ?? 'ngram',
        dim: config.embedding?.dim ?? 256,
        model: config.embedding?.model ?? '',
        device: config.embedding?.device ?? 'auto',
        cacheDir: config.embedding?.cacheDir ?? '',
        quantized: config.embedding?.quantized ?? true,
      },
      textExtensions: config.textExtensions ?? [],
      journalMode: config.journalMode ?? 'wal',
      watchDebounceMs: config.watchDebounceMs ?? 1500,
      logger: (level, message) => this.log(level, message),
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    // `ctx.logger` is provided by the base bundle; guard for safety.
    const logger = (this.ctx as { logger?: (scope: string) => Record<typeof level, (msg: string) => void> }).logger?.('doc-index')
    logger?.[level]?.(message)
  }
}

export default DocIndexService
