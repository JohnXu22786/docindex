/**
 * Document extraction registry.
 *
 * Routes a file buffer to the right extractor based on its extension (with a
 * content sniff as a fallback), and provides skip reasons for files that must
 * be left out (binary payloads, PDFs without a text layer, unsupported types).
 */
import { extname } from 'node:path'
import type { SkipReason } from './types.ts'
import { looksLikePdf, extractPdfText } from './pdf.ts'
import { extractDocx, extractPptx, extractXlsx, ZipReader } from './ooxml.ts'
export interface ExtractResult {
  text: string
  title?: string
  warnings?: string[]
  /** PDF-specific: whether a usable text layer was found. */
  hasTextLayer?: boolean
}

export type ExtractOutcome =
  | { ok: true; result: ExtractResult }
  | { ok: false; reason: SkipReason; message?: string }

export interface ExtractOptions {
  /** Extra extensions (leading dot) treated as plain UTF-8 text. */
  textExtensions?: readonly string[]
  /** True when unknown binary-looking files should be skipped. */
  skipBinary?: boolean
}

/** Built-in plain-text-ish extensions. */
export const DEFAULT_TEXT_EXTENSIONS: readonly string[] = [
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.log',
  '.rst',
  '.adoc',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
]

/** Office-style extensions routed to the OOXML extractor. */
export const OOXML_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pptx', '.xlsx'])

const MAX_TITLE_CHARS = 120

/** Sniff whether a byte buffer is almost certainly binary. */
export function sniffBinary(data: Uint8Array): boolean {
  const len = Math.min(data.length, 512)
  if (len === 0) return false
  let control = 0
  for (let i = 0; i < len; i++) {
    const b = data[i]!
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++
  }
  return control / len > 0.1
}

/** Extract text from a document buffer, resolving to a skip reason on failure. */
export function extractDocument(data: Buffer, filePath: string, options: ExtractOptions = {}): ExtractOutcome {
  const ext = extname(filePath).toLowerCase()
  const textExtensions = new Set([...DEFAULT_TEXT_EXTENSIONS, ...(options.textExtensions ?? [])])

  // PDF: content check first (extension may be missing).
  if (ext === '.pdf' || looksLikePdf(data)) {
    const result = extractPdfText(data)
    if (!result.hasTextLayer) {
      return { ok: false, reason: 'no-text-layer', message: 'PDF has no extractable text layer (OCR required)' }
    }
    return {
      ok: true,
      result: { text: result.text, title: makeTitle(result.text), warnings: result.warnings, hasTextLayer: true },
    }
  }

  if (OOXML_EXTENSIONS.has(ext)) {
    const zip = safeZip(data)
    if (!zip) return { ok: false, reason: 'unsupported', message: 'file is not a valid OOXML package' }
    let text = ''
    if (ext === '.docx') text = extractDocx(zip)
    else if (ext === '.pptx') text = extractPptx(zip)
    else text = extractXlsx(zip)
    if (!text) return { ok: false, reason: 'empty', message: 'OOXML package contains no text' }
    return { ok: true, result: { text, title: makeTitle(text) } }
  }

  const isTextExt = textExtensions.has(ext)
  if (!isTextExt) {
    // Unknown extension: probe. Binary-looking content is skipped.
    if (options.skipBinary !== false && sniffBinary(data)) {
      return { ok: false, reason: 'binary' }
    }
  } else if (sniffBinary(data)) {
    return { ok: false, reason: 'binary' }
  }

  const text = decodeText(data)
  if (!text) return { ok: false, reason: 'empty' }
  return { ok: true, result: { text, title: makeTitle(text) } }
}

/** Decode UTF-8 text, trimming the BOM and normalizing line endings. */
export function decodeText(data: Buffer): string {
  let text = data.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(/\r\n?/g, '\n')
  // Keep only the printable range; NUL/control bytes would corrupt the index.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return ''
  return text
}

/** Build a short title from the first lines of extracted text. */
export function makeTitle(text: string): string {
  const firstHeading = /^#\s+(.+)$/m.exec(text)
  if (firstHeading) return firstHeading[1]!.trim().slice(0, MAX_TITLE_CHARS)
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)
  if (firstLine) return firstLine.trim().slice(0, MAX_TITLE_CHARS)
  return ''
}

/** Wrap ZIP creation so invalid archives return `null`. */
function safeZip(data: Buffer): ZipReader | null {
  try {
    const zip = new ZipReader(data)
    if (zip.names().length === 0) return null
    return zip
  } catch {
    return null
  }
}
