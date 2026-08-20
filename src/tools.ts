/**
 * dsh model-facing tools: `doc_scan`, `doc_query`, `doc_reindex`, `doc_stats`.
 *
 * These are thin wrappers over the engine's methods, formatted for an agent.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ScanReport, QueryResult, IndexStats } from './types.ts'
import { formatBytes } from './util.ts'

/** The engine surface the tools need (kept small and stable for testing). */
export interface DocIndexHandle {
  scan(request?: { path?: string; force?: boolean }): Promise<ScanReport>
  query(request: { query: string; topK?: number; mode?: 'auto' | 'lexical' | 'semantic'; highlight?: boolean; snippetChars?: number; minScore?: number }): Promise<QueryResult>
  reindex(request?: { path?: string; full?: boolean }): Promise<ScanReport>
  stats(): Promise<IndexStats>
}

/** Standard text output used by every tool here. */
const TEXT_OUTPUT = { type: 'string' } as const

const textBlock = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

function formatScanReport(report: ScanReport): string {
  const skipped = Object.entries(report.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ')
  const lines: string[] = [
    `scan ${report.mode} complete in ${report.tookMs}ms`,
    `scanned: ${report.scanned}  indexed: ${report.indexed}  updated: ${report.updated}  unchanged: ${report.unchanged}  removed: ${report.removed}`,
  ]
  if (skipped) lines.push(`skipped: ${skipped}`)
  for (const error of report.errors) lines.push(`error: ${error.path}: ${error.message}`)
  if (report.errorsTotal > 0) lines.push(`${report.errorsTotal} error(s) total`)
  return lines.join('\n')
}

function formatStats(stats: IndexStats): string {
  const embedding = stats.embedded > 0 ? `  embedded: ${stats.embedded}` : ''
  return [
    `documents: ${stats.docs}`,
    `segments: ${stats.segments}${embedding}`,
    `index size: ${formatBytes(stats.dbBytes)}`,
    `roots: ${stats.roots.join(', ') || '(none)'}`,
    `db: ${stats.dbPath}`,
  ].join('\n')
}

function formatQuery(result: QueryResult): string {
  if (result.hits.length === 0) {
    return `no results for "${result.query}"${result.degraded ? ' (semantic search degraded, lexical only)' : ''}`
  }
  const header = result.degraded
    ? `results for "${result.query}" [${result.used.join('+')}, semantic degraded]`
    : `results for "${result.query}" [${result.used.join('+')}]`
  const lines = [header]
  for (const hit of result.hits) {
    lines.push(`${hit.score.toFixed(3)}  ${hit.path}  L${hit.line}`)
    lines.push(hit.snippet.replace(/\s*\n\s*/g, ' ').trim())
  }
  return lines.join('\n')
}

/** Build the four tool definitions bound to an engine handle. */
export function createDocTools(engine: DocIndexHandle) {
  return [
    defineTool({
      name: 'doc_scan',
      description:
        'Scan the indexed workspace for documents. Indexes new files, refreshes changed files, and prunes removed ones (incremental; pass path to target a subdirectory).',
      parameters: {
        path: { type: 'string', description: 'Optional subdirectory or file to scan instead of the whole workspace.' },
        force: { type: 'boolean', description: 'Re-index even files whose metadata is unchanged.' },
      },
      output: { schema: TEXT_OUTPUT, render: (_args, value: string) => textBlock(value) },
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          return formatScanReport(await engine.scan({ path: args.path, force: args.force }))
        } catch (error) {
          return `doc_scan failed: ${messageOf(error)}`
        }
      },
    }),
    defineTool({
      name: 'doc_query',
      description:
        'Search the local document index (BM25 lexical + optional local embeddings, fused with RRF). Returns matching segments with file path, line number, snippet and score.',
      parameters: {
        query: { type: 'string', required: true, description: 'Natural language or keyword query.' },
        topK: { type: 'integer', description: 'Maximum number of hits to return (1–50).' },
        mode: { type: 'string', enum: ['auto', 'lexical', 'semantic'] as const, description: 'auto = hybrid, lexical = BM25 only, semantic = embeddings only.' },
        highlight: { type: 'boolean', description: 'Wrap matched terms with **markers** (default true).' },
        snippetChars: { type: 'integer', description: 'Max snippet length in characters.' },
      },
      output: { schema: TEXT_OUTPUT, render: (_args, value: string) => textBlock(value) },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          return formatQuery(await engine.query({ query: args.query, topK: args.topK, mode: args.mode, highlight: args.highlight, snippetChars: args.snippetChars }))
        } catch (error) {
          return `doc_query failed: ${messageOf(error)}`
        }
      },
    }),
    defineTool({
      name: 'doc_reindex',
      description: 'Rebuild the document index. Without `full`, re-runs an incremental scan with force; with `full`, clears the index and rebuilds from scratch.',
      parameters: {
        path: { type: 'string', description: 'Optional subdirectory or file to re-index.' },
        full: { type: 'boolean', description: 'Clear the whole index and rebuild from scratch.' },
      },
      output: { schema: TEXT_OUTPUT, render: (_args, value: string) => textBlock(value) },
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          return formatScanReport(await engine.reindex({ path: args.path, full: args.full }))
        } catch (error) {
          return `doc_reindex failed: ${messageOf(error)}`
        }
      },
    }),
    defineTool({
      name: 'doc_stats',
      description: 'Report index statistics: document/segment/embedding counts, index size and scan sources.',
      parameters: {},
      output: { schema: TEXT_OUTPUT, render: (_args, value: string) => textBlock(value) },
      isConcurrencySafe: () => true,
      async execute() {
        try {
          return formatStats(await engine.stats())
        } catch (error) {
          return `doc_stats failed: ${messageOf(error)}`
        }
      },
    }),
  ]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
