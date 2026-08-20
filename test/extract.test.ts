import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractDocument, decodeText, sniffBinary, makeTitle } from '../src/extract.ts'
import { makePdf, makeDocx } from './helpers.ts'

test('extract: markdown yields text and a heading title', () => {
  const outcome = extractDocument(Buffer.from('# My Doc\n\nhello body', 'utf8'), '/tmp/guide.md')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.result.title, 'My Doc')
  assert.match(outcome.result.text, /hello body/)
})

test('extract: plain txt uses first non-empty line as title', () => {
  const outcome = extractDocument(Buffer.from('First line', 'utf8'), '/tmp/note.txt')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.result.title, 'First line')
})

test('extract: BOM and CRLF are normalized', () => {
  const text = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line1\r\nline2\r\n')]))
  assert.equal(text, 'line1\nline2\n')
})

test('extract: binary payload is skipped with reason', () => {
  const buf = Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01])
  const outcome = extractDocument(buf, '/tmp/blob.bin')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'binary')
})

test('extract: NUL byte sniffs as binary', () => {
  assert.equal(sniffBinary(Buffer.from([65, 0, 66, 67])), true)
  assert.equal(sniffBinary(Buffer.from('plain text here')), false)
})

test('extract: PDF text layer (uncompressed stream)', () => {
  const outcome = extractDocument(makePdf('Hello PDF world'), '/tmp/a.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /Hello PDF world/)
  assert.equal(outcome.result.hasTextLayer, true)
})

test('extract: PDF text layer (FlateDecode compressed stream)', () => {
  const outcome = extractDocument(makePdf('Compressed hello', { compressed: true }), '/tmp/b.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /Compressed hello/)
})

test('extract: PDF hex string literal', () => {
  const outcome = extractDocument(makePdf('HexString', { hex: true }), '/tmp/c.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /HexString/)
})

test('extract: PDF TJ array', () => {
  const outcome = extractDocument(makePdf('ArrayText', { array: true }), '/tmp/d.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /ArrayText/)
})

test('extract: PDF without a text layer is reported, not indexed', () => {
  const outcome = extractDocument(makePdf('ignored', { blank: true }), '/tmp/e.pdf')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'no-text-layer')
})

test('extract: DOCX paragraph text', () => {
  const outcome = extractDocument(makeDocx(['First paragraph', 'Second paragraph 中文']), '/tmp/f.docx')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /First paragraph/)
  assert.match(outcome.result.text, /Second paragraph 中文/)
})

test('extract: empty document is skipped as empty', () => {
  const outcome = extractDocument(Buffer.from('', 'utf8'), '/tmp/g.txt')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'empty')
})

test('extract: PDF quote operators (\' and ") are captured', () => {
  const ops = `BT /F1 12 Tf 72 720 Td (first piece) ' 4 0 Td (second piece) " ET`
  const outcome = extractDocument(makePdf('unused', { rawOps: ops }), '/tmp/q.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.match(outcome.result.text, /first piece/)
  assert.match(outcome.result.text, /second piece/)
})

test('extract: TJ array preceded by a later literal is still captured', () => {
  // A `(` later in the stream must not shadow the earlier bracket array.
  // `<0048>`/`<0064>` are 2-byte (UTF-16BE) literals for H and d.
  const ops = `BT [<0048> <0064>] TJ (after) Tj ET`
  const outcome = extractDocument(makePdf('unused', { rawOps: ops }), '/tmp/tj.pdf')
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.ok(outcome.result.text.includes('H'), 'first hex literal captured')
  assert.ok(outcome.result.text.includes('d'), 'second hex literal captured')
  assert.match(outcome.result.text, /after/)
})

test('extract: corrupt DOCX reports unsupported instead of throwing', () => {
  const outcome = extractDocument(Buffer.from('this is definitely not a zip archive'), '/tmp/bad.docx')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'unsupported')
})

test('makeTitle: falls back to first non-empty line', () => {
  assert.equal(makeTitle('Just a line\nmore'), 'Just a line')
  assert.equal(makeTitle(''), '')
})
