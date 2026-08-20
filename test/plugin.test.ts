/**
 * Verifies the bundle entry module exports the shape dsh's Loader expects:
 * a Service-subclass default export with `static inject` and `static Config`,
 * plus a stable `name`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { default as DocIndexService, name, pluginConfig } from '../src/index.ts'

test('plugin: default export is a Service subclass class', () => {
  assert.equal(typeof DocIndexService, 'function')
  assert.ok(DocIndexService.prototype, 'class has a prototype')
  assert.ok(Array.isArray((DocIndexService as { inject?: string[] }).inject), 'declares inject')
  assert.deepEqual((DocIndexService as { inject?: string[] }).inject, ['tools'])
})

test('plugin: Config is a callable schema with defaults', () => {
  const config = (DocIndexService as { Config?: (v: unknown) => unknown }).Config
  assert.ok(config, 'Config is present')
  assert.equal(typeof config, 'function')
  // Defaults are applied and enforced (schemastery validates by calling).
  const opts = (config as (v: unknown) => unknown)({})
  assert.equal((opts as { search?: { topK?: number } }).search?.topK, 10)
  assert.equal((opts as { embedding?: { provider?: string } }).embedding?.provider, 'ngram')
})

test('plugin: exports a stable name and pluginConfig alias', () => {
  assert.equal(name, 'doc-index')
  assert.equal(pluginConfig, (DocIndexService as { Config?: unknown }).Config)
})
