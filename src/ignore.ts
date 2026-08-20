/**
 * A small gitignore-style matcher for exclusion rules.
 *
 * Supports the common subset used by document indexing:
 *   - `#` comments and blank lines
 *   - leading `!` negation (last matching pattern wins)
 *   - trailing `/` → directory-only patterns
 *   - leading `/` → anchored to the workspace root
 *   - `**`, `*`, `?` and `[...]` character classes
 *   - patterns without `/` match any path segment at any depth
 * A pattern matching an ancestor directory ignores the whole subtree.
 */

export interface IgnorePattern {
  raw: string
  regex: RegExp
  negated: boolean
  dirOnly: boolean
}

export interface IgnoreMatch {
  /** Whether the path (or one of its ancestors) is ignored overall. */
  ignored: boolean
  /** Pattern source that produced the final decision (empty when none). */
  matchedBy: string
}

const GLOB_TOKENS = new Set(['*', '?', '[', ']'])

function globToRegex(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      // `**` crosses slashes; a single `*` does not.
      if (glob[i + 1] === '*') {
        i += 2
        if (glob[i] === '/') {
          out += '(?:.*/)?'
          i++
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
        i++
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let neg = false
      if (glob[j] === '^' || glob[j] === '!') {
        neg = true
        j++
      }
      let cls = ''
      let closed = false
      while (j < glob.length) {
        const c = glob[j]!
        if (c === ']' && cls !== '') {
          closed = true
          break
        }
        cls += c === '[' || c === ']' ? `\\${c}` : c
        j++
      }
      if (closed) {
        out += `[${neg ? '^' : ''}${cls}]`
        i = j + 1
        continue
      }
      out += '\\['
      i++
      continue
    }
    if (GLOB_TOKENS.has(ch)) {
      out += `\\${ch}`
      i++
      continue
    }
    if (ch === '\\') {
      out += '\\\\'
      i++
      continue
    }
    out += /[/(){}!+@^$|.]/.test(ch) ? `\\${ch}` : ch
    i++
  }
  return out
}

/** Compile a list of raw patterns into matchable rules (in order). */
export function compilePatterns(patterns: readonly string[]): IgnorePattern[] {
  const compiled: IgnorePattern[] = []
  for (const raw of patterns) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Trailing spaces are stripped (gitignore semantics).
    line = line.replace(/\s+$/g, '')
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (!line) continue
    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    if (!line) continue

    const hasSlash = line.includes('/')
    const body = globToRegex(line)
    let source = ''
    if (anchored) {
      source = `^${body}$`
    } else if (hasSlash) {
      source = `^(?:.*/)?${body}$`
    } else {
      // Segment pattern: matches any path segment at any depth.
      source = `(?:^|/)${body}(?:/.*)?$`
    }
    compiled.push({
      raw,
      regex: new RegExp(source),
      negated,
      dirOnly,
    })
  }
  return compiled
}

/** Default patterns applied unless the caller opts out. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  '.cache/',
  '.next/',
  '.nuxt/',
  '.output/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  '*.pyc',
  '*.pyo',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.o',
  '*.obj',
  'Thumbs.db',
  '.docindex/',
]

/**
 * Test whether a workspace-relative path (slash-separated, no leading slash)
 * is ignored.
 *
 * An ancestor directory is tested as a directory so that directory-only
 * patterns (trailing `/`) and assumptions about subtrees behave like gitignore.
 */
export function isIgnored(relPath: string, isDir: boolean, patterns: readonly IgnorePattern[]): IgnoreMatch {
  if (patterns.length === 0) return { ignored: false, matchedBy: '' }
  const segments = relPath.split('/')
  if (segments.length === 0) return { ignored: false, matchedBy: '' }

  let ignored = false
  let matchedBy = ''
  // Test from root prefix down to the full path so the deepest (most
  // specific) matching prefix decides, and later rules can re-include.
  for (let i = 1; i <= segments.length; i++) {
    const candidate = segments.slice(0, i).join('/')
    const candidateIsDir = i < segments.length || isDir
    for (const pattern of patterns) {
      if (pattern.dirOnly && !candidateIsDir) continue
      if (pattern.regex.test(candidate)) {
        ignored = !pattern.negated
        matchedBy = pattern.raw
      }
    }
  }
  return { ignored, matchedBy }
}
