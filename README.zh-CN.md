# @grapecity-software/dsh-spreadjs-driver

> 为 DeepSeek Harness (DSH) 提供 SpreadJS 电子表格能力：通过内置的 `sjs_*` 工具创建、查看、编辑、导入、导出与截图 `.xlsx`/`.ssjson` 工作簿。

[English](README.md) · 简体中文

`@grapecity-software/dsh-spreadjs-driver` 是 DeepSeek Harness 的 [SpreadJS](https://www.grapecity.com/spreadjs) 插件。它把 SpreadJS 引擎内嵌进 Agent 运行时，让 Agent 能够构建表格、写入数值与公式、调整工作表结构，并可视化地核验结果——最终交付可直接用 Excel、WPS Office 等兼容应用打开的 `.xlsx`（或 `.csv` / `.pdf`）。引擎跑在一个隐藏的系统浏览器里（插件把它常驻着：第一次表格操作时启动，每次操作给它一个新页面，随 DSH 进程一起结束，用户看不到）。

## 环境要求

- **Node.js ≥ 22.19**，以及 **DeepSeek Harness** 运行时（`@deepseek-ai/dsh` `0.1.5-rc.2`）。
- **宿主机需装有 Google Chrome 或 Microsoft Edge**。引擎运行在真实浏览器进程中（插件不自带浏览器内核，也不会弹出任何界面）。两者都在时优先用 Chrome——Edge 会把自己的标签页发布进 Windows 外壳，在 Alt+Tab 里堆积条目；两种情况都可以用插件配置 `browserPath` 指定具体可执行文件。都找不到时报 `SJS_BROWSER_UNAVAILABLE`，并在消息里列出探测过的路径。
- 需要一个可写的临时目录，用于浏览器的一次性 profile。
- **`.pdf` 导出要保留中文，字体必须由宿主机提供。** 插件**不自带任何字体**：它在操作系统的字体目录（以及环境变量 `GC_SJS_PDF_FONT_DIRS` 追加的目录）里找 `.ttf` / `.otf`，有一个就够。Windows 和 macOS 一定有；**默认安装的 Linux 通常没有**——它的中文字体多是 `.ttc`，而 SpreadJS 无法嵌入 `.ttc`，所以要事先装一个 `.ttf`，或用 `GC_SJS_PDF_FONT_DIRS` 指过去。找不到可用字体时，`.pdf` 导出会以 `SJS_PDF_FONT_UNAVAILABLE` 明确失败，而不是交回一份文字缺失的 PDF。`png` 截图不需要这些——浏览器自带真实字体，且按字形逐个回退。

**关于 DSH 版本区间。** `dsh.engines.dsh` 与各 `@deepseek-ai/*` peer 区间写的是精确版本 `0.1.5-rc.2`——既不是 caret，也不是拉长的列表。DSH 尚未 1.0，rc 之间就会有不兼容改动，所以这个插件能诚实声明的只有 CI 真跑过的那一个版本。对预发布版加 caret 等于默默承诺下一个 rc 也兼容；写 `>=` 则等于承诺永远兼容。将来 DSH 发新版、且在本地 CI 跑通之后，这个区间才会被显式抬到那个版本——一次一个，逐版本推进。

## 安装

需要 DSH `0.1.5-rc.2`，并装有 Google Chrome 或 Microsoft Edge（引擎跑在系统浏览器里，插件不自带浏览器内核）。

插件无需编译。使用已安装的 DSH CLI 安装并启动：

```sh
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-driver
dsh --profile web
```

启动后，直接让 Agent 处理表格即可——例如"把 data 目录下的 q2.xlsx 导入，加一列合计再导出"。

无头 profile 同样可用（该插件只添加工具，不依赖 Web UI）：

```sh
dsh plugin --profile sjs add @grapecity-software/dsh-spreadjs-driver
dsh --profile sjs "在工作目录建一个新表格并导出 xlsx"
```

也可以通过 npx 安装并启动：

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile web add @grapecity-software/dsh-spreadjs-driver
npx --yes @deepseek-ai/dsh@latest --profile web
```

从本地 tarball 安装（开发用）：

```sh
dsh plugin --profile web add ./grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

## 提供的工具

插件内置一个薄编排 skill（`spreadjs`）与以下工具：

| 工具 | 用途 |
| --- | --- |
| `sjs_new` | 为一张新表创建工作簿。 |
| `sjs_import` | 将已有的 `.xlsx` / `.csv` / `.ssjson` 引入为工作簿。 |
| `sjs_status` | 查看工作表、尺寸与已用区域。 |
| `sjs_execute` | 对工作簿执行 SpreadJS JavaScript（完成窄工具无法表达的复杂编辑）；执行后自动保存文件。 |
| `sjs_live_execute` | 对**用户在设计器里正打开的那个工作簿**执行 SpreadJS JavaScript（跑在用户浏览器里）——改动立刻上屏，除非显式传 `save: true`，磁盘文件不动。仅 web profile 可用，且要求设计器里确实打开着文件。 |
| `sjs_screenshot` | 视觉快照：`png` 对活动工作表做像素渲染，或 `pdf` 打印布局快照。 |
| `sjs_export` | 产出你要打开的文件：`.xlsx`、`.csv`、`.pdf`，或 `.ssjson` 副本。 |
| `sjs_worktree` | 为已提交的工作簿创建隔离的草稿快照（`create`），或列出打开的草稿（`list`）。 |

### 关于那两个文件

你面对的是 **`.xlsx`**。它旁边还有一份 **`.ssjson`** 同伴文件——那是 SpreadJS 自己的
无损格式，也是引擎每次调用真正读写的对象。它**是给程序看的**：你不需要打开它，
Agent 也被要求不要把它带进对话。

数据流是刻意**单向**的：

```
你的 .xlsx  ──sjs_import──▶  .ssjson（工作文件）  ──sjs_export──▶  你打开的 .xlsx
```

导出的 `.xlsx` **永远从工作文件派生，而不是从上一个 `.xlsx` 再导入**。每次编辑都往
Excel 里绕一圈，会让 `.xlsx` 转换固有的细小损耗逐次累积；单向流动则把损耗限制在
「一次导入 + 一次导出」之内。

导出同时也是刷新已有 `.xlsx` 的方式：更早导出的文件在此后继续编辑就会变旧，
需要就重新导一次，别默认它是最新的。

## 典型流程

用自然语言描述你想要的表——Agent 会遵循 skill 的推荐流程：定位或新建工作簿，非平凡改动先建草稿（worktree），用 `sjs_execute` 小步编辑并核验，最后用 `sjs_screenshot`/`sjs_export` 交付成品。

例如："做一个月度销售表：表头一行、四个产品行、加一列 SUM，最后导出成 Excel。"

也可手写编辑：`sjs_execute` 运行一个 async 函数体，作用域含 `spread`/`workbook`、`GC`、`sheet(name?)`、仅限工作区的 `io`、`console` 与 `snapshot()`（**没有** `require`、`process`、`fs`）：

```js
const s = sheet()
s.setValue(0, 0, '产品'); s.setValue(0, 1, '数量')
for (let r = 1; r <= 4; r++) { s.setValue(r, 0, 'SKU-' + r); s.setValue(r, 1, r * 10) }
s.setFormula(5, 1, '=SUM(B2:B5)')
return { total: s.getValue(5, 1) }
```

完整的工具地图、执行环境契约与错误码恢复表见 `skills/spreadjs/SKILL.md`；引擎运行时的嵌入方式见 `docs/architecture.md`。

## 让别的 SpreadJS 插件用上我们

`sjs_*` 那些工具只是这个插件的一半。另一半是一个客户端服务——`spreadjsHostBridge`。
它存在的意义是：**任何一个已经在页面上渲染 SpreadJS 工作簿的 DSH 插件，都可以把那份工作簿
借给 Agent**，从而白得一个「用自然语言改自己那份活文档」的能力，一行 Agent 代码都不用写。

之所以成立，是因为 DSH 客户端插件的浏览器半**不是沙箱**：所有插件的客户端半被加载进同一个
页面、同一个 JS realm、同一个堆，所以工作簿是**以引用而非副本**过去的。不序列化、不走 HTTP、
不落文件。宿主插件继续渲染的就是 Agent 刚写过的那个对象，改动落地即上屏；而且因为它落在
活文档上，**不会覆盖用户尚未保存的编辑**——这一点是按文件走的路子给不了的。

### 契约

```ts
// 你的插件/src/client/index.ts
const BRIDGE_SERVICE = 'spreadjsHostBridge'

interface SpreadjsHostBridge {
  attach(provider: SpreadjsWorkbookProvider): () => void
  list(): readonly string[]
}

interface SpreadjsWorkbookProvider {
  readonly id: string                   // Agent 靠它寻址
  getWorkbook(): unknown | undefined    // 你的活 Workbook；没打开时返回 undefined
  getNamespace?(): unknown              // SpreadJS 命名空间，会作为 `GC` 注入 Agent 代码
  getActivePath?(): string | undefined  // 会随每次编辑回报给 Agent
  save?(): Promise<void>                // 仅在 Agent 明确要求保存时被调用
}

export function apply(ctx: ClientContext): void {
  ctx.inject([BRIDGE_SERVICE], (child) => {
    child.effect(() => {
      const bridge = child.get(BRIDGE_SERVICE) as SpreadjsHostBridge | undefined
      if (bridge === undefined) return
      const release = bridge.attach({
        id: 'my-designer',
        getWorkbook: () => workbookRef.current,
        getNamespace: () => GC,
        getActivePath: () => pathRef.current,
        save: () => persistToDisk(),
      })
      return () => release()          // 面板卸载时**必须**调用
    }, 'my-plugin: spreadjs bridge')
  })
}
```

`getNamespace` 不是装饰：Agent 代码里注入的名字是 `GC`，脚本一旦要用枚举——比如
`GC.Spread.Sheets.UsedRangeType`、某个图表类型、某个对齐常量——没有它就根本跑不起来。
`save` 同样是可选的，而且只有显式传 `save: true` 才会走到，绝不会作为编辑的副作用被调用。

### Agent 因此获得什么

`sjs_live_execute`，通过它的 `target` 参数按你的 `id` 寻址。作用域与 `sjs_execute` 一致——
`spread`、`workbook`、`GC`、`sheet()`、`snapshot()`、`console`——唯独没有 `io`：`io` 由引擎
自己的回环服务提供，而这段代码跑在用户浏览器里。

**磁盘文件不动。** 编辑只活在活工作簿里，直到 Agent 显式要求保存——那是唯一会调用你的
`save()` 的路径。这个默认值是刻意的：Agent 应当能先提出一个用户看得见、撤得回的改动，
再谈落盘。

### 有几件事是刻意不做的

- **`attach` 不是双向的。** 这个桥只公开「**交出**工作簿」的方式，从不公开「**够到**工作簿」的
  方式。第三方插件即使拿到这个服务，也只能交出它本来就拥有的文档，看不见、也找不到、更改不了
  你的。
- **这个服务只存在于浏览器。** host 侧刻意**没有** `spreadjsHostBridge`，所以 Node 侧插件
  无法借这个引擎在服务端跑 SpreadJS。
- **对你没有任何强制要求。** 本插件不在场时 `ctx.inject` 不会触发，你的插件行为与从前完全一致；
  而 `attach` 返回的注销句柄会在卸载时释放引用，被销毁的文档不会被吊着不放。

`@grapecity-software/dsh-spreadjs-editor`（**0.1.5 及以上**）就是示范消费方：它的
`src/client/bridge.ts` 是这份契约的完整写法，依赖方向为什么是这样，记在
`docs/design-live-designer-bridge.md`。版本下限是有意义的——更早的编辑器里根本没有这个桥，
联动会**静默缺席**而不是报错，`sjs_live_execute` 只是永远找不到设计器。

> `subscribe` 目前只在 provider 接口上声明了，桥还没有读它——实现了也不会有效果。

## 说明

- 未授权引擎会标记它的产出，这是预期行为：png 渲染在画布上带 **"Evaluation Version"** 戳记，导出的 `.xlsx` 会多出一张同名工作表（`.pdf` 与 `.csv` 没有）。**刻意保留、不做清除**——插件不清，Agent 也不应去清。它不影响数据。
- 截图 `png` 是引擎在真实浏览器里的原始渲染：字体、字重、颜色都是真的；截图绝不修改工作簿文件。
- 本版本的 worktree 支持 `create`/`list`；审批（`merge`/`discard`）为后续阶段。
- `sjs_execute` 可驱动图表、形状、切片器与数据透视表（`shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` 包随插件一起分发）；png 截图会覆盖浮动对象，即使它位于已用单元格范围之外，或处于没有已用单元格的工作表（如透视表布局页）。
- 越界写入会自动扩展工作表而不是被丢弃；针对同一工作簿的操作串行执行，因此并行工具调用不会互相覆盖。
- 每次 `sjs_execute` 都在批处理模式下运行——重绘、变更事件与计算服务全部挂起，实测 2 万行带公式的填充快 3.6 倍。脚本中途若要读计算值需先 `spread.resumeCalcService()`；落盘与导出的值始终是完整计算过的。
- 当工作表超出 2600×2200 光栅上限时，png 结果会带 `clipped: true`，此时图片是裁剪版而不是报错。这些数字是 **CSS 像素**，而渲染是 **2 倍**的，所以结果里会报两个尺寸：`width`/`height` 是 CSS 像素（核对列宽算术时用的就是它），`pixels` 是文件本身的真实像素。

## 开发

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + export-integrity + tool-smoke
npm pack               # → grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

把 tarball 装进一个临时 profile，在真实会话中驱动这些工具做端到端冒烟。

## 许可证

MIT，见 `LICENSE`。所依赖的 `@grapecity-software/*`（SpreadJS）是独立产品，适用其自身的许可条款；本插件只负责把它接入 DSH。
