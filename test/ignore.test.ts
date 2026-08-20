import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compilePatterns, isIgnored, DEFAULT_EXCLUDES } from '../src/ignore.ts'

const pattern = (list: readonly string[]) => compilePatterns(list)

test('ignore: default excludes cover node_modules and .git subtrees', () => {
  const p = pattern(DEFAULT_EXCLUDES)
  assert.equal(isIgnored('node_modules/@scope/pkg/src/index.js', false, p).ignored, true)
  assert.equal(isIgnored('.git/objects/deadbeef', false, p).ignored, true)
  assert.equal(isIgnored('docs/readme.md', false, p).ignored, false)
})

test('ignore: basename pattern matches at any depth', () => {
  const p = pattern(['*.log'])
  assert.equal(isIgnored('a.log', false, p).ignored, true)
  assert.equal(isIgnored('deep/nested/b.log', false, p).ignored, true)
  assert.equal(isIgnored('c.txt', false, p).ignored, false)
})

test('ignore: directory-only pattern ignores the subtree', () => {
  const p = pattern(['build/'])
  assert.equal(isIgnored('build', true, p).ignored, true)
  assert.equal(isIgnored('build/app.js', false, p).ignored, true)
  assert.equal(isIgnored('build.files/app.js', false, p).ignored, false)
})

test('ignore: anchored pattern binds to the root', () => {
  const p = pattern(['/notes.md'])
  assert.equal(isIgnored('notes.md', false, p).ignored, true)
  assert.equal(isIgnored('sub/notes.md', false, p).ignored, false)
})

test('ignore: negation re-includes after a positive match', () => {
  const p = pattern(['dist/', '!dist/keep.md'])
  assert.equal(isIgnored('dist/other.md', false, p).ignored, true)
  assert.equal(isIgnored('dist/keep.md', false, p).ignored, false)
})

test('ignore: ** crosses slashes, * does not', () => {
  const p = pattern(['docs/**/changelog.md', 'tmp/*.txt'])
  assert.equal(isIgnored('docs/a/b/changelog.md', false, p).ignored, true)
  assert.equal(isIgnored('tmp/a.txt', false, p).ignored, true)
  assert.equal(isIgnored('tmp/sub/a.txt', false, p).ignored, false)
})

test('ignore: comments and blanks are skipped', () => {
  const p = pattern(['# comment', '', '   ', '*.md'])
  assert.equal(isIgnored('readme.md', false, p).ignored, true)
  assert.equal(isIgnored('readme.txt', false, p).ignored, false)
})

test('ignore: explicit extra patterns are honored alongside defaults', () => {
  const p = pattern([...DEFAULT_EXCLUDES, 'vendor/', 'secret.*'])
  assert.equal(isIgnored('vendor/lib/x.js', false, p).ignored, true)
  assert.equal(isIgnored('secret.env', false, p).ignored, true)
  assert.equal(isIgnored('node_modules/x', false, p).ignored, true)
})
