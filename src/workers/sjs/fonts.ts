/**
 * PDF 导出字体发现。
 *
 * savePDF 只嵌入已经 PDFFontsManager 注册过的字体；单元格里引用了未注册字体的
 * 文本会被静默丢弃（spike 07 已证实会产出"空壳 PDF"——只有边框路径、没有 Tj/TJ
 * 文本操作符）。这个约束**不随运行时改变**：savePDF 是 SpreadJS 内部的纯 JS
 * PDF 写出器，与浏览器能不能渲染中文无关；真浏览器只是换掉了"字体从哪来"——
 * 页面用 fetch 通过回环 HTTP 取字体，不再需要 fs、Buffer 切片或跨 realm
 * ArrayBuffer 修补。因此 PDF 导出前仍然必须保证至少有一个可注册的 .ttf/.otf
 * （.ttc 不支持，如 simsun.ttc / msyh.ttc），否则直接抛 SJS_PDF_FONT_UNAVAILABLE，
 * 绝不静默产出空壳 PDF。
 *
 * 本模块只负责"Node 侧发现"：扫描字体目录、给出文件路径与是否含 CJK。
 * 注册发生在页面里（page.embed.js 的 registerPdfFonts），因为 PDFFontsManager
 * 只存在于浏览器内。
 *
 * 发现顺序（字体目录）：
 *   1. 环境变量 GC_SJS_PDF_FONT_DIRS（按 node:path delimiter 分隔，追加候选目录，
 *      便于部署时注入自定义字体）；
 *   2. 平台默认字体目录（Windows / macOS / Linux）。
 * 扫描到的所有非 .ttc 的 ttf/otf 逐个交给页面注册，字体族名为小写去扩展名的文件名。
 */
import { readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'

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
  const extra = process.env['GC_SJS_PDF_FONT_DIRS'] ?? ''
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
