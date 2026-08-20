/**
 * DocIndex engine: the component that ties discovery, extraction, tokenization,
 * FTS5 storage, embeddings and ranking together.
 *
 * The engine is deliberately dsh-agnostic — it depends only on Node built-ins
 * and the other modules in this repo — so the CLI, the tests and the dsh
 * plugin all share one implementation.
 */
import { existsSync, readFileSync, statSync, watch as fsWatch, type FSWatcher, type Stats } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { IndexDb } from './db.ts'
import { DEFAULT_CAPACITY, SkipTracker, type CapacityLimits } from './capacity.ts'
import { discover, resolveRoot, type CandidateFile, type DiscoverOptions } from './discovery.ts'
import { compilePatterns, isIgnored, type IgnorePattern } from './ignore.ts'
import { extractDocument } from './extract.ts'
import { segmentText } from './segment.ts'
import { tokenize, tokenizeForIndex, buildMatchQuery, type CjkMode } from './tokenize.ts'
import { createEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider, cosineSim } from './embedding.ts'
import { fuseRanks, toRanks, type RankedHit } from './rank.ts'
import { makeSnippet } from './highlight.ts'
import type { Hit, IndexStats, QueryMode, QueryOptions, QueryResult, ScanReport, ScanRequest, SkipReason } from './types.ts'
import { charLen, ensureParentDirSync, toSlash } from './util.ts'

export interface SearchOptions {
  topK: number
  minScore: number
  mode: QueryMode
  highlight: boolean
  matchOp: 'and' | 'or'
  rrfK: number
  semanticWeight: number
}

export interface EngineOptions {
  /** SQLite database path (`:memory:` allowed). */
  dbPath: string
  /** Workspace roots to scan (absolute or relative). */
  roots: readonly string[]
  /** Extra gitignore-style exclude patterns. */
  excludes: readonly string[]
  includeHidden: boolean
  followSymlinks: boolean
  capacity: CapacityLimits
  tokenizerCjkN: CjkMode
  segmentChars: number
  snippetChars: number
  search: SearchOptions
  embedding: EmbeddingConfig
  textExtensions: readonly string[]
  journalMode?: 'wal' | 'truncate' | 'delete'
  /** Debounce for the watch-based updater (ms). */
  watchDebounceMs?: number
  /** Called for human-facing diagnostics; defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void
}

const MAX_HITS = 50
const MAX_ERROR_EXAMPLES = 5

export class DocIndexEngine {
  readonly options: EngineOptions
  private db: IndexDb | null = null
  private provider: EmbeddingProvider | null = null
  private providerReady = false
  private providerFailed: string | null = null
  private providerPromise: Promise<void> | null = null
  private ignore: IgnorePattern[]
  private lastScannedAt: number | null = null
  private closed = false
  /** Serializes scans/reindexes so the watch updater and manual calls cannot
   *  interleave at the async embedding/read boundaries. */
  private scanTail: Promise<unknown> = Promise.resolve()

  constructor(options: EngineOptions) {
    this.options = {
      ...options,
      capacity: { ...DEFAULT_CAPACITY, ...options.capacity },
      roots: [...options.roots],
      excludes: [...options.excludes],
      textExtensions: [...options.textExtensions],
    }
    this.ignore = compilePatterns([...DEFAULT_IGNORE, ...this.options.excludes])
  }

  get isOpen(): boolean {
    return this.db !== null
  }

  get dbPath(): string {
    return this.options.dbPath
  }

  /** Open the database and (try to) prepare the embedding provider. */
  open(): void {
    if (this.db) return
    if (this.options.dbPath !== ':memory:') ensureParentDirSync(this.options.dbPath)
    this.db = IndexDb.open(this.options.dbPath, { journalMode: this.options.journalMode })
    this.prepareProvider()
  }

  ensureOpen(): void {
    this.open()
  }

