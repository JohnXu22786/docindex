import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocIndexEngine } from '../src/engine.ts'
import { makeWorkspace, cleanup, writeWorkspaceFile, removeWorkspaceFile, touch } from './helpers.ts'

function makeEngine(dir: string) {
  return new DocIndexEngine({
    dbPath: ':memory:',
    roots: [dir],
    excludes: [],
    includeHidden: false,
    followSymlinks: false,
    capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 2000 },
    tokenizerCjkN: 2,
    segmentChars: 400,
    snippetChars: 240,
    search: { topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
    embedding: { provider: 'ngram', dim: 256 },
    textExtensions: [],
  })
}

test('incremental: second scan reports everything unchanged', async () => {
  const dir = makeWorkspace({ 'a.md': 'aaa', 'b.md': 'bbb' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const second = await engine.scan()
    assert.equal(second.indexed, 0)
    assert.equal(second.updated, 0)
    assert.equal(second.unchanged, 2)
    assert.equal(second.removed, 0)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('incremental: modified file is updated in place', async () => {
  const dir = makeWorkspace({ 'a.md': 'old content' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    writeWorkspaceFile(dir, 'a.md', 'new brand NEWTERM content')
    touch(dir, 'a.md', Date.now() + 60_000)
    const report = await engine.scan()
    assert.equal(report.updated, 1)
    assert.equal(report.indexed, 0)
    const result = await engine.query({ query: 'NEWTERM', mode: 'lexical' })
    assert.equal(result.hits.length, 1)
    // Old term is gone from the index.
    const old = await engine.query({ query: 'old', mode: 'lexical' })
    assert.equal(old.hits.length, 0)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('incremental: new file is indexed, deleted file is pruned', async () => {
  const dir = makeWorkspace({ 'a.md': 'alpha', 'gone.md': 'delete me later' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    assert.equal((await engine.stats()).docs, 2)

    writeWorkspaceFile(dir, 'fresh.md', 'brand new file')
    touch(dir, 'fresh.md', Date.now() + 60_000)
    let report = await engine.scan()
    assert.equal(report.indexed, 1)

    removeWorkspaceFile(dir, 'gone.md')
    report = await engine.scan()
    assert.equal(report.removed, 1)
    assert.equal((await engine.stats()).docs, 2)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('incremental: scoped scan of a subdirectory only touches that subtree', async () => {
  const dir = makeWorkspace({
    'src/a.md': 'alpha',
    'docs/b.md': 'beta',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    writeWorkspaceFile(dir, 'src/c.md', 'gamma')
    touch(dir, 'src/c.md', Date.now() + 60_000)
    writeWorkspaceFile(dir, 'docs/d.md', 'delta ignored by scope')
    touch(dir, 'docs/d.md', Date.now() + 60_000)

    const report = await engine.scan({ path: `${dir}/src`.replace(/\\/g, '/') })
    assert.equal(report.indexed, 1)
    // docs/d.md was not indexed because the scope did not include it.
    assert.equal((await engine.stats()).docs, 3)
  } finally {
    engine.close()
    cleanup(dir)
  }
})
