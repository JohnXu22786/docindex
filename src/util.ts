/**
 * Shared low-level utilities used across the docindex bundle.
 *
 * Everything here is dependency-free (Node built-ins only).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Default harness home directory name (mirrors dsh home conventions). */
export const DSH_HOME_DIR = '.dsh'

/**
 * Resolve the dsh harness home directory.
 *
 * Precedence: `DOCINDEX_HOME` env var (test/override convenience) →
 * `DSH_HOME` env var → platform default `~/.dsh`.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DOCINDEX_HOME'] || env['DSH_HOME']
  if (explicit) return explicit
  const home = env['USERPROFILE'] || env['HOME']
  return home ? join(home, DSH_HOME_DIR) : DSH_HOME_DIR
}

/** Resolve the default SQLite database path under the harness home. */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'doc-index', 'index.db')
}

/** Number of Unicode code points in a string (UTF-16 surrogate aware). */
export function charLen(input: string): number {
  let count = 0
  for (const _ of input) count++
  return count
}

/** Slice a string by code points (never splitting surrogate pairs). */
export function charSlice(input: string, start: number, end: number): string {
  return Array.from(input).slice(start, end).join('')
}

/** Format a byte count into a human readable string. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  return `${value.toFixed(1)} ${unit}`
}

/** SHA-1 hex digest of a buffer (used to fingerprint content when `hash` mode is on). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

/** FNV-1a 32-bit hash of a string (stable across runs and platforms). */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Create a directory (and parents) if it does not already exist. */
export function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Create the parent directory of a file path if missing. */
export function ensureParentDirSync(file: string): void {
  ensureDirSync(dirname(file))
}

/** Read a file’s full content safely; returns `null` on stat/read errors. */
export function readFileSafe(path: string): { data: Buffer; size: number } | null {
  try {
    const stat = statSync(path)
    const data = readFileSync(path)
    return { data, size: stat.size }
  } catch {
    return null
  }
}

/** Escape a string for safe insertion into a regular expression. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert a POSIX/Windows path to slash-separated relative form for matching. */
export function toSlash(path: string): string {
  return path.replace(/\\/g, '/')
}

/** True when the given code unit starts an ideographic character. */
export function isIdeoUnit(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0x3040 && code <= 0x30ff) || // Kana
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility
  )
}
