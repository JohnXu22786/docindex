/**
 * Minimal Office Open XML text extraction (`.docx`, `.pptx`, `.xlsx`).
 *
 * A tiny ZIP central-directory reader (Node built-ins only) unpacks the OOXML
 * container without external dependencies, then each format pulls its text
 * nodes. Only the document text is kept; formatting and structure are dropped.
 */
import { inflateRawSync } from 'node:zlib'
import { escapeRegExp } from './util.ts'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

/** A permissive minimal ZIP reader tailored to OOXML packages. */
export class ZipReader {
  private readonly data: Buffer
  private readonly entries: Map<string, ZipEntry> = new Map()

  constructor(data: Buffer) {
    this.data = data
    this.parseCentralDirectory()
  }

  /** Names of the entries in the archive. */
  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Read and decompress one entry; returns `null` when missing/unsupported. */
  read(name: string): Buffer | null {
    const entry = this.entries.get(name)
    if (!entry) return null
    // Bounds-check everything derived from the (untrusted) central directory
    // so a corrupt/truncated archive yields `null` instead of a RangeError.
    if (entry.localOffset < 0 || entry.localOffset + 30 > this.data.length) return null
    if (this.data.readUInt32LE(entry.localOffset) !== LOCAL_SIG) return null
    const nameLen = this.data.readUInt16LE(entry.localOffset + 26)
    const extraLen = this.data.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    const end = start + entry.compressedSize
    if (end > this.data.length) return null
    const raw = this.data.subarray(start, end)
    if (entry.method === 0) return Buffer.from(raw)
    if (entry.method === 8) {
      try {
        return inflateRawSync(raw)
      } catch {
        return null
      }
    }
    return null
  }

  private parseCentralDirectory(): void {
    const eocd = findEocd(this.data)
    if (!eocd) return
    const entryCount = this.data.readUInt16LE(eocd + 10)
    let pos = this.data.readUInt32LE(eocd + 16)
    for (let i = 0; i < entryCount && pos + 46 <= this.data.length; i++) {
      const sig = this.data.readUInt32LE(pos)
      if (sig !== CENTRAL_SIG) break
      const method = this.data.readUInt16LE(pos + 10)
      const compressedSize = this.data.readUInt32LE(pos + 20)
      const nameLen = this.data.readUInt16LE(pos + 28)
      const extraLen = this.data.readUInt16LE(pos + 30)
      const commentLen = this.data.readUInt16LE(pos + 32)
      const localOffset = this.data.readUInt32LE(pos + 42)
      const name = this.data
        .subarray(pos + 46, pos + 46 + nameLen)
        .toString('utf8')
      if (name) this.entries.set(name, { name, method, compressedSize, localOffset })
      pos += 46 + nameLen + extraLen + commentLen
    }
  }
}

/** Locate the End of Central Directory marker in the last 64 KiB. */
function findEocd(data: Buffer): number | null {
  const tail = Math.min(data.length, 65557)
  const start = data.length - tail
  for (let i = data.length - 22; i >= start; i--) {
    if (data.readUInt32LE(i) === EOCD_SIG) return i
  }
  return null
}

/** Unescape the small set of XML entities found in OOXML text. */
function unescapeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Collapse excessive whitespace before returning. */
function tidy(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Strip markup from an XML fragment while preserving blank-line structure.
 * `lineTags` become newlines, `tabTags` become tabs, `breakTags` also newlines.
 */
function xmlToText(xml: string, tags: { line?: string[]; tab?: string[]; br?: string[] } = {}): string {
  let text = xml
  for (const tag of tags.br ?? []) text = text.replace(new RegExp(escapeRegExp(tag), 'g'), '\n')
  for (const tag of tags.tab ?? []) text = text.replace(new RegExp(escapeRegExp(tag), 'g'), '\t')
  for (const tag of tags.line ?? []) text = text.replace(new RegExp(escapeRegExp(tag), 'g'), '\n')
  text = text.replace(/<[^>]*\/?\s*>/g, '')
  return unescapeXml(text)
}

/** Extract `.docx` paragraph text. */
export function extractDocx(zip: ZipReader): string {
  const xml = zip.read('word/document.xml')
  if (!xml) return ''
  const text = xmlToText(xml.toString('utf8'), {
    line: ['</w:p>', '</w:tr>'],
    tab: ['</w:tc>'],
    br: ['<w:br/>'],
  })
  return tidy(text)
}

/** Extract `.pptx` slide text (paragraphs preserved, slides separated). */
export function extractPptx(zip: ZipReader): string {
  const slideNames = zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  let out = ''
  for (const name of slideNames) {
    const xml = zip.read(name)
    if (!xml) continue
    const text = xmlToText(xml.toString('utf8'), {
      line: ['</a:p>'],
      br: ['<a:br/>'],
    }).trim()
    if (text) out += `\n${text}`
  }
  return tidy(out)
}

/** Extract `.xlsx` text (shared strings and inline/rich cell text). */
export function extractXlsx(zip: ZipReader): string {
  const parts: string[] = []

  const shared = zip.read('xl/sharedStrings.xml')
  if (shared) {
    for (const si of shared.toString('utf8').split('</si>')) {
      if (!si.includes('<si')) continue
      const text = xmlToText(si).trim()
      if (text) parts.push(text)
    }
  }
  for (const name of zip
    .names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))) {
    const xml = zip.read(name)
    if (!xml) continue
    for (const cell of xml.toString('utf8').split('</c>')) {
      if (!cell.includes('<c ')) continue
      // Only cells carrying text (inline `<is>` or a `<v>` numeric/string ref).
      if (!/is>|v>/.test(cell)) continue
      const text = xmlToText(cell, { line: ['</is>'] }).trim()
      if (text) parts.push(text)
    }
  }
  return tidy(parts.join('\n'))
}

function slideNumber(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name)
  return m ? Number(m[1]) : 0
}

function sheetNumber(name: string): number {
  const m = /sheet(\d+)\.xml$/.exec(name)
  return m ? Number(m[1]) : 0
}