  private prepareProvider(): void {
    if (this.options.embedding.provider === 'none' || this.providerReady || this.providerFailed || this.providerPromise) return
    this.providerPromise = createEmbeddingProvider(this.options.embedding)
      .then((provider) => {
        this.provider = provider
        this.providerReady = true
      })
      .catch((error: unknown) => {
        this.providerFailed = error instanceof Error ? error.message : String(error)
        this.log('warn', `semantic embedding unavailable (${this.providerFailed}); using lexical-only search`)
      })
  }

  /** Await any in-flight provider build and return it when usable. */
  private async resolveProvider(): Promise<EmbeddingProvider | null> {
    this.prepareProvider()
    if (this.providerPromise) await this.providerPromise
    return this.providerReady ? this.provider : null
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.logger?.(level, message)
  }

  /**
   * Run `task` exclusively relative to other scans on this engine.
   * Overlapping scans (watch + manual) would each maintain their own
   * diff snapshot and could delete rows the other just wrote, so every
   * walk/prune must be serialized.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.scanTail.then(task, task)
    this.scanTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // --------------------------------------------------------------------------
  // Scanning
  // --------------------------------------------------------------------------

  /** Incremental scan / reindex of the workspace (serialized). */
  scan(request: ScanRequest = {}): Promise<ScanReport> {
    return this.runExclusive(() => this.runScan(request))
  }

