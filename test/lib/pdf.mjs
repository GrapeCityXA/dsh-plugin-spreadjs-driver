/**
 * Minimal, dependency-free PDF inspector — enough to tell a real PDF from a
 * hollow shell, which is the failure mode this project actually hit: savePDF
 * writes a page for every cell but silently drops the TEXT of any cell whose
 * font was never registered, leaving border paths, an empty page skeleton, and
 * a font *name* with no font *file* behind it.
 *
 * Content streams are Flate-compressed, so "does this PDF contain text" can only
 * be answered after inflating them — grepping the raw bytes reports 0 text
 * operators for a perfectly good PDF.
 *
 * (Extracted from the browser spike's roundtrip-verify.mjs when the spike
 * directory was retired; see test/export-integrity.mjs for why it must stay
 * independent of the code that writes the PDF.)
 */
import { inflateSync } from 'node:zlib'

/**
 * Read an exported PDF's font and text structure.
 *
 * `embedded` answers "is a font FILE in here", which a font NAME cannot: a
 * base-14 reference such as /BaseFont /Times-Roman is legal, carries no font
 * file, and renders every CJK glyph as nothing. `subsetPrefixed` is the same
 * question asked a second way — an embedded font is written as a subset named
 * `ABCDEF+Family`, so the `+` only appears when a real file was embedded.
 */
export function inspectPdf(buf) {
  const raw = buf.toString('latin1')
  const baseFonts = [...new Set([...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-,#]+)/g)].map((m) => m[1]))]
  // A font descriptor points at the font program as an indirect object
  // (/FontFile2 25 0 R); resolve that object's stream length, which is the only
  // measure of "how much of a font program is actually in this file". Note that
  // this writer emits /Length (the stream's own length) and no /Length1, so
  // looking for /Length1 finds nothing even in a perfectly good PDF.
  const fontFiles = [...raw.matchAll(/\/FontFile(\d)\s+(\d+)\s+0\s+R/g)].map((m) => {
    const object = new RegExp(`(?:^|[\\r\\n])${m[2]} 0 obj([\\s\\S]{0,400}?)stream`).exec(raw)
    const length = object === null ? null : Number(/\/Length\s+(\d+)/.exec(object[1])?.[1])
    return { type: `FontFile${m[1]}`, ref: Number(m[2]), streamLength: Number.isFinite(length) ? length : null }
  })

  let content = ''
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue
    try { content += inflateSync(Buffer.from(buf.subarray(start, end))).toString('latin1') + '\n' } catch { /* not zlib */ }
  }
  const textOperators = (content.match(/\bT[Jj]\b/g) ?? []).length
  const textBlocks = (content.match(/\bBT\b/g) ?? []).length
  const glyphCodes = [...content.matchAll(/<([0-9A-Fa-f]+)>/g)].reduce((sum, m) => sum + m[1].length / 4, 0)

  return {
    bytes: buf.length,
    header: raw.slice(0, 5),
    baseFonts,
    /** Any FontFile stream at all — the weak form of "a font is embedded". */
    embedded: fontFiles.length > 0,
    fontFiles,
    /** Largest embedded font program, in bytes — a stub would be tiny. */
    largestFontProgram: fontFiles.reduce((max, f) => Math.max(max, f.streamLength ?? 0), 0),
    /** The strong form: a subset-prefixed (thus embedded) font family name. */
    subsetPrefixed: baseFonts.filter((f) => f.includes('+')),
    /** Fonts named but not embedded (base-14 references) — reported, not fatal. */
    unembeddedNames: baseFonts.filter((f) => !f.includes('+')),
    contentStreamChars: content.length,
    textOperators,
    textBlocks,
    glyphCodes,
  }
}
