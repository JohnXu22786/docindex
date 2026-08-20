/**
 * Minimal PDF text-layer extraction.
 *
 * Parses object streams, inflates FlateDecode payloads with `node:zlib`, and
 * extracts the text-showing operators (`Tj`, `TJ`, `'`, `"`) plus the strings
 * they reference. This is intentionally small on purpose: it covers the common
 * "text layer present" case without pulling in a full PDF library. When no
 * usable text is found we report `hasTextLayer: false` so the caller can tell
 * the user the file needs OCR.
 *
 * Limitations (documented): embedded CID fonts with custom encodings are not
 * decoded, and glyph outlines (no text layer) yield no text.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'
import { charLen } from './util.ts'

export interface PdfExtractResult {
  text: string
  hasTextLayer: boolean
  warnings: string[]
}

const MIN_TEXT_CHARS = 8

/** Test whether a buffer looks like a PDF file. */
export function looksLikePdf(data: Buffer): boolean {
  const head = data.subarray(0, 1024).toString('latin1')
  return /%PDF-\d/.test(head)
}

/**
 * Extract text from a PDF buffer.
 *
 * @param data - raw PDF bytes.
 * @returns extracted text and whether a text layer was detected.
 */
export function extractPdfText(data: Buffer): PdfExtractResult {
  const warnings: string[] = []
  const fragments: string[] = []

  const streams = collectStreams(data)
  for (const stream of streams) {
    const inflated = tryInflate(stream)
    let content: string
    if (inflated !== null) {
      content = inflated.toString('latin1')
    } else {
      // Raw (uncompressed) streams may still contain text operators.
      content = stream.toString('latin1')
    }
    const ops = extractTextShowingOperators(content)
    fragments.push(...ops)
  }

  const joined = fragments.join(' ')
  const text = normalizePdfText(joined)
  const hasTextLayer = charLen(text) >= MIN_TEXT_CHARS
  if (!hasTextLayer && warnings.length === 0) {
    warnings.push('No text layer detected; this PDF likely requires OCR.')
  }
  return { text, hasTextLayer, warnings }
}

/** Locate every byte range marked `stream ... endstream`. */
function collectStreams(data: Buffer): Buffer[] {
  const streams: Buffer[] = []
  const streamMarker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let pos = 0
  while (pos < data.length) {
    const streamIdx = data.indexOf(streamMarker, pos)
    if (streamIdx < 0) break
    let start = streamIdx + streamMarker.length
    // Skip the EOL preceding the payload.
    if (data[start] === 0x0d) start++
    if (data[start] === 0x0a) start++
    const endRaw = data.indexOf(endMarker, start)
    if (endRaw < 0) break
    let end = endRaw
    // Strip the CR/LF directly before `endstream`.
    if (end > start && data[end - 1] === 0x0a) end--
    if (end > start && data[end - 1] === 0x0d) end--
    if (end > start) streams.push(data.subarray(start, end))
    pos = endRaw + endMarker.length
  }
  return streams
}

/** Try common deflate schemes; returns `null` when nothing decompresses. */
function tryInflate(stream: Buffer): Buffer | null {
  if (stream.length < 2) return null
  try {
    return inflateSync(stream)
  } catch {
    // fall through
  }
  try {
    return inflateRawSync(stream)
  } catch {
    return null
  }
}

/**
 * Pull out the strings shown by text operators in one content stream.
 * Handles nested parentheses and escapes; treats `TJ` arrays as a run of
 * strings joined with a space.
 */
function extractTextShowingOperators(content: string): string[] {
  const out: string[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    // Find the next text operator.
    const matched = findTextOperator(content, i)
    if (!matched) break
    i = matched.next
    out.push(...matched.strings)
  }
  return out
}

interface TextOp {
  next: number
  strings: string[]
}

