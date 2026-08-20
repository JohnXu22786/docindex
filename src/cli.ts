#!/usr/bin/env node
/**
 * `docindex` CLI — the bundle’s standalone command-line interface.
 *
 * Commands mirror the dsh tools so the same engine works outside of dsh:
 *
 *   docindex scan [roots...] [--force] [--exclude pat]
 *   docindex query "<query>" [--top n] [--mode auto|lexical|semantic] [--json]
 *   docindex reindex [--full] [path?]
 *   docindex stats [--json]
 *   docindex watch
 *
 * Env overrides: `DOCINDEX_DB` (db path), `DOCINDEX_ROOTS` (path-separated).
 */
import { DocIndexEngine } from './engine.ts'
import type { EngineOptions } from './engine.ts'
import type { QueryResult, ScanReport } from './types.ts'
import { defaultDbPath, formatBytes } from './util.ts'

interface CliOptions {
  db?: string
  roots: string[]
  excludes: string[]
  json: boolean
  force: boolean
  full: boolean
  top: number
  mode: 'auto' | 'lexical' | 'semantic'
  highlight: boolean
  snippet: number
  cjkN: 1 | 2 | 3
  help: boolean
}

const USAGE = `usage: docindex <command> [options]

commands:
  scan [path]     incremental scan (index new/changed, prune removed)
  query <query>   hybrid search; prints hits with path/line/snippet/score
  reindex [path]  rebuild (--full clears the index first)
  stats           index statistics
  watch           stay running and keep the index current

options:
  --db <path>        sqlite db file (default \$DOCINDEX_DB or ~/.dsh/doc-index/index.db)
  --root <path>      workspace root (repeatable; default cwd / \$DOCINDEX_ROOTS)
  --exclude <pat>    extra ignore pattern (repeatable; gitignore style)
  --top <n>          max hits for query (1-50, default 10)
  --mode <m>         auto | lexical | semantic (default auto)
  --snippet <n>      snippet length in chars (default 240)
  --cjk <1|2|3>      CJK n-gram depth (default 2)
  --no-highlight     disable **markers** in snippets
  --force            re-index unchanged files too (scan/reindex)
  --full             clear + rebuild (reindex)
  --json             machine-readable output
  -h, --help         this help
`

function parseArgs(argv: string[]): { command: string; args: string[]; options: CliOptions } {
  const options: CliOptions = {
    db: process.env['DOCINDEX_DB'],
    roots: [],
    excludes: [],
    json: false,
    force: false,
    full: false,
    top: 10,
    mode: 'auto',
    highlight: true,
    snippet: 240,
    cjkN: 2,
    help: false,
  }
  const positionals: string[] = []
  const flags: Record<string, (value?: string) => void> = {
    '--db': (v) => (options.db = v || defaultDbPath()),
    '--root': (v) => v && options.roots.push(v),
    '--exclude': (v) => v && options.excludes.push(v),
    '--top': (v) => (options.top = clampInt(Number(v), 1, 50)),
    '--mode': (v) => {
      if (v === 'lexical' || v === 'semantic' || v === 'auto') options.mode = v
    },
    '--snippet': (v) => (options.snippet = clampInt(Number(v), 16, 4000)),
    '--cjk': (v) => {
      if (v === '1' || v === '2' || v === '3') options.cjkN = Number(v) as 1 | 2 | 3
    },
    '--json': () => (options.json = true),
    '--force': () => (options.force = true),
    '--full': () => (options.full = true),
    '--no-highlight': () => (options.highlight = false),
    '--help': () => (options.help = true),
    '-h': () => (options.help = true),
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const key = eq >= 0 ? token.slice(0, eq) : token
      if (key === '--') {
        positionals.push(...argv.slice(i + 1))
        break
      }
      const handler = flags[key]
      if (!handler) {
        console.error(`unknown option: ${key}`)
        process.exitCode = 2
        return { command: '', args: [], options }
      }
      const inline = eq >= 0 ? token.slice(eq + 1) : undefined
      const needsValue = ['--db', '--root', '--exclude', '--top', '--mode', '--snippet', '--cjk'].includes(key)
      if (needsValue && inline === undefined) {
        const value = argv[i + 1]
        if (value === undefined) {
          console.error(`missing value for ${key}`)
          process.exitCode = 2
          return { command: '', args: [], options }
        }
        handler(value)
        i++
        continue
      }
      handler(inline)
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      console.error(`unknown option: ${token}`)
      process.exitCode = 2
      return { command: '', args: [], options }
    }
    positionals.push(token)
  }

  const [command, ...rest] = positionals
  // Root defaults apply only when no explicit `--root` was given.
  if (options.roots.length === 0) {
    options.roots = splitEnv(process.env['DOCINDEX_ROOTS'], process.cwd())
  }
  return { command: command ?? '', args: rest, options }
}

