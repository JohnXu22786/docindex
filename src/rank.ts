/**
 * Reciprocal Rank Fusion for combining lexical (FTS5 bm25) and semantic
 * (cosine) result lists.
 *
 * Each retrieval mode produces a ranked list of segment ids; RRF merges the
 * ranks with `score = Σ 1/(k + rank)`. The fused score is normalized to [0,1]
 * by dividing by the theoretical best single-mode score at rank 1.
 */
export interface RankedHit {
  segId: number
  rank: number
}

export interface FuseOptions {
  /** RRF constant (standard value 60). */
  k?: number
  /** Weight multiplying the semantic RRF contribution (lexical gets 1-w). */
  semanticWeight?: number
}

export interface FusedResult {
  segId: number
  /** Normalized combined RRF score in [0, 1]. */
  score: number
  /** Which modes contributed. */
  from: Array<'lexical' | 'semantic'>
}

const DEFAULT_K = 60

/** RRF contribution of one rank. */
export function rrfContribution(rank: number, k: number): number {
  return 1 / (k + rank)
}

/**
 * Fuse two ranked lists into a single ordered result set.
 *
 * @param lexical - ranked segment ids from the lexical retrieval (best first).
 * @param semantic - ranked segment ids from the semantic retrieval (best first).
 */
export function fuseRanks(
  lexical: readonly RankedHit[] = [],
  semantic: readonly RankedHit[] = [],
  options: FuseOptions = {},
): FusedResult[] {
  // `k` is the RRF smoothing constant; require k >= 1 so a non-positive or
  // fractional k cannot inflate (or invert) every contribution.
  const k = options.k === undefined || !Number.isFinite(options.k) || options.k < 1 ? DEFAULT_K : options.k
  const wSem = clampUnit(options.semanticWeight ?? 0.5)
  const wLex = 1 - wSem

  const combined = new Map<number, { score: number; from: Set<'lexical' | 'semantic'> }>()
  for (const hit of lexical) {
    const entry = entryFor(combined, hit.segId)
    entry.score += wLex * rrfContribution(hit.rank, k)
    entry.from.add('lexical')
  }
  for (const hit of semantic) {
    const entry = entryFor(combined, hit.segId)
    entry.score += wSem * rrfContribution(hit.rank, k)
    entry.from.add('semantic')
  }

  const bestPossible = wLex * rrfContribution(1, k) + wSem * rrfContribution(1, k)
  const results: FusedResult[] = []
  for (const [segId, entry] of combined) {
    results.push({
      segId,
      score: bestPossible > 0 ? entry.score / bestPossible : 0,
      from: [...entry.from],
    })
  }
  results.sort((a, b) => b.score - a.score)
  return results
}

/** Rank a scored list (best scorer gets rank 1); ties share order. */
export function toRanks(scored: readonly { segId: number }[]): RankedHit[] {
  return scored.map((hit, index) => ({ segId: hit.segId, rank: index + 1 }))
}

function entryFor(map: Map<number, { score: number; from: Set<'lexical' | 'semantic'> }>, segId: number) {
  let entry = map.get(segId)
  if (!entry) {
    entry = { score: 0, from: new Set() }
    map.set(segId, entry)
  }
  return entry
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}