  /** The actual scan body; must be reached through `runExclusive`. */
  private async runScan(request: ScanRequest): Promise<ScanReport> {
    this.ensureOpen()
    const started = Date.now()
    const skip = new SkipTracker()
    const db = this.db!

    const { candidates, completed } = this.collectCandidates(request.path, skip)
    const report: ScanReport = {
      mode: 'incremental',
      roots: [...this.options.roots],
      scanned: candidates.length,
      indexed: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: {},
      errors: [],
      errorsTotal: 0,
      tookMs: 0,
    }

    const provider = await this.resolveProvider()
    const embedEnabled = this.options.embedding.provider !== 'none' && provider !== null

    const existing = new Map(db.listDocuments().map((doc) => [doc.path, doc]))
    const seenAbs = new Set<string>()
    let segmentsTotal = db.countSegments()
    let embeddedBudget = this.options.capacity.maxEmbeddedSegments - db.countEmbeddings()

    const topLevel = !request.path
    const scopedPrefix = topLevel ? null : this.scopePrefix(request.path!)

    const addError = (path: string, message: string): void => {
      // Cap the in-memory examples; the total is derived from `skipped.error`
      // at the end (every error event also records a skip of reason 'error').
      if (report.errors.length < MAX_ERROR_EXAMPLES) report.errors.push({ path, message })
    }

    for (const candidate of candidates) {
      if (seenAbs.has(candidate.absPath)) continue
      seenAbs.add(candidate.absPath)

      const doc = existing.get(candidate.absPath)
      if (!doc && existing.size >= this.options.capacity.maxDocs) {
        skip.add('max-docs', candidate.relPath)
        continue
      }
      if (doc && !request.force && doc.mtime === Math.round(candidate.mtime) && doc.size === candidate.size) {
        report.unchanged++
        continue
      }
      // No free segment budget means no *new* document can be added; updates
      // of existing documents are still allowed (they replace in place and
      // free their own budget, so they cannot silently freeze).
      if (!doc && segmentsTotal >= this.options.capacity.maxSegments) {
        skip.add('max-segments', candidate.relPath)
        continue
      }

      const data = readFileSafe(candidate.absPath)
      if (!data) {
        skip.add('error', candidate.relPath)
        addError(candidate.relPath, 'unreadable file')
        continue
      }
      let outcome
      try {
        outcome = extractDocument(data.data, candidate.absPath, { textExtensions: this.options.textExtensions })
      } catch (error) {
        skip.add('error', candidate.relPath)
        addError(candidate.relPath, messageOf(error))
        continue
      }
      if (!outcome.ok) {
        skip.add(outcome.reason, candidate.relPath)
        continue
      }
      const segments = segmentText(outcome.result.text, { maxChars: this.options.segmentChars })
      if (segments.length === 0) {
        skip.add('empty', candidate.relPath)
        continue
      }

      const title = outcome.result.title || baseNameOf(candidate.absPath)
      const segIds: number[] = []
      const contents: string[] = []
      const docId = db.tx(() => {
        const id = db.upsertDocument({
          path: candidate.absPath,
          title,
          mtime: Math.round(candidate.mtime),
          size: candidate.size,
        })
        if (doc) {
          // Replacing this document's segments: account for the freed budget
          // so the caps below reflect reality (and updates at the cap don't
          // freeze).
          const prevSegments = db.countSegmentsOfDoc(id)
          db.deleteSegmentsOfDoc(id)
          segmentsTotal = Math.max(0, segmentsTotal - prevSegments)
          embeddedBudget = Math.max(0, this.options.capacity.maxEmbeddedSegments - db.countEmbeddings())
          report.updated++
        } else {
          report.indexed++
        }
        for (const seg of segments) {
          if (segmentsTotal >= this.options.capacity.maxSegments) break
          const tokenized = tokenizeForIndex(seg.content, { cjkN: this.options.tokenizerCjkN })
          const segId = db.insertSegment(id, seg, tokenized)
          segmentsTotal++
          segIds.push(segId)
          contents.push(seg.content)
        }
        return id
      })
      // A document that could not be fully stored is reported, not silent.
      if (segIds.length < segments.length) skip.add('max-segments', candidate.relPath)

      // Embedding pass lives outside the DB transaction (network/model work
      // must not hold SQLite locks).
      if (embedEnabled && embeddedBudget > 0 && segIds.length > 0) {
        const toEmbed = Math.min(segIds.length, embeddedBudget)
        try {
          const vectors = await provider!.embed(contents.slice(0, toEmbed))
          db.tx(() => {
            for (let i = 0; i < toEmbed; i++) {
              const vec = vectors[i]
              if (vec) db.upsertEmbedding(segIds[i]!, vec)
            }
          })
          embeddedBudget -= toEmbed
        } catch (error) {
          this.log('warn', `embedding failed for ${candidate.relPath}: ${messageOf(error)}`)
        }
      }
      existing.set(candidate.absPath, {
        id: docId,
        path: candidate.absPath,
        title,
        mtime: Math.round(candidate.mtime),
        size: candidate.size,
        hash: null,
        indexedAt: Date.now(),
      })
    }

    // Deletions are pruned only when the scan covered every file (a truncated
    // walk must never delete documents it simply never reached), and whole-
    // workspace scans prune everything while scoped scans prune only the
    // subtree they were asked about.
    if (completed) {
      if (topLevel) {
        for (const [path, doc] of existing) {
          if (seenAbs.has(path)) continue
          db.deleteDocument(doc.id)
          report.removed++
        }
      } else if (scopedPrefix) {
        for (const [path, doc] of existing) {
          const normPath = normalizeSlash(path)
          if (normPath.startsWith(scopedPrefix) && !seenAbs.has(path)) {
            db.deleteDocument(doc.id)
            report.removed++
          }
        }
      }
    }

    if (report.indexed + report.updated + report.removed > 0) {
      db.optimizeFts()
      this.lastScannedAt = Date.now()
    }
    report.skipped = { ...skip.counts }
    // Every error event is also counted in `skipped.error`; examples in
    // `errors` are a capped subset, so this is the exact total.
    report.errorsTotal = report.skipped['error'] ?? 0
    report.tookMs = Date.now() - started
    return report
  }

