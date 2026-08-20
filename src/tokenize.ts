/**
 * CJK-aware tokenization with zero dependencies.
 *
 * FTS5's built-in `unicode61` tokenizer treats an unbroken CJK sequence as a
 * single token (there is no whitespace), which makes Chinese full-text search
 * useless. We therefore pre-tokenize text into a run of tokens — CJK n-grams
 * plus lowercased latin/digit words — joined by spaces. Both the index side
 * and the query side run through the same tokenizer, so matches line up.
 *
 * Example (`cjkN = 2`): `你好，world` → `你 好 你好 world`
 */
import { isIdeoUnit } from './util.ts'

export type CjkMode = 1 | 2 | 3

export interface TokenizeOptions {
  /** CJK n-gram depth: emit unigrams plus bigrams/trigrams when >= 2. */
  cjkN?: CjkMode
  /** Lowercase latin words before emission (default true). */
  lower?: boolean
}

export interface TokenizeResult {
  /** All emitted tokens, duplicates preserved (term frequency matters). */
  tokens: string[]
  /** Unique tokens in first-seen order (useful for queries / highlighting). */
  unique: string[]
  /** The `cjkN` value that was actually applied. */
  cjkN: CjkMode
}

const WORD_REGEXP = /\p{L}|\p{N}/u

function isWordChar(ch: string): boolean {
  return WORD_REGEXP.test(ch)
}

/**
 * Tokenize text into CJK n-grams and latin/digit words.
 *
 * Runs of ideographs emit one unigram per character plus overlapping bigrams
 * (and trigrams when `cjkN = 3`). Runs of latin letters/digits emit a single
 * lowercased word token. Everything else acts as a separator.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): TokenizeResult {
  const cjkN: CjkMode = (options.cjkN ?? 2) as CjkMode
  const lower = options.lower ?? true

  const tokens: string[] = []
  const unique: string[] = []
  const seen = new Set<string>()

  const emit = (token: string): void => {
    if (!token) return
    tokens.push(token)
    if (!seen.has(token)) {
      seen.add(token)
      unique.push(token)
    }
  }

  let ideoBuffer = ''
  let wordBuffer = ''

  const flushIdeo = (): void => {
    if (!ideoBuffer) return
    const chars = Array.from(ideoBuffer)
    // Unigrams first, then overlapping bigrams / trigrams.
    for (const ch of chars) emit(ch)
    if (cjkN >= 2) {
      for (let i = 0; i + 1 < chars.length; i++) emit(chars[i]! + chars[i + 1]!)
    }
    if (cjkN >= 3) {
      for (let i = 0; i + 2 < chars.length; i++) emit(chars[i]! + chars[i + 1]! + chars[i + 2]!)
    }
    ideoBuffer = ''
  }

  const flushWord = (): void => {
    if (!wordBuffer) return
    const token = lower ? wordBuffer.toLowerCase() : wordBuffer
    wordBuffer = ''
    emit(token)
  }

  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (isIdeoUnit(code)) {
      flushWord()
      ideoBuffer += ch
      continue
    }
    if (isWordChar(ch)) {
      flushIdeo()
      wordBuffer += ch
      continue
    }
    flushIdeo()
    flushWord()
  }
  flushIdeo()
  flushWord()

  return { tokens, unique, cjkN }
}

/**
 * Produce the space-joined token stream stored in the FTS5 index.
 * The result contains only letters/digits/CJK n-grams, so it is safe to feed
 * into a `unicode61` FTS5 column.
 */
export function tokenizeForIndex(text: string, options: TokenizeOptions = {}): string {
  return tokenize(text, options).tokens.join(' ')
}

/**
 * Query tokens used for FTS5 MATCH construction. Prefer the longest tokens
 * (CJK bigrams / words) which are the most discriminating.
 */
export function tokenizeQuery(text: string, options: TokenizeOptions = {}): string[] {
  return tokenize(text, options).unique
}

/**
 * One contiguous token run from `splitRuns`: a CJK/ideographic character run
 * or a latin/digit word run.
 */
export type TextRun = { kind: 'ideo'; chars: string[] } | { kind: 'word'; text: string }

/**
 * Split text into classification runs (ideographic runs and word runs).
 * Separators (whitespace/punctuation) split runs but produce no run of their
 * own. This mirrors the scanning used by `tokenize` so query construction can
 * reason about CJK runs instead of a flat token list.
 */
export function splitRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  let ideo: string[] = []
  let word = ''

  const flushWord = (): void => {
    if (word) {
      runs.push({ kind: 'word', text: word })
      word = ''
    }
  }
  const flushIdeo = (): void => {
    if (ideo.length > 0) {
      runs.push({ kind: 'ideo', chars: ideo })
      ideo = []
    }
  }

  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (isIdeoUnit(code)) {
      flushWord()
      ideo.push(ch)
      continue
    }
    if (isWordChar(ch)) {
      flushIdeo()
      word += ch
      continue
    }
    flushIdeo()
    flushWord()
  }
  flushIdeo()
  flushWord()
  return runs
}

/**
 * Build an FTS5 MATCH expression from query tokens.
 *
 * CJK runs are matched with `OR` across the run's n-grams (so a query such as
 * 苹果手机 matches documents containing 苹果 *or* 手机), while runs/words are
 * combined with an explicit operator (`AND` by default, `OR` when `matchOp:
 * 'or'`). Using an explicit `AND` between a parenthesized OR-group and another
 * term is required: FTS5 rejects implicit (space) adjacency next to a
 * parenthesis, so `(a OR b) "c"` is a syntax error while `(a OR b) AND "c"`
 * is valid. Long Chinese queries therefore never over-constrain nor crash.
 *
 * The n-grams emitted mirror the index-side tokenizer for the same `cjkN`:
 * unigrams-only when `cjkN === 1` (the index stores no bigrams then), and
 * bigrams (+trigrams at `cjkN === 3`) when `cjkN >= 2`.
 *
 * Returns `null` when there is nothing to match on.
 */
export function buildMatchQuery(
  query: string,
  options: TokenizeOptions & { matchOp?: 'and' | 'or' } = {},
): string | null {
  const cjkN = (options.cjkN ?? 2) as CjkMode
  const runs = splitRuns(query).filter((run) => (run.kind === 'word' ? run.text.length > 0 : run.chars.length > 0))
  if (runs.length === 0) return null

  const quote = (token: string): string => `"${token.replace(/"/g, '""')}"`
  const groups: string[] = []

  for (const run of runs) {
    if (run.kind === 'word') {
      const term = options.lower === false ? run.text : run.text.toLowerCase()
      groups.push(quote(term))
      continue
    }
    const chars = run.chars
    if (chars.length === 1) {
      groups.push(quote(chars[0]!))
      continue
    }
    const terms: string[] = []
    if (cjkN === 1) {
      // The index stores only unigrams for this depth.
      for (const ch of chars) terms.push(ch)
    } else {
      for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i]! + chars[i + 1]!)
      if (cjkN >= 3) {
        for (let i = 0; i + 2 < chars.length; i++) terms.push(chars[i]! + chars[i + 1]! + chars[i + 2]!)
      }
    }
    if (terms.length === 1) {
      groups.push(quote(terms[0]!))
    } else {
      groups.push(`(${terms.map(quote).join(' OR ')})`)
    }
  }

  const sep = options.matchOp === 'or' ? ' OR ' : ' AND '
  return groups.join(sep)
}

