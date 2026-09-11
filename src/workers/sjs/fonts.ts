/**
 * PDF 导出字体发现与注册。
 *
 * savePDF 只嵌入已经 PDFFontsManager 注册过的字体；单元格里引用了未注册字体的
 * 文本会被静默丢弃（spike 07 已证实会产出"空壳 PDF"——只有边框路径、没有 Tj/TJ
 * 文本操作符）。因此 PDF 导出前必须保证：
 *   1. 至少找到一个可注册的 .ttf/.otf（.ttc 不支持，如 simsun.ttc / msyh.ttc）；
 *   2. 设置 fallbackFont，让任何未显式注册的字体族都能兜底到已嵌入字体。
 * 否则直接抛 SJS_PDF_FONT_UNAVAILABLE，绝不静默产出空壳 PDF。
 *
 * 发现顺序（字体目录）：
 *   1. 环境变量 GC_SJS_PDF_FONT_DIRS（按 node:path delimiter 分隔，追加候选目录，
 *      便于部署时注入自定义字体）；
 *   2. 平台默认字体目录（Windows / macOS / Linux）。
 * 扫描到的所有非 .ttc 的 ttf/otf 逐个注册，字体族名为小写去扩展名的文件名。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'

type Gc = any

/** 一个可用于 PDF 嵌入的字体文件。 */
export interface PdfFontFile {
  /** 注册用的字体族名（小写去扩展名，如 "arial"、"simhei"）。 */
  readonly family: string
  readonly file: string
  /** 是否含 CJK 字符集（宜优先作 fallback，否则中文单元格会丢字）。 */
  readonly cjk: boolean
}

/** 平台默认字体目录。 */
function platformFontDirs(): readonly string[] {
  switch (process.platform) {
    case 'win32':
      return ['C:/Windows/Fonts']
    case 'darwin':
      return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts']
    default:
      return ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/liberation', '/usr/share/fonts', '/usr/local/share/fonts']
  }
}

/** 文件名命中这些片段即视为含 CJK（宜优先作 fallback）。 */
const CJK_MARKERS = [
  'simhei', 'simkai', 'simfang', 'msyh', 'simsun',
  'notosanscjk', 'notoserifcjk', 'droidsansfallback', 'arialunicodems', 'wqy',
]

/** 扫描单个目录中的候选字体文件（仅 ttf/otf；跳过 ttc 与隐藏文件）。 */
function scanDirectory(dir: string): PdfFontFile[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // 目录不存在或无权限：交给其他候选目录。
  }
  const found: PdfFontFile[] = []
  for (const entry of entries) {
    const lower = entry.toLowerCase()
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) continue
    const base = lower.slice(0, -4)
    if (base.length === 0 || base.startsWith('.')) continue
    const cjk = CJK_MARKERS.some((marker) => base.includes(marker))
    found.push({ family: base, file: join(dir, entry), cjk })
  }
  return found
}

/** 汇总全部候选字体：平台默认目录 + GC_SJS_PDF_FONT_DIRS 追加目录，去重。 */
export function discoverPdfFonts(): PdfFontFile[] {
  const dirs: string[] = [...platformFontDirs()]
  const extra = process.env.GC_SJS_PDF_FONT_DIRS ?? ''
  for (const raw of extra.split(delimiter)) {
    const dir = raw.trim()
    if (dir.length > 0) dirs.push(dir)
  }
  const seen = new Set<string>()
  const fonts: PdfFontFile[] = []
  for (const dir of dirs) {
    for (const font of scanDirectory(dir)) {
      if (seen.has(font.file)) continue
      seen.add(font.file)
      fonts.push(font)
    }
  }
  return fonts
}

/**
 * 把发现的字体注册进 PDFFontsManager 并设好 fallback。
 * 没有任何字体可注册/注册成功时抛错 —— PDF 导出的前置守卫，防空壳 PDF。
 * @returns 已注册的字体族名（供结果回传模型核对）。
 */
export function registerPdfFonts(
  GC: Gc,
  fonts: readonly PdfFontFile[],
  fail: (message: string, code: string) => Error,
): string[] {
  const manager = GC.Spread?.Sheets?.PDF?.PDFFontsManager
  if (manager === undefined || manager === null) {
    throw fail('PDF 功能不可用：未加载 spread-sheets-pdf（其必须先于 pdf 加载 print）。', 'SJS_PDF_UNAVAILABLE')
  }
  const registered: string[] = []
  let fallbackCjk: PdfFontFile | undefined
  let fallbackAny: PdfFontFile | undefined
  for (const font of fonts) {
    let arrayBuffer: ArrayBuffer
    try {
      const data = readFileSync(font.file)
      // Node Buffer 的 .buffer 已是 Node-realm ArrayBuffer；spike 07 用
      // slice 精确切出视图，避免把整个池子一起带上。
      arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    } catch {
      continue // 单个字体损坏/被占用：跳过，不影响其余候选。
    }
    try {
      manager.registerFont(font.family, { normal: arrayBuffer })
      registered.push(font.family)
      if (font.cjk && fallbackCjk === undefined) fallbackCjk = font
      if (fallbackAny === undefined) fallbackAny = font
    } catch {
      // 个别字体注册失败不致命。
    }
  }
  if (registered.length === 0) {
    throw fail(
      '找不到可嵌入 PDF 的字体：需要至少一个 .ttf/.otf（不支持 .ttc）。' +
        '可用环境变量 GC_SJS_PDF_FONT_DIRS 指向含 simhei.ttf / arial.ttf 等的目录，避免导出空壳 PDF。',
      'SJS_PDF_FONT_UNAVAILABLE',
    )
  }
  // fallback 命中含中文的字体优先；否则退到首个已注册字体。
  const fallback = fallbackCjk ?? fallbackAny
  if (fallback !== undefined) {
    try {
      const data = readFileSync(fallback.file)
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      manager.fallbackFont = () => arrayBuffer
    } catch {
      // fallback 读取失败：仅靠显式注册字体也能覆盖其族名文本。
    }
  }
  return registered
}
