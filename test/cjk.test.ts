import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocIndexEngine } from '../src/engine.ts'
import type { EngineOptions } from '../src/engine.ts'
import { makeWorkspace, cleanup } from './helpers.ts'

function makeEngine(dir: string, overrides: Partial<EngineOptions> = {}) {
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
    ...overrides,
  })
}

test('cjk: Chinese keyword query finds the matching document', async () => {
  const dir = makeWorkspace({
    'zh.md': '# 中文文档\n\n你好世界，这是一段关于语义检索的中文正文。\n我们讨论向量数据库与倒排索引。',
    'en.md': 'some english document about nothing in particular',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: '语义检索' })
    assert.ok(result.hits.length >= 1)
    assert.match(result.hits[0]!.path, /zh\.md$/)
    assert.match(result.hits[0]!.snippet, /语义/)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: multi-word Chinese query matches a compound phrase', async () => {
  const dir = makeWorkspace({ 'a.md': '重阳节的习俗包括赏菊与登高远望。', 'b.md': '春节是全家团圆的节日。' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: '重阳 登高' })
    assert.match(result.hits[0]!.path, /a\.md$/)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: multi-term compound query matches documents containing either part', async () => {
  // 苹果手机 as one CJK run must NOT require the contiguous substring.
  const dir = makeWorkspace({
    'a.md': '这里讨论苹果的品种与种植。',
    'b.md': '新款手机已经发布并且性价比很高。',
    'c.md': '苹果手机使用体验非常流畅。',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: '苹果手机', mode: 'lexical' })
    const paths = result.hits.map((hit) => hit.path)
    // a.md (苹果) and b.md (手机) and c.md (both) should all appear.
    assert.ok(paths.some((p) => /a\.md$/.test(p)), 'doc containing 苹果 matches')
    assert.ok(paths.some((p) => /b\.md$/.test(p)), 'doc containing 手机 matches')
    assert.ok(paths.some((p) => /c\.md$/.test(p)), 'doc containing the full compound matches')
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: parenthesized OR group combined with another run is valid FTS5', async () => {
  const dir = makeWorkspace({
    'a.md': '苹果手机是一款产品，同时支持无线充电 world。',
    'b.md': '只有 world 出现。',
  })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    // Previously threw "fts5: syntax error" via `(a OR b) "c"` adjacency.
    const result = await engine.query({ query: '苹果手机 world', mode: 'lexical' })
    assert.ok(result.hits.length >= 1)
    assert.match(result.hits[0]!.path, /a\.md$/)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: cjkN=1 index and query stay consistent (unigrams only)', async () => {
  const dir = makeWorkspace({ 'a.md': '你好世界，程序的世界。' })
  const engine = makeEngine(dir, { tokenizerCjkN: 1 })
  try {
    await engine.scan()
    const result = await engine.query({ query: '你好', mode: 'lexical' })
    assert.equal(result.hits.length, 1, 'unigram-only index is still searchable')
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: single character query still retrieves', async () => {
  const dir = makeWorkspace({ 'a.md': '风从哪里来呢？' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const result = await engine.query({ query: '风', mode: 'lexical' })
    assert.equal(result.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})

test('cjk: mixed Chinese+English query works in both modes', async () => {
  const dir = makeWorkspace({ 'a.md': '语义嵌入 vector embedding 与 BM25 的混合检索' })
  const engine = makeEngine(dir)
  try {
    await engine.scan()
    const lexical = await engine.query({ query: 'BM25 混合', mode: 'lexical' })
    assert.equal(lexical.hits.length, 1)
    const semantic = await engine.query({ query: 'vector embedding', mode: 'semantic' })
    assert.equal(semantic.hits.length, 1)
  } finally {
    engine.close()
    cleanup(dir)
  }
})
