/**
 * Index capacity limits and skip accounting.
 *
 * These knobs bound how much the index may grow locally: maximum documents,
 * maximum stored segments, maximum embedded chunks, per-file size, walk depth
 * and the total number of files examined per scan.
 */
import type { SkipCounts, SkipReason } from './types.ts'

export interface CapacityLimits {
  /** Maximum documents kept in the index. */
  maxDocs: number
  /** Maximum stored text segments across all documents. */
  maxSegments: number
  /** Maximum segments that receive an embedding vector. */
  maxEmbeddedSegments: number
  /** Skip files larger than this (bytes). */
  maxFileBytes: number
  /** Maximum directory depth below a root (0 = unlimited). */
  maxDepth: number
  /** Hard cap on candidate files examined per scan. */
  maxWalkedFiles: number
}

export const DEFAULT_CAPACITY: CapacityLimits = {
  maxDocs: 20000,
  maxSegments: 300000,
  maxEmbeddedSegments: 50000,
  maxFileBytes: 5 * 1024 * 1024,
  maxDepth: 64,
  maxWalkedFiles: 200000,
}

/** Tally skipped files per reason for reporting. */
export class SkipTracker {
  readonly counts: SkipCounts = {}

  add(reason: SkipReason, path?: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1
    if (path) this.example = this.example ?? path
  }

  /** First skipped path (useful for diagnostics). */
  example: string | undefined

  total(): number {
    let sum = 0
    for (const value of Object.values(this.counts)) sum += value
    return sum
  }
}
