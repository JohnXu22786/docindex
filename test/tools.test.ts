import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocTools } from '../src/tools.ts'
import type { DocIndexHandle } from '../src/tools.ts'
import type { QueryResult, ScanReport } from '../src/types.ts'

type Capture = (args: unknown) => void

interface FakeState {
  queryResult?: QueryResult
  scanReport?: ScanReport
  calls?: Capture
}

function fakeHandle(state: FakeState = {}): DocIndexHandle {
  return {
    async scan(request) {
      state.calls?.(request)
      return (
        state.scanReport ?? {
          mode: 'incremental',
          roots: [],
          scanned: 0,
          indexed: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
          skipped: {},
          errors: [],
          errorsTotal: 0,
          tookMs: 0,
        }
      )
    },
    async query(request) {
      state.calls?.(request)
      return (
        state.queryResult ?? {
          query: request.query,
          mode: 'auto',
          used: [],
          hits: [],
          total: 0,
          tookMs: 0,
          degraded: false,
        }
      )
    },
    async reindex(request) {
      state.calls?.(request)
      return (
        state.scanReport ?? {
          mode: 'full',
          roots: [],
          scanned: 0,
          indexed: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
          skipped: {},
          errors: [],
          errorsTotal: 0,
          tookMs: 0,
        }
      )
    },
    async stats() {
      return {
        dbPath: ':memory:',
        dbBytes: 0,
        docs: 1,
        segments: 2,
        embedded: 0,
        roots: [],
        userVersion: 1,
        schemaVersion: 1,
        lastScannedAt: null,
      }
    },
  }
}

const EMPTY_QUERY: QueryResult = { query: 'x', mode: 'auto', used: [], hits: [], total: 0, tookMs: 0, degraded: false }

test('tools: exposes exactly the four expected tool definitions', () => {
  const tools = createDocTools(fakeHandle())
  assert.deepEqual(tools.map((tool) => tool.name), ['doc_scan', 'doc_query', 'doc_reindex', 'doc_stats'])
})

test('tools: doc_query formats hits with path, line and highlight', async () => {
  const tools = createDocTools(
    fakeHandle({
      queryResult: {
        ...EMPTY_QUERY,
        used: ['lexical', 'semantic'],
        hits: [
          {
            id: 1,
            docId: 1,
            path: '/ws/a.md',
            title: 'a',
            line: 4,
            content: 'find a needle here',
            snippet: 'find a **needle** here',
            score: 0.981,
            from: ['lexical', 'semantic'],
          },
        ],
        total: 1,
      },
    }),
  )
  const docQuery = tools.find((t) => t.name === 'doc_query')!
  const value = (await docQuery.execute({ query: 'needle' }, execStub())) as string
  assert.match(value, /a\.md/)
  assert.match(value, /L4/)
  assert.match(value, /\*\*needle\*\*/)
})

test('tools: doc_query passes through overrides and surfaces degradation', async () => {
  const captured: unknown[] = []
  const tools = createDocTools(
    fakeHandle({
      calls: (args) => captured.push(args),
      queryResult: { ...EMPTY_QUERY, mode: 'semantic', used: ['lexical'], degraded: true },
    }),
  )
  const docQuery = tools.find((t) => t.name === 'doc_query')!
  const value = (await docQuery.execute({ query: 'semantic only', mode: 'semantic', topK: 3, highlight: false }, execStub())) as string
  assert.deepEqual(captured[0], { query: 'semantic only', mode: 'semantic', topK: 3, highlight: false, snippetChars: undefined })
  assert.match(value, /degraded/)
})

test('tools: doc_scan formats incremental counts and errors', async () => {
  const tools = createDocTools(
    fakeHandle({
      scanReport: {
        mode: 'incremental',
        roots: ['/ws'],
        scanned: 5,
        indexed: 2,
        updated: 1,
        removed: 1,
        unchanged: 1,
        skipped: { binary: 3, 'no-text-layer': 1 },
        errors: [{ path: 'broken.pdf', message: 'boom' }],
        errorsTotal: 3,
        tookMs: 42,
      },
    }),
  )
  const docScan = tools.find((t) => t.name === 'doc_scan')!
  const value = (await docScan.execute({}, execStub())) as string
  assert.match(value, /indexed: 2/)
  assert.match(value, /skipped: binary:3, no-text-layer:1/)
  assert.match(value, /error: broken.pdf/)
})

test('tools: doc_stats summarizes index state', async () => {
  const tools = createDocTools(fakeHandle())
  const docStats = tools.find((t) => t.name === 'doc_stats')!
  const value = (await docStats.execute({}, execStub())) as string
  assert.match(value, /documents: 1/)
  assert.match(value, /segments: 2/)
})

function execStub() {
  return { token: Symbol('exec'), signal: new AbortController().signal } as never
}
