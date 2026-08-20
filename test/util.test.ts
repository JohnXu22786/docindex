import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  charLen,
  charSlice,
  defaultDbPath,
  dshHome,
  fnv1a,
  formatBytes,
  toSlash,
} from '../src/util.ts'

test('util: charLen counts code points, not UTF-16 units (surrogate aware)', () => {
  assert.equal(charLen('abc'), 3)
  assert.equal(charLen('你好'), 2)
  assert.equal(charLen('a😀b'), 3, 'a surrogate pair counts as one character')
})

test('util: charSlice never splits a surrogate pair', () => {
  const text = 'a😀b'
  assert.equal(charSlice(text, 0, 1), 'a')
  assert.equal(charSlice(text, 1, 2), '😀')
  assert.equal(charSlice(text, 0, 2), 'a😀')
  assert.equal(charSlice(text, 1, 3), '😀b')
})

test('util: toSlash normalizes Windows separators', () => {
  assert.equal(toSlash('a\\b\\c.md'), 'a/b/c.md')
  assert.equal(toSlash('a/b/c.md'), 'a/b/c.md')
})

test('util: formatBytes renders human units', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(-1), '-1')
})

test('util: fnv1a is stable and diffuses the byte value', () => {
  assert.equal(fnv1a('docindex'), fnv1a('docindex'))
  assert.notEqual(fnv1a('docindex'), fnv1a('docIndeX'))
})

test('util: dshHome and defaultDbPath honor DOCINDEX_HOME / DSH_HOME', () => {
  assert.equal(dshHome({ DOCINDEX_HOME: 'C:\\tmp\\h' }), 'C:\\tmp\\h')
  assert.equal(dshHome({ DSH_HOME: 'C:\\tmp\\d' }), 'C:\\tmp\\d')
  assert.ok(defaultDbPath({ DOCINDEX_HOME: 'C:\\tmp\\h' }).endsWith('index.db'))
})