  /** Collect candidate files for the whole workspace or a single target path. */
  private collectCandidates(target: string | undefined, skip: SkipTracker): { candidates: CandidateFile[]; completed: boolean } {
    const onSkip = (reason: SkipReason, relPath: string): void => skip.add(reason, relPath)
    const baseOptions = {
      ignore: this.ignore,
      includeHidden: this.options.includeHidden,
      followSymlinks: this.options.followSymlinks,
      maxFiles: this.options.capacity.maxWalkedFiles,
      maxDepth: this.options.capacity.maxDepth,
      maxFileBytes: this.options.capacity.maxFileBytes,
      onSkip,
    } satisfies Omit<DiscoverOptions, 'roots'>

    if (target) {
      const abs = isAbsolute(target) ? target : resolve(target)
      const stat = statSafe(abs)
      if (!stat) return { candidates: [], completed: true }
      if (stat.isDirectory()) {
        return discover({ ...baseOptions, roots: [abs] })
      }
      const rel = relative(process.cwd(), abs).replace(/\\/g, '/') || baseNameOf(abs)
      // A single-file target still honors ignore rules and the size cap so an
      // explicit huge/binary path cannot bypass the guardrails.
      const matched = isIgnored(rel, false, this.ignore)
      if (matched.ignored) {
        skip.add('ignored', rel)
        return { candidates: [], completed: true }
      }
      if (stat.size > this.options.capacity.maxFileBytes) {
        skip.add('too-large', rel)
        return { candidates: [], completed: true }
      }
      return {
        candidates: [{ absPath: abs, relPath: rel, size: stat.size, mtime: stat.mtimeMs }],
        completed: true,
      }
    }
    const result = discover({ ...baseOptions, roots: this.options.roots })
    return { candidates: result.candidates, completed: result.completed }
  }

  private scopePrefix(target: string): string | null {
    const abs = isAbsolute(target) ? target : resolve(target)
    const stat = statSafe(abs)
    // Only directory scopes participate in deletion pruning.
    if (!stat || !stat.isDirectory()) return null
    return normalizeSlash(ensureTrailingSlash(abs))
  }

  // --------------------------------------------------------------------------
  // Querying
  // --------------------------------------------------------------------------

  /** Hybrid (or single-mode) retrieval with RRF fusion. */
  async query(request: QueryOptions): Promise<QueryResult> {
    this.ensureOpen()
    const started = Date.now()
    const query = (request.query ?? '').trim()
    const mode = request.mode ?? this.options.search.mode
    const topK = clampInt(request.topK ?? this.options.search.topK, 1, MAX_HITS)
    const minScore = request.minScore ?? this.options.search.minScore
    const db = this.db!

    const empty = (used: Array<'lexical' | 'semantic'> = []): QueryResult => ({
      query,
      mode,
      used,
      hits: [],
      total: 0,
      tookMs: Date.now() - started,
      degraded: this.isSemanticIntended(mode) && !this.semanticUsable,
    })
    if (!query) return empty()

    const tokens = tokenize(query, { cjkN: this.options.tokenizerCjkN }).unique
    const match = buildMatchQuery(query, { cjkN: this.options.tokenizerCjkN, matchOp: this.options.search.matchOp })
    const provider = await this.resolveProvider()
    const semanticUsable = provider !== null && this.options.embedding.provider !== 'none'

    const nextUsed: Array<'lexical' | 'semantic'> = []
    let lexicalRanks: RankedHit[] = []
    let semanticRanks: RankedHit[] = []

    const wantLexical = mode === 'lexical' || mode === 'auto' || (mode === 'semantic' && !semanticUsable)
    const wantSemantic = mode === 'semantic' || (mode === 'auto' && semanticUsable)

    if (wantLexical && match) {
      const fetchLimit = clampInt(topK * 30, 200, 5000)
      lexicalRanks = toRanks(db.searchLexical(match, fetchLimit))
      nextUsed.push('lexical')
    }
    if (wantSemantic && provider) {
      const ranks = await this.semanticSearch(provider, query, topK)
      if (ranks) {
        semanticRanks = ranks
        nextUsed.push('semantic')
      }
    }

    const fused = fuseRanks(lexicalRanks, semanticRanks, {
      k: this.options.search.rrfK,
      semanticWeight: this.options.search.semanticWeight,
    })
    const pooled = fused.filter((entry) => entry.score >= minScore).slice(0, topK)

    const docs = new Map(db.listDocuments().map((doc) => [doc.id, doc]))
    const highlightTokens = preferLongTokens(tokens)
    const snippetChars = request.snippetChars ?? this.options.snippetChars
    const hits: Hit[] = []
    for (const entry of pooled) {
      const seg = db.getSegment(entry.segId)
      if (!seg) continue
      const doc = docs.get(seg.docId)
      if (!doc) continue
      const snippet = makeSnippet(seg.content, highlightTokens, {
        snippetChars,
        highlight: request.highlight ?? this.options.search.highlight,
      }).snippet
      hits.push({
        id: entry.segId,
        docId: seg.docId,
        path: doc.path,
        title: doc.title,
        line: seg.line,
        content: seg.content,
        snippet,
        score: entry.score,
        from: entry.from,
      })
    }

    // "degraded" means a requested mode was unavailable (e.g. the optional
    // embedding package is missing) — NOT that a query simply found nothing.
    const degraded = !semanticUsable && (mode === 'semantic' || (mode === 'auto' && this.options.embedding.provider !== 'none'))

    return {
      query,
      mode,
      used: nextUsed,
      hits,
      total: hits.length,
      tookMs: Date.now() - started,
      degraded,
    }
  }

