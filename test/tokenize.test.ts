import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, tokenizeForIndex, buildMatchQuery } from '../src/tokenize.ts'

test('tokenize: latin words are lowercased single tokens', () => {
  const { unique } = tokenize('Hello WORLD, how are you?')
  assert.deepEqual(unique, ['hello', 'world', 'how', 'are', 'you'])
})

test('tokenize: CJK run emits unigrams and bigrams (n=2)', () => {
  const { tokens, unique } = tokenize('你好世界')
  assert.ok(tokens.includes('你'))
  assert.ok(tokens.includes('好'))
  assert.ok(tokens.includes('你好'))
  assert.ok(tokens.includes('好世'))
  assert.ok(tokens.includes('世界'))
  assert.deepEqual(unique.slice(0, 4), ['你', '好', '世', '界'])
})

test('tokenize: single-char CJK query (n=2) still emits a usable token', () => {
  const { unique } = tokenize('你')
  assert.deepEqual(unique, ['你'])
})

test('tokenize: CJK n=1 emits only unigrams', () => {
  const { tokens } = tokenize('你好', { cjkN: 1 })
  assert.ok(tokens.includes('你') && tokens.includes('好'))
  assert.ok(!tokens.some((t) => t.length > 1 && /[\u4e00-\u9fff]/.test(t)))
})

test('tokenize: CJK n=3 adds trigrams', () => {
  const { tokens } = tokenize('你好世界', { cjkN: 3 })
  assert.ok(tokens.includes('你好世') && tokens.includes('好世界'))
})

test('tokenize: mixed ideographic + latin + punctuation', () => {
  const { unique } = tokenize('语义检索（semantic）。')
  assert.ok(unique.includes('语义'))
  assert.ok(unique.includes('检索'))
  assert.ok(unique.includes('semantic'))
})

test('tokenizeForIndex: output is a safe space-joined token run', () => {
  const out = tokenizeForIndex('你好，world!')
  assert.equal(out, '你 好 你好 world')
})

test('buildMatchQuery: implicit AND joins quoted tokens with explicit AND', () => {
  assert.equal(buildMatchQuery('你好 world'), '"你好" AND "world"')
})

test('buildMatchQuery: OR joins with OR', () => {
  assert.equal(buildMatchQuery('你好 world', { matchOp: 'or' }), '"你好" OR "world"')
})

test('buildMatchQuery: CJK run makes an OR group over its bigrams', () => {
  // 苹果手机 must not over-constrain to a single contiguous substring.
  assert.equal(buildMatchQuery('苹果手机'), '("苹果" OR "果手" OR "手机")')
})

test('buildMatchQuery: a parenthesized OR group joins other runs with AND', () => {
  // FTS5 rejects `(a OR b) "c"` (space adjacency); explicit AND is required.
  assert.equal(buildMatchQuery('苹果手机 world'), '("苹果" OR "果手" OR "手机") AND "world"')
})

test('buildMatchQuery: trigram CJK (n=3) adds longer terms to the group', () => {
  assert.equal(buildMatchQuery('苹果手机', { cjkN: 3 }), '("苹果" OR "果手" OR "手机" OR "苹果手" OR "果手机")')
})

test('buildMatchQuery: cjkN=1 matches on unigrams like the index', () => {
  assert.equal(buildMatchQuery('你好', { cjkN: 1 }), '("你" OR "好")')
})

test('buildMatchQuery: single-char query falls back to that char', () => {
  assert.equal(buildMatchQuery('你'), '"你"')
})

test('buildMatchQuery: empty query is null', () => {
  assert.equal(buildMatchQuery('   !!!!   '), null)
})

test('buildMatchQuery: quote characters act as token separators', () => {
  // The tokenizer never emits `"`, so it splits the run into two tokens.
  assert.equal(buildMatchQuery('hel"lo'), '"hel" AND "lo"')
})
