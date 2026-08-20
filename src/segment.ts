/**
 * Splitting extracted text into index segments with source line numbers.
 *
 * Each segment keeps the 1-based line number where it starts so retrieval can
 * cite exact locations. Segments are bounded by `maxChars` (code points); a
 * single very long line is split into multiple segments that share its line.
 */
import { charLen, charSlice } from './util.ts'

export interface Segment {
  kind: 'text'
  /** 0-based order inside the document. */
  seq: number
  /** 1-based source line where the segment starts. */
  line: number
  content: string
}

export interface SegmentOptions {
  maxChars?: number
}

/** Normalize line endings and strip a trailing blank line artifact. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Split normalized text into segments, tracking the start line of each. */
export function segmentText(text: string, options: SegmentOptions = {}): Segment[] {
  const maxChars = options.maxChars ?? 400
  const normalized = normalizeNewlines(text)
  const lines = normalized.split('\n')
  // Drop a single trailing empty line produced by a file ending in a newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const segments: Segment[] = []
  let seq = 0
  let current: string[] = []
  let currentChars = 0
  let startLine = 1

  const flush = (): void => {
    if (current.length === 0) return
    const content = current.join('\n')
    segments.push({ kind: 'text', seq: seq++, line: startLine, content })
    current = []
    currentChars = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    const lineChars = charLen(line)
    if (lineChars > maxChars) {
      // Long line: split into ceil(len/maxChars) segments, all on this line.
      flush()
      const partCount = Math.ceil(lineChars / maxChars)
      for (let p = 0; p < partCount; p++) {
        const part = charSlice(line, p * maxChars, (p + 1) * maxChars)
        segments.push({ kind: 'text', seq: seq++, line: lineNo, content: part })
      }
      continue
    }
    if (current.length > 0 && currentChars + lineChars + 1 > maxChars) {
      flush()
      startLine = lineNo
      current.push(line)
      currentChars = lineChars
      continue
    }
    if (current.length === 0) startLine = lineNo
    current.push(line)
    currentChars += lineChars + 1
  }
  flush()
  return segments
}
