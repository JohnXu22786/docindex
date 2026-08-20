import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocIndexEngine } from '../src/engine.ts'
import { makeWorkspace, cleanup } from './helpers.ts'

function makeEngine(dir: string, capacity: Partial<{ maxDocs: number; maxSegments: number; maxFileBytes: number }>) {
  return new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: {
      maxDocs: capacity.maxDocs ?? 100,
      maxSegments: capacity.maxSegments ?? 5000,
      maxEmbeddedSegments: 2000,
      maxFileBytes: capacity.maxFileBytes ?? 5e6,
      maxDepth: 64,
      maxWalkedFiles: 2000,
    },
    tokenizerCjkN: 2,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
}

test('capacity: maxDocs stops indexing new documents', async () => {
  const dir = makeWorkspace({ 'a.md': 'aaa', 'b.md': 'bbb', 'c.md': 'ccc' })
  const engine = makeEngine(dir, { maxDocs: 2 })
  try {
    const report = await engine.scan()
    assert.equal(report.indexed, 2)
    assert.equal(report.skipped['max-docs'], 1)
    assert.equal((await engine.stats()).docs, 2)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('capacity: maxFileBytes skips oversized entries', async () => {
  const dir = makeWorkspace({ 'small.md': 'ok', 'big.md': 'x'.repeat(500) })
  const engine = makeEngine(dir, { maxFileBytes: 100 })
  try {
    const report = await engine.scan()
    assert.equal(report.indexed, 1)
    assert.equal(report.skipped['too-large'], 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('capacity: maxSegments stops adding segments once the budget is gone', async () => {
  const dir = makeWorkspace({ 'a.md': 'one two three' })
  const engine = makeEngine(dir, { maxSegments: 1 })
  try {
    const report = await engine.scan()
    assert.equal(report.indexed, 1)
    assert.ok((await engine.stats()).segments <= 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('capacity: exclude patterns from engine options skip matched files', async () => {
  const dir = makeWorkspace({ 'keep.md': 'keep', 'vendor/lib.js': 'skip', 'tmp/x.log': 'skip' })
  const engine = new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: ['vendor/', '*.log'],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 2000 },
    tokenizerCjkN: 2,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
  try {
    const report = await engine.scan()
    assert.equal(report.indexed, 1)
    assert.equal(report.skipped['ignored'] ?? 0, 2)
  } finally {
    engine.close()
    cleanup(dir)
  }
})
