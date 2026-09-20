/**
 * Minimal, dependency-free ZIP reader + xlsx inspector.
 *
 * Deliberately does NOT use JSZip or the plugin's own tooling: the point is to
 * verify an exported file with code that shares nothing with the code that wrote
 * it. Parses the End-Of-Central-Directory, walks the central directory, inflates
 * entries with node:zlib, and checks each entry's CRC-32.
 *
 * (Ported from the browser spike's scratch reader when the spike directory was
 * retired; see test/export-integrity.mjs for why it must stay independent.)
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50

// ---- CRC-32 (ISO 3309) -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function listZipEntries(buf) {
  let eocd = -1
  const minStart = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip: no End-Of-Central-Directory found')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory header at ${p}`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, crc, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, count, read, readChecked }

  function read(name) {
    const e = entries.get(name)
    if (!e) return null
    const lhNameLen = buf.readUInt16LE(e.localOffset + 26)
    const lhExtraLen = buf.readUInt16LE(e.localOffset + 28)
    const dataStart = e.localOffset + 30 + lhNameLen + lhExtraLen
    const raw = buf.subarray(dataStart, dataStart + e.compSize)
    if (e.method === 0) return Buffer.from(raw)
    if (e.method === 8) return inflateRawSync(raw)
    throw new Error('unsupported zip method ' + e.method + ' for ' + name)
  }

  /** Returns { data, crcOk } — inflate success + CRC-32 match against the header. */
  function readChecked(name) {
    const e = entries.get(name)
    const data = read(name)
    return { data, crcOk: data != null && crc32(data) === e.crc, sizeOk: data != null && data.length === e.uncompSize }
  }
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/**
 * The built-in number-format ids from ECMA-376 §18.8.30. A built-in format is
 * referenced by id alone, so its code never appears verbatim in styles.xml —
 * without this table a built-in format would look like it had vanished. Ids
 * 23–36 are reserved and intentionally absent.
 */
const BUILTIN_NUM_FMTS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '$#,##0_);($#,##0)', 6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)', 8: '$#,##0.00_);[Red]($#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm', 37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
}

/** Structural + content assertions on an exported .xlsx byte buffer. */
export function inspectXlsx(buf) {
  const zip = listZipEntries(buf)
  const names = [...zip.entries.keys()]

  const need = ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']
  const missing = need.filter((n) => !zip.entries.has(n))

  // Every entry must inflate and match its recorded CRC-32 and uncompressed size.
  const crcFailures = []
  let totalUncompressed = 0
  for (const n of names) {
    const { data, crcOk, sizeOk } = zip.readChecked(n)
    if (data == null || !crcOk || !sizeOk) crcFailures.push(n)
    if (data) totalUncompressed += data.length
  }

  // Resolve sheet name -> worksheet part through the workbook relationships,
  // because attribute order inside <sheet/> varies and the mapping is by r:id.
  const wbXml = zip.read('xl/workbook.xml')?.toString('utf8') ?? ''
  const relsXml = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const relTarget = new Map()
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = attr(m[0], 'Id'); const target = attr(m[0], 'Target')
    if (id && target) relTarget.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  const sheets = []
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], 'name')
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id')
    sheets.push({ name: decodeXml(name ?? ''), rid, part: relTarget.get(rid) ?? null })
  }

  let shared = []
  if (zip.entries.has('xl/sharedStrings.xml')) {
    const sx = zip.read('xl/sharedStrings.xml').toString('utf8')
    shared = [...sx.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''),
    )
  }

  // A cell carries only a style INDEX; the number format behind it lives in
  // styles.xml, so "did the format survive" is only answerable by resolving the
  // index through cellXfs. Built-in formats are ids, custom ones carry a code.
  const stylesXml = zip.read('xl/styles.xml')?.toString('utf8') ?? ''
  const customNumFmts = new Map()
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = attr(m[0], 'numFmtId'); const code = attr(m[0], 'formatCode')
    if (id && code !== undefined) customNumFmts.set(Number(id), decodeXml(code))
  }
  const cellXfsBlock = /<cellXfs\b[^>]*?(?:\/>|>([\s\S]*?)<\/cellXfs>)/.exec(stylesXml)
  const cellXfs = [...(cellXfsBlock?.[1] ?? '').matchAll(/<xf\b[^>]*?\/?>/g)]
    .map((m) => Number(attr(m[0], 'numFmtId') ?? '0'))
  /** The format code a cell's style resolves to, or undefined when it has none. */
  const numFmtCode = (styleId) => {
    if (styleId === undefined || Number.isNaN(styleId)) return undefined
    const id = cellXfs[styleId]
    if (id === undefined) return undefined
    return customNumFmts.get(id) ?? BUILTIN_NUM_FMTS[id]
  }

  const shared0 = (i) => shared[i]

  function parseSheet(part) {
    const xml = zip.read(part)?.toString('utf8') ?? ''
    const cells = new Map()
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? ''
      const inner = m[2] ?? ''
      const ref = attr(attrs, 'r')
      if (!ref) continue
      const t = attr(attrs, 't')
      const sAttr = attr(attrs, 's')
      const styleId = sAttr === undefined ? undefined : Number(sAttr)
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      const fTag = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner)
      const formula = fTag ? (fTag[2] ?? '') : undefined
      const sharedSi = fTag ? attr(fTag[1] ?? '', 'si') : undefined
      let value = v
      if (t === 's' && v !== undefined) value = shared0(Number(v))
      if (v !== undefined && t === undefined) value = Number(v)
      cells.set(ref, {
        type: t ?? 'n', raw: v, value, formula, sharedSi, styleId,
        numberFormat: numFmtCode(styleId),
      })
    }
    const dim = /<dimension ref="([^"]+)"/.exec(xml)?.[1]
    return { part, xmlBytes: xml.length, dimension: dim, cells, count: cells.size }
  }

  const parsed = new Map()
  for (const s of sheets) if (s.part) parsed.set(s.name, parseSheet(s.part))

  return {
    bytes: buf.length,
    entryCount: zip.count,
    entries: names,
    missing,
    crcFailures,
    totalUncompressed,
    sheets: sheets.map((s) => ({ ...s, ...(parsed.get(s.name) ?? {}) })),
    sheetNames: sheets.map((s) => s.name),
    sharedStringCount: shared.length,
    sharedStrings: shared,
    customNumFmts,
    cellXfs,
    sheet(name) { return parsed.get(name) ?? null },
    get(ref, sheetName) { return sheetName ? parsed.get(sheetName)?.cells.get(ref) : undefined },
  }
}