  private get semanticUsable(): boolean {
    return this.providerReady && this.provider !== null
  }

  private isSemanticIntended(mode: QueryMode): boolean {
    if (mode === 'semantic') return true
    return mode === 'auto' && this.options.embedding.provider !== 'none'
  }

  private async semanticSearch(provider: EmbeddingProvider, query: string, topK: number): Promise<RankedHit[] | null> {
    const db = this.db!
    try {
      const queryVector = (await provider.embed([query]))[0]
      if (!queryVector || queryVector.length === 0) return null

      // The zero-dependency `ngram` embedder is a bag-of-tokens baseline: two
      // unrelated texts that share common characters still get a non-trivial
      // cosine, so without a guard every query would return fabricated top-K
      // hits. For this provider we restrict semantic candidates to segments
      // that actually share a token with the query (the baseline behaves as a
      // reranker). Neural providers (`transformers`) are not gated: real
      // semantics is exactly what they are for.
      let gate: Set<number> | null = null
      if (this.options.embedding.provider === 'ngram') {
        const match = buildMatchQuery(query, { cjkN: this.options.tokenizerCjkN, matchOp: 'or' })
        gate = match
          ? new Set(db.searchLexical(match, clampInt(topK * 200, 1000, 20000)).map((hit) => hit.segId))
          : new Set<number>()
      }

      const scored: Array<{ segId: number; sim: number }> = []
      const cap = this.options.capacity.maxEmbeddedSegments
      let count = 0
      for (const { segId, vec } of db.iterateEmbeddings()) {
        count++
        if (count > cap) break
        // Skip vectors from a different embedding dimension so reopening with
        // a new `dim` cannot yield garbage cosine scores.
        if (vec.length !== queryVector.length) continue
        if (gate && !gate.has(segId)) continue
        scored.push({ segId, sim: cosineSim(queryVector, vec) })
      }
      if (scored.length === 0) return null
      scored.sort((a, b) => b.sim - a.sim)
      return toRanks(scored.slice(0, clampInt(topK * 30, 200, 5000)))
    } catch (error) {
      this.log('warn', `semantic search failed: ${messageOf(error)}`)
      return null
    }
  }

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  /** Full or incremental rebuild (serialized). */
  reindex(request: ScanRequest): Promise<ScanReport> {
    return this.runExclusive(() => this.reindexUnlocked(request))
  }