function splitEnv(value: string | undefined, fallback: string): string[] {
  if (!value) return [fallback]
  return value
    .split(/[;,:]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

async function main(): Promise<void> {
  const { command, args, options } = parseArgs(process.argv.slice(2))
  if (options.help || !command) {
    console.log(USAGE)
    return
  }

  const engine = new DocIndexEngine(toEngineOptions(options))
  try {
    switch (command) {
      case 'scan': {
        const report = await engine.scan({ path: args[0], force: options.force })
        printScan(report)
        break
      }
      case 'query': {
        const query = args.join(' ') || (await readQueryFromStdin())
        const result = await engine.query({
          query,
          topK: options.top,
          mode: options.mode,
          highlight: options.highlight,
          snippetChars: options.snippet,
        })
        printQuery(result, options.json)
        break
      }
      case 'reindex': {
        const report = await engine.reindex({ path: args[0], full: options.full })
        printScan(report)
        break
      }
      case 'stats': {
        const stats = await engine.stats()
        if (options.json) {
          console.log(JSON.stringify(stats, null, 2))
        } else {
          console.log(
            [
              `documents: ${stats.docs}`,
              `segments: ${stats.segments}`,
              `embedded: ${stats.embedded}`,
              `index size: ${formatBytes(stats.dbBytes)}`,
              `roots: ${stats.roots.join(', ') || '(none)'}`,
              `db: ${stats.dbPath}`,
            ].join('\n'),
          )
        }
        break
      }
      case 'watch': {
        const disposer = engine.watch((report) => {
          console.log(
            `[docindex] +${report.indexed} ~${report.updated} -${report.removed} in ${report.tookMs}ms`,
          )
        })
        console.log(`watching ${engine.options.roots.join(', ')} (Ctrl+C to stop)`)
        process.on('SIGINT', () => {
          disposer.close()
          engine.close()
          process.exit(0)
        })
        return // keep running
      }
      default:
        console.error(`unknown command: ${command}\n${USAGE}`)
        process.exitCode = 2
    }
  } catch (error) {
    console.error(`docindex ${command} failed: ${messageOf(error)}`)
    process.exitCode = 1
  } finally {
    engine.close()
  }
}

function toEngineOptions(options: CliOptions): EngineOptions {
  return {
    dbPath: options.db || defaultDbPath(),
    roots: options.roots,
    excludes: options.excludes,
    includeHidden: false,
    followSymlinks: false,
    capacity: {
      maxDocs: 20000,
      maxSegments: 300000,
      maxEmbeddedSegments: 50000,
      maxFileBytes: 5 * 1024 * 1024,
      maxDepth: 64,
      maxWalkedFiles: 200000,
    },
    tokenizerCjkN: options.cjkN,
    segmentChars: 400,
    snippetChars: options.snippet,
    search: {
      topK: options.top,
      minScore: 0,
      mode: options.mode,
      highlight: options.highlight,
      matchOp: 'and',
      rrfK: 60,
      semanticWeight: 0.5,
    },
    embedding: { provider: 'ngram', dim: 256 },
    textExtensions: [],
    journalMode: 'wal',
  }
}

function printScan(report: ScanReport): void {
  console.log(`scanned ${report.scanned} file(s)  +${report.indexed} ~${report.updated} -${report.removed} =${report.unchanged}  in ${report.tookMs}ms`)
  const skipped = Object.entries(report.skipped).filter(([, count]) => count > 0)
  if (skipped.length > 0) {
    console.log(`skipped: ${skipped.map(([reason, count]) => `${reason}(${count})`).join(', ')}`)
  }
  for (const error of report.errors) console.error(`error: ${error.path} — ${error.message}`)
  if (report.errorsTotal > 0) console.error(`${report.errorsTotal} error(s) total`)
}

function printQuery(result: QueryResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (result.hits.length === 0) {
    console.log(`no results for "${result.query}"${result.degraded ? ' (semantic degraded)' : ''}`)
    return
  }
  console.log(`${result.hits.length} hit(s) for "${result.query}" [${result.used.join('+')}]${result.degraded ? ' (semantic degraded)' : ''}`)
  for (const hit of result.hits) {
    console.log(`  ${hit.score.toFixed(3)}  ${hit.path}  L${hit.line}  [${hit.from.join('+')}]`)
    console.log(`      ${hit.snippet.replace(/\s*\n\s*/g, ' ').trim()}`)
  }
}

/** Read a query from stdin when none was given as arguments. */
async function readQueryFromStdin(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) input += chunk as string
    return input.trim()
  }
  return ''
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main().catch((error) => {
  console.error(`docindex crashed: ${messageOf(error)}`)
  process.exitCode = 1
})
