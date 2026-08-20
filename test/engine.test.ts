import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocIndexEngine } from '../src/engine.ts'
import type { EngineOptions } from '../src/engine.ts'
import { makeWorkspace, cleanup, writeWorkspaceFile, touch } from './helpers.ts'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeEngine(dir: string, overrides: Partial<EngineOptions> = {}): DocIndexEngine {
  return new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: {
      maxDocs: 100,
      maxSegments: 5000,
      maxEmbeddedSegments: 2000,
      maxFileBytes: 5 * 1024 * 1024,
      maxDepth: 64,
      maxWalkedFiles: 2000,
    },
    tokenizerCjkN: 2,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'ngram', dim: 256 },
    textExtensions: [],
    ...overrides,
  })
}

test('engine: scan + query lexical roundtrip with path/line/snippet/score', async () => {
  const dir = makeWorkspace({
    'notes.md': '# Notes\n\nQuantum computers brew coffee.\nThe coffee is hot.',
  })
  const engine = makeEngine(dir)
  try {
    const report = await engine.scan()
    assert.equal(report.indexed, 1)
    assert.equal(report.errorsTotal, 0)

    const result = await engine.query({ query: 'quantum coffee', mode: 'lexical' })
    assert.ok(result.hits.length >= 1)
    const hit = result.hits[0]!
    assert.match(hit.path, /notes\.md$/)
    assert.equal(hit.line, 1)
    assert.match(hit.snippet, /\*\*[Qq]uantum\*\*/)
    assert.ok(hit.score > 0 && hit.score <= 1)
    assert.ok(result.used.includes('lexical'))
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: semantic search returns the correct top hit', async () => {
  const dir = makeWorkspace({
    'target.md': '# Target\n\nthe quick brown fox jumps over the lazy dog',
    'other.md': 'unrelated content about cooking pasta al dente',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: 'lazy dog jumps', mode: 'semantic' })
    assert.ok(result.hits.length >= 1)
    assert.match(result.hits[0]!.path, /target\.md$/)
    assert.ok(result.used.includes('semantic'))
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: hybrid mode fuses lexical and semantic', async () => {
  const dir = makeWorkspace({ 'a.md': 'hello hybrid world', 'b.md': 'something else entirely' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: 'hybrid world' })
    assert.ok(result.used.includes('lexical'))
    assert.ok(result.used.includes('semantic'))
    assert.match(result.hits[0]!.path, /a\.md$/)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: line numbers survive long documents with small segments', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the test document`)
  lines[39] = 'the UNIQUE target on its own line'
  const dir = makeWorkspace({ 'big.md': lines.join('\n') })
  const engine = makeEngine(dir, { segmentChars: 60 })
  try {
    await engine.scan()
    const result = await engine.query({ query: 'UNIQUE target', mode: 'lexical' })
    const hit = result.hits.find((h) => h.content.includes('UNIQUE'))
    assert.ok(hit, 'expected a hit containing the unique term')
    assert.equal(hit!.line, 40)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: query with highlight disabled has no markup', async () => {
  const dir = makeWorkspace({ 'a.md': 'find this needle in the haystack' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: 'needle', mode: 'lexical', highlight: false })
    assert.ok(!result.hits[0]!.snippet.includes('**'))
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: stats reflect counts and index size', async () => {
  const dir = makeWorkspace({ 'a.md': 'one', 'b.txt': 'two' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const stats = await engine.stats()
    assert.equal(stats.docs, 2)
    assert.ok(stats.segments >= 2)
    assert.equal(stats.embedded, stats.segments, 'ngram provider embeds every segment')
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: persistence across reopen saves and restores docs', async () => {
  const dir = makeWorkspace({ 'persist.md': 'persisted content here' })
  const dbPath = `${dir}/index.db`
  const opts = {
    roots: [dir],
    dbPath,
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 2000 },
    tokenizerCjkN: 2 as const,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto' as const, highlight: true, matchOp: 'and' as const, rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'ngram' as const, dim: 256 },
    textExtensions: [],
  }
  const a = new DocIndexEngine(opts)
  await a.scan()
  a.close()
  const b = new DocIndexEngine(opts)
  try {
    const stats = await b.stats()
    assert.equal(stats.docs, 1)
    assert.ok(stats.dbBytes > 0)
    const result = await b.query({ query: 'persisted' })
    assert.equal(result.hits.length, 1)
  } finally {
    b.close()
    cleanup(dir)
  }
})

test('engine: reindex full clears then rebuilds', async () => {
  const dir = makeWorkspace({ 'a.md': 'alpha', 'b.md': 'beta' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    writeWorkspaceFile(dir, 'c.md', 'gamma')
    const full = await engine.reindex({ full: true })
    assert.equal(full.mode, 'full')
    const stats = await engine.stats()
    assert.equal(stats.docs, 3)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: empty query returns an empty result set', async () => {
  const dir = makeWorkspace({ 'a.md': 'alpha' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: '   ' })
    assert.equal(result.hits.length, 0)
    assert.equal(result.total, 0)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: topK bounds results and minScore filters', async () => {
  const dir = makeWorkspace({
    'a.md': 'common common common shared',
    'b.md': 'common common shared weird',
    'c.md': 'common shared xyzzy',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const limited = await engine.query({ query: 'shared', topK: 2, mode: 'lexical' })
    assert.ok(limited.hits.length <= 2)
    const filtered = await engine.query({ query: 'shared', mode: 'lexical', minScore: 0.99 })
    assert.ok(filtered.hits.length < limited.hits.length)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: touch with unchanged content still detects change when mtime differs', async () => {
  const dir = makeWorkspace({ 'a.md': 'same content' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    touch(dir, 'a.md', Date.now() + 60_000)
    const again = await engine.scan()
    assert.equal(again.updated, 1, 'an mtime change forces an update')
    assert.equal(again.indexed, 0)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: one corrupt file never aborts the whole scan', async () => {
  const dir = makeWorkspace({ 'good.md': 'good content with term', 'ok.txt': 'another file' })
  // A broken DOCX (invalid package) and a broken PDF marker both must be
  // skipped individually, not crash the loop.
  writeFileSync(join(dir, 'broken.docx'), Buffer.from('this is not a real zip archive'))
  writeFileSync(join(dir, 'fake.pdf'), Buffer.from('%PDF-1.4 not really a pdf..............'))
  const engine = makeEngine(dir)
  try {
    const report = await engine.scan()
    assert.ok(report.indexed >= 2)
    assert.equal(report.skipped['unsupported'], 1)
    const result = await engine.query({ query: 'term', mode: 'lexical' })
    assert.equal(result.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: truncated walk does not prune documents it never reached', async () => {
  const dir = makeWorkspace({ 'z-important.md': 'the important needle doc' })
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `a-${i}.md`), `filler content ${i}`)
  const dbPath = join(dir, 'index.db')

  const base = {
    roots: [dir],
    dbPath,
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    tokenizerCjkN: 2 as const,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto' as const, highlight: true, matchOp: 'and' as const, rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' as const },
    textExtensions: [],
  }

  // Full index with a generous walk cap.
  const full = new DocIndexEngine({ ...base, capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 5000 } })
  await full.scan()
  assert.equal((await full.stats()).docs, 21)
  full.close()

  // A truncated rescan (tiny cap) must NOT delete the docs it couldn't see.
  const cramped = new DocIndexEngine({ ...base, capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 6 } })
  try {
    const report = await cramped.scan()
    assert.equal(report.removed, 0, 'truncated scans must not prune')
    assert.equal((await cramped.stats()).docs, 21)
    const query = await cramped.query({ query: 'important', mode: 'lexical' })
    assert.equal(query.hits.length, 1, 'the doc beyond the walk cap is still queryable')
  } finally {
    cramped.close()
    cleanup(dir)
  }
})

test('engine: scoped scan prunes deleted files with native (backslash) paths', async () => {
  const dir = makeWorkspace({ 'sub/gone.md': 'gone from scope', 'other/keep.md': 'stays' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    rmSync(join(dir, 'sub', 'gone.md'), { force: true })
    // Pass the native path form (backslashes on Windows) as the scope.
    const report = await engine.scan({ path: join(dir, 'sub') })
    assert.equal(report.removed, 1)
    assert.equal((await engine.stats()).docs, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: explicit oversized file target honors the size cap', async () => {
  const dir = makeWorkspace({})
  writeFileSync(join(dir, 'huge.md'), 'x'.repeat(500))
  const capped = new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 10, maxSegments: 500, maxEmbeddedSegments: 50, maxFileBytes: 10, maxDepth: 64, maxWalkedFiles: 100 },
    tokenizerCjkN: 2,
    segmentChars: 200,
    snippetChars: 120,
    search: { topK: 5, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
  try {
    const report = await capped.scan({ path: join(dir, 'huge.md') })
    assert.equal(report.indexed, 0)
    assert.equal(report.skipped['too-large'], 1)
  } finally {
    capped.close()
    cleanup(dir)
  }
})

test('engine: exact-boundary walk still prunes (completed stays true)', async () => {
  const dir = makeWorkspace({ 'a.md': 'aaa', 'b.md': 'bbb', 'c.md': 'ccc' })
  // maxWalkedFiles exactly equals the file count.
  const engine = new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 10, maxSegments: 500, maxEmbeddedSegments: 50, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 3 },
    tokenizerCjkN: 2,
    segmentChars: 200,
    snippetChars: 120,
    search: { topK: 5, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
  try {
    await engine.scan()
    rmSync(join(dir, 'b.md'), { force: true })
    const report = await engine.scan()
    assert.equal(report.removed, 1, 'a complete walk at the exact boundary still prunes')
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('engine: a missing root disables pruning (no data loss on transient failure)', async () => {
  const dir = makeWorkspace({ 'keep.md': 'keep me', 'bye.md': 'delete me' })
  const engine = new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir, 'C:/definitely-not-here-docindex'],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 2000 },
    tokenizerCjkN: 2,
    segmentChars: 200,
    snippetChars: 120,
    search: { topK: 5, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
  try {
    await engine.scan()
    assert.equal((await engine.stats()).docs, 2)
    rmSync(join(dir, 'bye.md'), { force: true })
    const report = await engine.scan()
    assert.equal(report.skipped['missing-root'], 1)
    assert.equal(report.removed, 0, 'an incomplete scan must not prune healthy-root docs')
    assert.equal((await engine.stats()).docs, 2)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('capacity: updates at the segment cap do not freeze', async () => {
  const dir = makeWorkspace({ 'a.md': 'a' })
  const engine = new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 10, maxSegments: 1, maxEmbeddedSegments: 50, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 100 },
    tokenizerCjkN: 2,
    segmentChars: 3,
    snippetChars: 120,
    search: { topK: 5, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'none' },
    textExtensions: [],
  })
  try {
    await engine.scan()
    assert.equal((await engine.stats()).segments, 1)
    writeWorkspaceFile(dir, 'a.md', 'a\nb')
    touch(dir, 'a.md', Date.now() + 60_000)
    const report = await engine.scan()
    assert.equal(report.updated, 1, 'an existing doc can still be refreshed at the cap')
    assert.ok((await engine.stats()).segments <= 1)
    assert.equal(report.skipped['max-segments'], 1, 'truncated insert is reported, not silent')
  } finally {
    engine.close()
    cleanup(dir)
  }
})
