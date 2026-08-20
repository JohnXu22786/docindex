import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discover, resolveRoot } from '../src/discovery.ts'
import { compilePatterns, DEFAULT_EXCLUDES } from '../src/ignore.ts'
import { makeWorkspace, cleanup } from './helpers.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function discoverWith(roots: string[], overrides: Partial<Parameters<typeof discover>[0]> = {}) {
  const skip: string[] = []
  const result = discover({
    roots,
    ignore: compilePatterns(DEFAULT_EXCLUDES),
    includeHidden: false,
    followSymlinks: false,
    maxFiles: 1000,
    maxFileBytes: 1024 * 1024,
    onSkip: (reason, path) => skip.push(`${reason}:${path}`),
    ...overrides,
  })
  return { ...result, skip }
}

test('discovery: excludes node_modules, .git, dist and hidden files', () => {
  const dir = makeWorkspace({
    'readme.md': 'x',
    'node_modules/pkg/index.js': 'x',
    '.git/HEAD': 'x',
    'docs/guide.md': 'x',
  })
  try {
    const { candidates, skip } = discoverWith([dir])
    const paths = candidates.map((c) => c.relPath).sort()
    assert.deepEqual(paths, ['docs/guide.md', 'readme.md'])
    assert.ok(skip.some((s) => s.startsWith('ignored:')))
  } finally {
    cleanup(dir)
  }
})

test('discovery: size cap skips oversized files', () => {
  const dir = makeWorkspace({ 'big.md': 'x'.repeat(100), 'small.md': 'ok' })
  try {
    const { candidates, skip } = discoverWith([dir], { maxFileBytes: 50 })
    assert.deepEqual(candidates.map((c) => c.relPath), ['small.md'])
    assert.ok(skip.some((s) => s.startsWith('too-large:')))
  } finally {
    cleanup(dir)
  }
})

test('discovery: maxFiles bounds the scan', () => {
  const dir = makeWorkspace({})
  try {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    const { candidates } = discoverWith([dir], { maxFiles: 5 })
    assert.ok(candidates.length <= 5)
  } finally {
    cleanup(dir)
  }
})

test('discovery: relative roots resolve to absolute dirs', () => {
  const dir = makeWorkspace({ 'a.md': 'x' })
  try {
    assert.equal(resolveRoot(dir), dir)
  } finally {
    cleanup(dir)
  }
})

test('discovery: missing root is reported and skipped', () => {
  const { candidates, skip } = discoverWith(['C:/definitely-not-here-docindex'], {})
  assert.equal(candidates.length, 0)
  assert.ok(skip.some((s) => s.startsWith('missing-root:')))
})
