/**
 * Locate the system browser that hosts the engine.
 *
 * The plugin deliberately ships no browser binary: the runtime rides the
 * Edge/Chrome already installed on the machine. That keeps the package small,
 * makes the engine behave exactly as it does for a real user, and removes the
 * whole class of "we are not really a browser" defects (cross-realm ArrayBuffer,
 * cross-realm Date, missing CanvasRenderingContext2D, forced CJK fonts) that the
 * jsdom runtime paid for three times.
 *
 * The price is a runtime prerequisite, so discovery must fail LOUD and
 * ACTIONABLE: `SJS_BROWSER_UNAVAILABLE` names the paths that were probed and the
 * two ways to fix it, never a spawn stack trace.
 *
 * Order: the host's config value (surfaced as SJS_BROWSER_PATH) → Edge → Chrome,
 * first existing path wins.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type BrowserKind = 'edge' | 'chrome'

export interface BrowserLocation {
  readonly kind: BrowserKind
  readonly path: string
}

/** Candidate install locations, in preference order, for this platform. */
function candidates(): readonly BrowserLocation[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA']
    const skip = (value: string | undefined): readonly string[] => (value === undefined ? [] : [value])
    return [
      // Edge first: it is present on every supported Windows install.
      { kind: 'edge', path: join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe') },
      { kind: 'edge', path: join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe') },
      ...skip(localAppData).map((base): BrowserLocation => ({ kind: 'edge', path: join(base, 'Microsoft\\Edge\\Application\\msedge.exe') })),
      { kind: 'chrome', path: join(programFiles, 'Google\\Chrome\\Application\\chrome.exe') },
      { kind: 'chrome', path: join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe') },
      ...skip(localAppData).map((base): BrowserLocation => ({ kind: 'chrome', path: join(base, 'Google\\Chrome\\Application\\chrome.exe') })),
    ]
  }
  const portable = (kind: BrowserKind, commands: readonly string[]): readonly BrowserLocation[] =>
    commands.map((path) => ({ kind, path }))
  return [
    { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    ...portable('edge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-beta']),
    ...portable('chrome', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']),
  ]
}

/**
 * Resolve the browser executable to drive.
 *
 * @param explicit config value (already the highest-precedence source).
 * @throws an Error carrying `code = 'SJS_BROWSER_UNAVAILABLE'` when nothing is
 *         found — or when an explicitly configured path does not exist, which is
 *         a different (and much easier) mistake to make.
 */
export function findBrowser(explicit?: string): BrowserLocation {
  if (explicit !== undefined && explicit.length > 0) {
    if (!existsSync(explicit)) {
      throw browserUnavailable(
        `配置的浏览器路径不存在：${explicit}。请检查 browserPath 配置（或 SJS_BROWSER_PATH 环境变量），` +
          '或删除该项让插件自动探测 Edge / Chrome。',
      )
    }
    return { kind: /chrome/i.test(explicit) && !/edge/i.test(explicit) ? 'chrome' : 'edge', path: explicit }
  }
  const probed = candidates()
  for (const candidate of probed) {
    if (existsSync(candidate.path)) return candidate
  }
  throw browserUnavailable(
    '找不到可用的浏览器：本插件的表格引擎运行在系统自带的 Edge 或 Chrome 里（不再自带浏览器内核）。' +
      `已探测以下路径，均不存在：\n  ${probed.map((c) => c.path).join('\n  ')}\n` +
      '解决办法（任选其一）：安装 Microsoft Edge 或 Google Chrome；' +
      '或在插件配置里把 browserPath 指向已有的浏览器可执行文件（等价的环境变量：SJS_BROWSER_PATH）。',
  )
}

/** Build the classified error discovery throws. Kept local so this module has no worker imports. */
function browserUnavailable(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = 'SJS_BROWSER_UNAVAILABLE'
  return error
}
