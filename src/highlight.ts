/**
 * Query-term highlighting and snippet generation.
 *
 * Snippets are windowed around the first matched term, then the matched terms
 * are wrapped with a caller-chosen marker (`**bold**` by default). Highlighting
 * is optional; when disabled the snippet is still truncated.
 */
import { charLen, charSlice, escapeRegExp } from './util.ts'

export interface SnippetOptions {
  snippetChars: number
  marker?: string
  highlight?: boolean
}

export interface Snippet {
  snippet: string
  truncated: boolean
}

/**
 * Build a regex matching any of the given tokens, longest first.
 *
 * Case-insensitive because the index lowercases latin words for matching while
 * the original casing stays in the document text, so we must highlight either.
 * Returns `null` for an empty token list.
 */
export function buildMatchRegex(tokens: readonly string[]): RegExp | null {
  const uniques = [...new Set(tokens)].filter((token) => token.length > 0)
  if (uniques.length === 0) return null
  // Sort by length descending so longer phrases win over single characters.
  uniques.sort((a, b) => b.length - a.length)
  return new RegExp(uniques.map(escapeRegExp).join('|'), 'gi')
}

/** Wrap every match of `re` in `content` with `marker…marker`. */
export function applyHighlight(content: string, re: RegExp | null, marker = '**'): string {
  if (!re) return content
  return content.replace(re, (match) => `${marker}${match}${marker}`)
}

/**
 * Produce a (possibly truncated) snippet around the first token match.
 */
export function makeSnippet(content: string, tokens: readonly string[], options: SnippetOptions): Snippet {
  const { snippetChars, marker = '**', highlight = true } = options
  const re = buildMatchRegex(tokens)
  const text = content.replace(/\s*\n\s*/g, ' ').trim()

  if (charLen(text) <= snippetChars) {
    const snippet = highlight ? applyHighlight(text, re, marker) : text
    return { snippet, truncated: false }
  }

  // `RegExp.exec().index` is a UTF-16 code-unit offset, but the windowing math
  // below works in code points — convert so astral characters (emoji, CJK Ext
  // B) before the match cannot misalign or split a surrogate pair.
  let matchCp = -1
  if (re) {
    re.lastIndex = 0
    const first = re.exec(text)
    if (first) matchCp = charLen(text.slice(0, first.index))
    re.lastIndex = 0
  }

  const windowChars = snippetChars
  const lead = Math.floor(windowChars / 3)
  let start = matchCp >= 0 ? matchCp - lead : 0
  if (start < 0) start = 0
  let end = start + windowChars
  if (end > charLen(text)) {
    end = charLen(text)
    start = Math.max(0, end - windowChars)
  }

  const prefix = start > 0 ? '…' : ''
  const suffix = end < charLen(text) ? '…' : ''
  const window = charSlice(text, start, end)
  const body = highlight ? applyHighlight(window, re, marker) : window
  return { snippet: `${prefix}${body}${suffix}`, truncated: true }
}

/**
 * Highlight without truncation (used by tools for full-segment display).
 * Returns the content with matched tokens marked; `marker: 'none'` disables.
 */
export function highlightText(content: string, tokens: readonly string[], marker = '**'): string {
  if (marker === 'none') return content
  return applyHighlight(content, buildMatchRegex(tokens), marker)
}
