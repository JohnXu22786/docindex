import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSnippet, buildMatchRegex, applyHighlight, highlightText } from '../src/highlight.ts'

test('highlight: astral characters before the match do not clip the word', () => {
  const content = '😀😀😀😀😀 needle sits in the haystack content'
  const { snippet } = makeSnippet(content, ['needle'], { snippetChars: 12, highlight: true })
  assert.match(snippet, /\*\*needle\*\*/, 'the matched word stays whole and marked')
  assert.ok(!snippet.includes('\uFFFD'), 'no replacement chars from split surrogates')
})

test('highlight: long content is truncated with ellipses around the match', () => {
  const content = 'a '.repeat(200) + 'very unique token needle ' + 'b '.repeat(200)
  const { snippet, truncated } = makeSnippet(content, ['needle'], { snippetChars: 120, highlight: true })
  assert.equal(truncated, true)
  assert.ok(snippet.startsWith('…'))
  assert.match(snippet, /\*\*needle\*\*/)
})

test('highlight: short content is returned whole without truncation', () => {
  const { snippet, truncated } = makeSnippet('just a short needle here', ['needle'], { snippetChars: 240 })
  assert.equal(truncated, false)
  assert.match(snippet, /\*\*needle\*\*/)
})

test('highlight: highlighting disabled leaves no markers', () => {
  const { snippet } = makeSnippet('find the needle in this line', ['needle'], { snippetChars: 240, highlight: false })
  assert.ok(!snippet.includes('**'))
})

test('highlight: buildMatchRegex is case-insensitive and longest-first', () => {
  const re = buildMatchRegex(['needle', 'need'])
  assert.ok(re!.test('A very NEEDLE here'))
  const m = 'needle'.match(re!)
  assert.equal(m![0], 'needle', 'longer alternative wins over shorter')
})

test('highlight: applyHighlight wraps every occurrence', () => {
  const out = applyHighlight('one two one', buildMatchRegex(['one']), '**')
  assert.equal(out, '**one** two **one**')
})

test('highlight: highlightText with marker none returns content unchanged', () => {
  assert.equal(highlightText('needle here', ['needle'], 'none'), 'needle here')
})