/** Scan from `from` for a `Tj`/`TJ`/`'`/`"` operator with a preceding string. */
function findTextOperator(content: string, from: number): TextOp | null {
  const paren = content.indexOf('(', from)
  const hex = content.indexOf('<', from)
  const bracket = content.indexOf('[', from)
  // Process candidates left-to-right by byte position so an earlier literal
  // is never skipped because a later one matched first.
  const candidates = [paren, hex, bracket].filter((v) => v >= 0).sort((a, b) => a - b)
  for (const pos of candidates) {
    // Find the operator token that follows this literal (whitespace or start
    // of input before it; the quote operators are followed by space/EOL).
    const opMatch = /(?:\s|^)(Tj|TJ|['"])(?=\s|$)/.exec(content.slice(pos))
    if (!opMatch) continue
    const op = opMatch[1]!
    const after = pos + opMatch.index + opMatch[0].length
    if (op === 'TJ') {
      // The literal is a bracket array: locate its opening `[` and scan it.
      const bracketPos = content.lastIndexOf('[', pos)
      if (bracketPos < 0) continue
      return { next: after, strings: scanBracketStrings(content, bracketPos) }
    }
    const str = scanParenthesized(content, pos)
    if (str !== null) return { next: after, strings: [str] }
    const hexStr = scanHexString(content, pos)
    if (hexStr !== null) return { next: after, strings: [hexStr] }
  }
  return null
}

/** Decode a balanced parenthesized literal beginning at index of `(`. */
function scanParenthesized(content: string, openIdx: number): string | null {
  if (content[openIdx] !== '(') return null
  let depth = 0
  let out = ''
  let i = openIdx
  while (i < content.length) {
    const ch = content[i]!
    if (ch === '\\') {
      const next = content[i + 1]
      if (next === '(' || next === ')' || next === '\\') out += next!
      else if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else if (next === 't') out += '\t'
      else if (next !== undefined) out += next
      i += 2
      continue
    }
    if (ch === '(') {
      depth++
      if (depth > 1) out += ch
      i++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0) break
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  if (depth !== 0) return null
  return decodePdfString(out)
}

/** Decode a `<hex>` string literal beginning at the `<`. */
function scanHexString(content: string, openIdx: number): string | null {
  if (content[openIdx] !== '<') return null
  const close = content.indexOf('>', openIdx + 1)
  if (close < 0) return null
  const hex = content.slice(openIdx + 1, close).replace(/\s+/g, '')
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const bytes = Buffer.from(hex, 'hex')
  return decodePdfString(bytes.toString('latin1'))
}

/** Decode `[...] TJ` arrays: collect all `(...)` and `<...>` members. */
function scanBracketStrings(content: string, openIdx: number): string[] {
  const out: string[] = []
  let i = openIdx + 1
  while (i < content.length) {
    const ch = content[i]!
    if (ch === ']') break
    if (ch === '(') {
      const str = scanParenthesized(content, i)
      if (str !== null) out.push(str)
      // advance past the literal
      let depth = 0
      let j = i
      while (j < content.length) {
        if (content[j] === '\\') j += 2
        else if (content[j] === '(') depth++
        else if (content[j] === ')') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
        j++
      }
      i = Math.max(i + 1, j - 1)
      continue
    }
    if (ch === '<') {
      const str = scanHexString(content, i)
      if (str !== null) out.push(str)
      const close = content.indexOf('>', i + 1)
      i = close >= 0 ? close + 1 : i + 1
      continue
    }
    i++
  }
  return out
}

/** Decode a UTF-16 big-endian byte pair into a JS string. */
function decodeUtf16Be(bytes: Buffer): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i]! << 8) | bytes[i + 1]!
    out += String.fromCharCode(code)
  }
  return out
}

/** Decode a raw literal: convert UTF-16BE BOM or ASCII to a JS string. */
function decodePdfString(raw: string): string {
  const bytes = Buffer.from(raw, 'latin1')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Be(bytes.subarray(2))
  }
  // Treat high bytes as latin1 (documented approximation for non-CID fonts).
  return raw
}

/** Collapse whitespace runs and blank lines for cleaner output. */
function normalizePdfText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*[\n\r]+\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
