import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuseRanks, toRanks, rrfContribution } from '../src/rank.ts'

test('rank: single-mode ranking mirrors input order', () => {
  const fused = fuseRanks(toRanks([{ segId: 10 }, { segId: 20 }, { segId: 30 }]), [], { semanticWeight: 0 })
  assert.deepEqual(fused.map((f) => f.segId), [10, 20, 30])
  assert.deepEqual(fused.map((f) => f.from), [['lexical'], ['lexical'], ['lexical']])
  assert.ok(fused[0]!.score > fused[1]!.score)
})

test('rank: RRF boosts items present in both lists', () => {
  const lexical = toRanks([{ segId: 1 }, { segId: 2 }, { segId: 3 }])
  const semantic = toRanks([{ segId: 2 }, { segId: 3 }, { segId: 9 }])
  const fused = fuseRanks(lexical, semantic, { semanticWeight: 0.5 })
  const ids = fused.map((f) => f.segId)
  // segId 2 is rank 1 in both → should dominate.
  assert.equal(ids[0], 2)
  // segId 3 is in both lists, segId 1 only lexical → 3 ahead.
  assert.ok(ids.indexOf(3) < ids.indexOf(1))
  const two = fused.find((f) => f.segId === 2)!
  assert.deepEqual(two.from.sort(), ['lexical', 'semantic'])
})

test('rank: weights change the winner when ranks diverge', () => {
  const lexical = toRanks([{ segId: 1 }, { segId: 2 }])
  const semantic = toRanks([{ segId: 2 }, { segId: 1 }])
  const lexHeavy = fuseRanks(lexical, semantic, { semanticWeight: 0.1 })
  const semHeavy = fuseRanks(lexical, semantic, { semanticWeight: 0.9 })
  assert.deepEqual(lexHeavy.map((f) => f.segId).slice(0, 2), [1, 2])
  assert.deepEqual(semHeavy.map((f) => f.segId).slice(0, 2), [2, 1])
})

test('rank: scores normalize into (0, 1] and shared hits rank first', () => {
  const fused = fuseRanks(toRanks([{ segId: 1 }, { segId: 2 }]), toRanks([{ segId: 2 }]))
  for (const f of fused) {
    assert.ok(f.score > 0 && f.score <= 1)
  }
  assert.equal(fused[0]!.segId, 2, 'an item ranked in both lists beats lexical-only')
})

test('rank: empty inputs produce no results', () => {
  assert.deepEqual(fuseRanks([], []), [])
})

test('rank: rrfContribution uses the standard reciprocal form', () => {
  assert.equal(rrfContribution(1, 60), 1 / 61)
  assert.equal(rrfContribution(2, 60), 1 / 62)
})

test('rank: a non-positive or fractional k falls back to the default', () => {
  const identity = { segId: 1 }
  const small = fuseRanks(toRanks([identity]), [], { semanticWeight: 0, k: 0 })
  const negative = fuseRanks(toRanks([identity]), [], { semanticWeight: 0, k: -5 })
  const fractional = fuseRanks(toRanks([identity]), [], { semanticWeight: 0, k: 0.5 })
  const expected = fuseRanks(toRanks([identity]), [], { semanticWeight: 0 })
  assert.deepEqual(small, expected)
  assert.deepEqual(negative, expected)
  assert.deepEqual(fractional, expected)
})
