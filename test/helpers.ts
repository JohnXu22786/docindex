/**
 * Shared test helpers: temp workspaces, a tiny PDF builder, and a tiny ZIP
 * (OOXML) builder — so extraction tests don't need committed binary fixtures.
 */
import { deflateRawSync, deflateSync } from 'node:zlib'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

export function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'docindex-test-'))
  for (const [rel, content] of Object.entries(files)) {
    writeWorkspaceFile(dir, rel, content)
  }
  return dir
}

/** Write a file under a workspace dir, creating parents. */
export function writeWorkspaceFile(dir: string, rel: string, content: string): string {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

/** Remove a file from a workspace. */
export function removeWorkspaceFile(dir: string, rel: string): void {
  rmSync(join(dir, ...rel.split('/')), { force: true })
}

/** Force a distinct mtime for change-detection tests. */
export function touch(dir: string, rel: string, timeMs: number): void {
  const full = join(dir, ...rel.split('/'))
  const t = new Date(timeMs)
  utimesSync(full, t, t)
}

/** Read a workspace file as UTF-8. */
export function readWorkspaceFile(dir: string, rel: string): string {
  return readFileSync(join(dir, ...rel.split('/')), 'utf8')
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function pathExists(p: string): boolean {
  return existsSync(p)
}

// ---------------------------------------------------------------------------
// Minimal PDF builder
// ---------------------------------------------------------------------------

export interface PdfOptions {
  /** Wrap the content stream in FlateDecode. */
  compressed?: boolean
  /** Use a hex string `<>` for the text literal. */
  hex?: boolean
  /** Use a TJ array instead of a single Tj string. */
  array?: boolean
  /** Emit no text-showing operators at all (simulates a scanned PDF). */
  blank?: boolean
  /** Emit these raw content-stream operators verbatim (no escaping). */
  rawOps?: string
}

export function makePdf(body: string, options: PdfOptions = {}): Buffer {
  const text = escapePdfLiteral(body)
  let contentOps = ''
  if (options.rawOps !== undefined) {
    contentOps = options.rawOps
  } else if (!options.blank) {
    if (options.array) {
      contentOps = `BT /F1 12 Tf 72 720 Td [(${text}) -250 ( and more)] TJ ET\n`
    } else if (options.hex) {
      contentOps = `BT /F1 12 Tf 72 720 Td <${Buffer.from(body).toString('hex')}> Tj ET\n`
    } else {
      contentOps = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`
    }
  }
  let stream = Buffer.from(contentOps, 'latin1')
  if (options.compressed) stream = deflateSync(stream)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${stream.length} /Filter ${options.compressed ? '/FlateDecode ' : ''}>>`,
  ]
  let out = '%PDF-1.4\n'
  objects.forEach((dict, i) => {
    out += `${i + 1} 0 obj\n${dict}\nendobj\n`
    if (i === objects.length - 1) {
      out += `stream\n`
      out += stream.toString('latin1')
      out += `\nendstream\nendobj\n`
    }
  })
  out += `trailer\n<< /Root 1 0 R >>\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// ---------------------------------------------------------------------------
// Minimal ZIP (OOXML) builder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** Build a ZIP archive (deflated entries). Returns the full buffer. */
export function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data)
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    chunks.push(local, nameBuf, compressed)

    const cent = Buffer.alloc(46)
    cent.writeUInt32LE(0x02014b50, 0)
    cent.writeUInt16LE(20, 4) // version made by
    cent.writeUInt16LE(20, 6) // version needed
    cent.writeUInt16LE(0, 8)
    cent.writeUInt16LE(8, 10) // method
    cent.writeUInt32LE(crc, 16)
    cent.writeUInt32LE(compressed.length, 20)
    cent.writeUInt32LE(entry.data.length, 24)
    cent.writeUInt16LE(nameBuf.length, 28)
    cent.writeUInt32LE(offset, 42)
    central.push(cent, nameBuf)
    offset += 30 + nameBuf.length + compressed.length
  }
  const cdStart = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const cdSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, ...central, eocd])
}

/** Build a `.docx` package with the given paragraph texts. */
export function makeDocx(paragraphs: string[]): Buffer {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>` +
    paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('') +
    `</w:body></w:document>`
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) },
  ])
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Platform-agnostic relative slash helper used by tests that check paths. */
export function slash(path: string): string {
  return path.split(sep).join('/')
}
