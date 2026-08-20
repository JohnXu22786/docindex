import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocIndexEngine } from '../src/engine.ts'
import type { EngineOptions } from '../src/engine.ts'
import { NgramEmbedder, cosineSim, createEmbeddingProvider } from '../src/embedding.ts'
import { makeWorkspace, cleanup } from './helpers.ts'

const base: Omit<EngineOptions, 'roots' | 'embedding'> = {
  dbPath: ':memory:',
  excludes: [],
  includeHidden: false,
  followSymlinks: false,
  capacity: { maxDocs: 100, maxSegments: 5000, maxEmbeddedSegments: 2000, maxFileBytes: 5e6, maxDepth: 64, maxWalkedFiles: 2000 },
  tokenizerCjkN: 2,
  segmentChars: 400,
  snippetChars: 240,
  search: { topK: 10, minScore: 0, mode: 'auto', highlight: true, matchOp: 'and', rrfK: 60, semanticWeight: 0.5 },
  textExtensions: [],
}

test('no-model: explicit none provider yields lexical-only search without degradation flag', async () => {
  const dir = makeWorkspace({ 'a.md': 'alpha beta gamma' })
  const engine = new DocIndexEngine({ ...base, roots: [dir], embedding: { provider: 'none' } })
  try {
    await engine.scan()
    const stats = await engine.stats()
    assert.equal(stats.embedded, 0)
    const result = await engine.query({ query: 'beta' })
    assert.ok(!result.used.includes('semantic'))
    assert.equal(result.degraded, false, 'configured none is the intended setup, not a degradation')
    assert.equal(result.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('no-model: transformers provider without the package degrades to lexical', async () => {
  const dir = makeWorkspace({ 'a.md': 'requested neural semantic but no package installed' })
  const engine = new DocIndexEngine({
    ...base,
    roots: [dir],
    embedding: { provider: 'transformers', model: 'Xenova/bge-small-en-v1.5' },
  })
  try {
    await engine.scan()
    const stats = await engine.stats()
    assert.equal(stats.embedded, 0, 'no embeddings can be produced without the package')
    const result = await engine.query({ query: 'neural semantic' })
    assert.ok(result.used.includes('lexical'), 'fallback performs lexical search')
    assert.equal(result.degraded, true, 'semantic was intended but unavailable')
    assert.equal(result.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('ngram embedder: deterministic dimensions, normalized, cosine works', async () => {
  const provider = await createEmbeddingProvider({ provider: 'ngram', dim: 128 })
  assert.equal(provider.dim, 128)
  const [a, b, c] = await provider.embed(['hello world', 'hello world again', 'completely unrelated'])
  assert.equal(a!.length, 128)
  assert.ok(Math.abs(1 - magnitude(a!)) < 1e-3, 'vectors are L2 normalized')
  // Cosine of identical text is ~1; unrelated is lower.
  const [self] = await provider.embed(['hello world'])
  assert.ok(cosineSim(a!, self!) > 0.999)
  assert.ok(cosineSim(a!, b!) > cosineSim(a!, c!))
})

test('ngram gate: a query sharing no tokens returns no fabricated semantic hits', async () => {
  const dir = makeWorkspace({ 'a.md': '关于密码学与信息安全的内容。', 'b.md': 'the policy reward model' })
  const engine = new DocIndexEngine({ ...base, roots: [dir], embedding: { provider: 'ngram', dim: 256 } })
  try {
    await engine.scan()
    const result = await engine.query({ query: 'zzqqxkwv', mode: 'semantic' })
    assert.equal(result.hits.length, 0, 'no token overlap must not yield noise hits')
    // And auto mode stays clean too, while a real query still works.
    const auto = await engine.query({ query: 'zzqqxkwv' })
    assert.equal(auto.hits.length, 0)
    const real = await engine.query({ query: 'policy reward', mode: 'semantic' })
    assert.equal(real.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('ngram embedder: rejects bad dimension config', async () => {
  await assert.rejects(
    () => createEmbeddingProvider({ provider: 'ngram', dim: 3 }),
    /embedding\.dim/,
  )
})

function magnitude(v: Float32Array): number {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum)
}

test('NgramEmbedder: embeds empty texts without error', async () => {
  const embedder = new NgramEmbedder({ provider: 'ngram', dim: 64 })
  const vectors = await embedder.embed(['', '   ', 'text'])
  assert.equal(vectors.length, 3)
  assert.ok(vectors[2]!.some((x) => x !== 0))
  embedder.dispose()
})
