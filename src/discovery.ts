/**
 * Workspace document discovery.
 *
 * Walks each configured root directory depth-first and yields candidate files
 * that pass the ignore rules, hidden-file policy, size limits and walk caps.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { SkipReason } from './types.ts'
import type { IgnorePattern } from './ignore.ts'
import { isIgnored } from './ignore.ts'
import { toSlash } from './util.ts'

export interface CandidateFile {
  /** Absolute path on disk. */
  absPath: string
  /** Workspace-relative slash form (used for ignoring, display and dedupe). */
  relPath: string
  /** Size in bytes (from the directory listing). */
  size: number
  /** Modification time in ms (used for incremental change detection). */
  mtime: number
}

export interface DiscoverOptions {
  roots: readonly string[]
  ignore: readonly IgnorePattern[]
  includeHidden: boolean
  followSymlinks: boolean
  /** Hard cap on the number of candidate files emitted per scan. */
  maxFiles: number
  /** Maximum directory depth below a root (0 = unlimited). */
  maxDepth?: number
  /** Skip any file larger than this many bytes. */
  maxFileBytes: number
  /** Called when a file is rejected; used to collect skip statistics. */
  onSkip?: (reason: SkipReason, relPath: string) => void
}

export interface DiscoverResult {
  candidates: CandidateFile[]
  skipped: number
  /**
   * False when the walk stopped early because it hit a cap (`maxFiles` or the
   * examined-files budget). Callers must not prune documents not present in
   * `candidates` when the scan was truncated, or existing files would be
   * deleted just because the walk never reached them.
   */
  completed: boolean
}

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** Normalize a root specifier to an absolute directory path or `null`. */
export function resolveRoot(root: string): string | null {
  const abs = isAbsolute(root) ? root : resolve(root)
  try {
    const stat = statSync(abs)
    if (!stat.isDirectory()) return null
    return abs
  } catch {
    return null
  }
}

/**
 * Walk all roots and collect candidate files.
 *
 * The walk is synchronous and bounded: it stops when `maxFiles` files have
 * been collected or `maxFiles` scan steps were consumed, whichever first.
 */
export function discover(options: DiscoverOptions): DiscoverResult {
  const candidates: CandidateFile[] = []
  let skipped = 0
  let examined = 0
  let truncated = false

  // Whether anything is left to process: more entries in the current dir,
  // pending subdirectories on the stack, or additional roots.
  const hasMoreWork = (ei: number, entriesLength: number, stackLength: number, ri: number): boolean =>
    ei < entriesLength - 1 || stackLength > 0 || ri < options.roots.length - 1

  for (let ri = 0; ri < options.roots.length; ri++) {
    // Resolved realpaths of directories already descended into within THIS
    // root, to break symlink cycles before they can exhaust the scan budget.
    // Per-root so that overlapping root pairs (parent + child) don't make the
    // child appear to be an already-visited symlink target.
    const walkedReal: Set<string> = new Set()

    const absRoot = resolveRoot(options.roots[ri]!)
    if (!absRoot) {
      // A root we cannot resolve means this scan did not cover its subtree;
      // treat the walk as incomplete so callers must not prune under it.
      options.onSkip?.('missing-root', toSlash(options.roots[ri]!))
      skipped++
      truncated = true
      continue
    }
    const stack: Array<{ dir: string; depth: number }> = [{ dir: absRoot, depth: 0 }]
    while (stack.length > 0 && candidates.length < options.maxFiles && examined < options.maxFiles * 4) {
      const { dir, depth } = stack.pop()!
      if (options.maxDepth && depth >= options.maxDepth) continue
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        // A subscript we cannot list means the walk did not see its contents —
        // same class of failure as a missing root. Mark the walk incomplete so
        // the prune pass cannot delete indexed documents under it.
        options.onSkip?.('error', toSlash(dir))
        skipped++
        truncated = true
        continue
      }
      // Natural ordering keeps scans deterministic.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (let ei = 0; ei < entries.length; ei++) {
        const entry = entries[ei]!
        examined++
        if (examined >= options.maxFiles * 4) {
          if (ei < entries.length - 1 || stack.length > 0 || ri < options.roots.length - 1) truncated = true
          break
        }
        const name = entry.name
        if (options.includeHidden === false && isHidden(name)) {
          options.onSkip?.('hidden', name)
          skipped++
          continue
        }
        const absPath = join(dir, name)
        const relPath = toSlash(relativeFromRoot(absRoot, absPath))
        let isDir = entry.isDirectory()
        let isSymlink = entry.isSymbolicLink()

        if (isSymlink) {
          if (!options.followSymlinks) {
            options.onSkip?.('symlink', relPath)
            skipped++
            continue
          }
          // Resolve what the symlink points to (cycles are detected below).
          try {
            isDir = statSync(absPath).isDirectory()
          } catch {
            options.onSkip?.('error', relPath)
            skipped++
            continue
          }
        }

        const matched = isIgnored(relPath, isDir, options.ignore)
        if (matched.ignored) {
          options.onSkip?.('ignored', relPath)
          skipped++
          continue
        }

        if (isDir) {
          // Prevent re-walking into an already-visited target (symlink cycles).
          let real = absPath
          try {
            real = realpathSync(absPath)
          } catch {
            options.onSkip?.('error', relPath)
            skipped++
            truncated = true
            continue
          }
          if (walkedReal.has(real)) {
            options.onSkip?.('symlink', relPath)
            skipped++
            continue
          }
          walkedReal.add(real)
          stack.push({ dir: absPath, depth: depth + 1 })
          continue
        }
        if (!entry.isFile() && !isSymlink) continue
        let st
        try {
          st = statSync(absPath)
        } catch {
          options.onSkip?.('error', relPath)
          skipped++
          continue
        }
        if (st.size > options.maxFileBytes) {
          options.onSkip?.('too-large', relPath)
          skipped++
          continue
        }
        candidates.push({ absPath, relPath, size: st.size, mtime: st.mtimeMs })
        if (candidates.length >= options.maxFiles) {
          truncated = hasMoreWork(ei, entries.length, stack.length, ri)
          break
        }
      }
      if (truncated) break
    }
    if (truncated) break
  }
  return { candidates, skipped, completed: !truncated }
}

/** Relative slash path of `full` under `root` (assumes both absolute). */
function relativeFromRoot(root: string, full: string): string {
  return toSlash(relative(root, full))
}
