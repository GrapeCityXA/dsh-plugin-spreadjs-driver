/**
 * Minimal PNG decoder (dependency-free) so "is this a real screenshot" can be
 * answered from the bytes rather than from the file size. Supports the subset
 * Chrome's Page.captureScreenshot emits: 8-bit truecolour (+/-alpha), no interlace.
 *
 * (Ported from the browser spike's scratch reader when the spike directory was
 * retired; see test/export-integrity.mjs for why it must stay independent.)
 */
import { inflateSync } from 'node:zlib'

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG (bad signature)')
  }
  let off = 8
  let ihdr = null
  const idat = []
  const chunks = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push(type)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], compression: data[10],
        filter: data[11], interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG has no IHDR')
  if (ihdr.bitDepth !== 8) throw new Error('unsupported bit depth ' + ihdr.bitDepth)
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType]
  if (!channels) throw new Error('unsupported colour type ' + ihdr.colorType)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = ihdr.width * channels
  const out = Buffer.alloc(stride * ihdr.height)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride
    unfilter(ft, line, prev, channels)
    line.copy(out, y * stride)
    prev = line
  }
  return { ...ihdr, channels, data: out, stride, chunks }
}

function unfilter(type, line, prev, bpp) {
  const n = line.length
  switch (type) {
    case 0: break
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff; break
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff; break
    case 3: for (let i = 0; i < n; i++) line[i] = (line[i] + ((i >= bpp ? line[i - bpp] : 0) + prev[i] >> 1)) & 0xff; break
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      break
    default: throw new Error('bad PNG filter type ' + type)
  }
}

/** Raster statistics that distinguish a real render from a blank frame. */
export function pngStats(png) {
  const { width, height, channels, data } = png
  const colors = new Set()
  let min = 255, max = 0, sum = 0, n = 0
  let nonWhite = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * png.stride + x * channels
      const r = data[i], g = channels > 2 ? data[i + 1] : r, b = channels > 2 ? data[i + 2] : r
      const lum = (r * 299 + g * 587 + b * 114) / 1000
      if (lum < min) min = lum
      if (lum > max) max = lum
      sum += lum; n++
      if (r < 245 || g < 245 || b < 245) nonWhite++
      if (colors.size < 5000) colors.add((r << 16) | (g << 8) | b)
    }
  }
  return {
    width, height, channels,
    distinctColors: colors.size,
    minLuminance: +min.toFixed(1), maxLuminance: +max.toFixed(1),
    meanLuminance: +(sum / n).toFixed(2),
    nonWhiteFraction: +(nonWhite / n).toFixed(4),
    uniform: colors.size <= 2,
  }
}

/** Darkest-pixel bounding box per row band — a cheap "is there ink here" probe. */
export function inkRows(png, bands = 12) {
  const { width, height, channels, data } = png
  const out = []
  const bandH = Math.floor(height / bands)
  for (let b = 0; b < bands; b++) {
    let dark = 0
    for (let y = b * bandH; y < Math.min((b + 1) * bandH, height); y++) {
      for (let x = 0; x < width; x++) {
        const i = y * png.stride + x * channels
        if (data[i] < 128) dark++
      }
    }
    out.push(dark)
  }
  return out
}