  /** The reindex body; must be reached through `runExclusive`. */
  private async reindexUnlocked(request: ScanRequest): Promise<ScanReport> {
    this.ensureOpen()
    const db = this.db!
    if (request.full) {
      if (request.path) {
        // Full rebuild scoped to a subtree: clear that subtree only, so files
        // outside the scope are not silently lost.
        const prefix = this.scopePrefix(request.path)
        if (prefix) {
          const scoped = db.listDocuments().filter((doc) => normalizeSlash(doc.path).startsWith(prefix))
          // `deleteDocument` opens its own transaction per document.
          for (const doc of scoped) db.deleteDocument(doc.id)
        }
      } else {
        db.clear()
      }
      this.lastScannedAt = null
    }
    const report = await this.runScan({ force: true, path: request.path })
    if (request.full) report.mode = 'full'
    return report
  }

  async stats(): Promise<IndexStats> {
    this.ensureOpen()
    const db = this.db!
    return {
      dbPath: db.path,
      dbBytes: db.fileSize(),
      docs: db.countDocuments(),
      segments: db.countSegments(),
      embedded: db.countEmbeddings(),
      roots: [...this.options.roots],
      userVersion: db.userVersion,
      schemaVersion: SCHEMA_VERSION_REF,
      lastScannedAt: this.lastScannedAt,
    }
  }

  /**
   * Watch roots for changes and reconcile on a debounce.
   *
   * Uses `fs.watch(root, { recursive: true })` where the platform supports it
   * and falls back to a low-frequency polling scan otherwise (e.g. Linux).
   */
  watch(onScan?: (report: ScanReport) => void): { close: () => void } {
    const watchers: FSWatcher[] = []
    const timers: Array<NodeJS.Timeout> = []
    let pending = false
    let closing = false

    const schedule = (): void => {
      if (pending || closing) return
      pending = true
      const timer = setTimeout(() => {
        pending = false
        this.scan()
          .then((report) => onScan?.(report))
          .catch((error) => this.log('error', `watch scan failed: ${messageOf(error)}`))
      }, this.options.watchDebounceMs ?? 1500)
      timers.push(timer)
    }

    for (const root of this.options.roots) {
      const abs = resolveRoot(root)
      if (!abs || !existsSync(abs)) continue
      try {
        const watcher = fsWatch(abs, { recursive: true }, schedule)
        watchers.push(watcher)
      } catch {
        // recursive watch unsupported → rely on the polling fallback below
      }
    }

    if (watchers.length === 0) {
      const timer = setInterval(() => schedule(), (this.options.watchDebounceMs ?? 1500) * 4)
      timers.push(timer)
    }

    return {
      close: () => {
        closing = true
        for (const watcher of watchers) watcher.close()
        for (const timer of timers) clearTimeout(timer)
        timers.length = 0
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.provider?.dispose()
    this.provider = null
    this.providerReady = false
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  '.cache/',
  '.next/',
  '.nuxt/',
  '.output/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  '*.pyc',
  '*.pyo',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.o',
  '*.obj',
  'Thumbs.db',
  '.docindex/',
] as const

const SCHEMA_VERSION_REF = 1

function readFileSafe(path: string): { data: Buffer; size: number } | null {
  try {
    const stat = statSync(path)
    return { data: readFileSync(path), size: stat.size }
  } catch {
    return null
  }
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function baseNameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash >= 0 ? path.slice(slash + 1) : path
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Normalize a path for string prefix comparisons: slash-separated and, on
 * case-insensitive filesystems (Windows/Darwin convention), lowercase.
 */
function normalizeSlash(path: string): string {
  const slashed = toSlash(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? slashed.toLowerCase() : slashed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Prefer the longer query tokens for highlighting; fall back to unigrams. */
function preferLongTokens(tokens: string[]): string[] {
  const long = tokens.filter((token) => charLen(token) >= 2)
  return long.length > 0 ? long : tokens
}
