# dsh-spreadjs-excel

> 为 DeepSeek Harness (DSH) 提供 SpreadJS 电子表格能力：通过内置的 `sjs_*` 工具创建、查看、编辑、导入、导出与截图 `.xlsx`/`.ssjson` 工作簿。

[English](README.md) · 简体中文

`dsh-spreadjs-excel` 是 DeepSeek Harness 的 [SpreadJS](https://www.grapecity.com/spreadjs) 插件。它把 SpreadJS 引擎内嵌进 Agent 运行时，让 Agent 能够构建表格、写入数值与公式、调整工作表结构，并可视化地核验结果——最终交付可直接用 Excel、WPS Office 等兼容应用打开的 `.xlsx`（或 `.csv` / `.pdf`）。引擎跑在一个隐藏的系统浏览器里（每次操作现起一个，用户看不到，随操作结束一起退出）。

## 环境要求

- **Node.js ≥ 22.19**，以及 **DeepSeek Harness** 运行时（`@deepseek-ai/dsh` `0.1.5-rc.2`）。
- **宿主机需装有 Microsoft Edge 或 Google Chrome**。引擎运行在真实浏览器进程中（插件不自带浏览器内核，也不会弹出任何界面）。两者都在时优先用 Edge；可用插件配置 `browserPath` 指定具体可执行文件。都找不到时报 `SJS_BROWSER_UNAVAILABLE`，并在消息里列出探测过的路径。
- 需要一个可写的临时目录，用于浏览器的一次性 profile。
- `.pdf` 导出里若要保留中文，宿主机上至少要有可发现的支持 CJK 的 `.ttf`/`.otf` 字体（默认自动扫描系统字体目录；可通过环境变量 `GC_SJS_PDF_FONT_DIRS` 追加目录——不支持 `.ttc`）。`png` 截图不需要额外字体：浏览器自带真实字体。

**关于 DSH 版本区间。** `dsh.engines.dsh` 与各 `@deepseek-ai/*` peer 区间写的是精确版本 `0.1.5-rc.2`——既不是 caret，也不是拉长的列表。DSH 尚未 1.0，rc 之间就会有不兼容改动，所以这个插件能诚实声明的只有 CI 真跑过的那一个版本。对预发布版加 caret 等于默默承诺下一个 rc 也兼容；写 `>=` 则等于承诺永远兼容。将来 DSH 发新版、且在本地 CI 跑通之后，这个区间才会被显式抬到那个版本——一次一个，逐版本推进。

## 安装

在运行 DSH 的 profile 中，从 tarball 或 npm 仓库安装：

```
dsh plugin --profile <your-profile> add ./dsh-spreadjs-excel-<version>.tgz
# 发布后：
dsh plugin --profile <your-profile> add dsh-spreadjs-excel
```

确认插件已补丁加载：

```
dsh --profile <your-profile> --dump-config
```

## 提供的工具

插件内置一个薄编排 skill（`spreadjs`）与以下工具：

| 工具 | 用途 |
| --- | --- |
| `sjs_new` | 为一张新表创建工作簿。 |
| `sjs_import` | 将已有的 `.xlsx` / `.csv` / `.ssjson` 引入为工作簿。 |
| `sjs_status` | 查看工作表、尺寸与已用区域。 |
| `sjs_execute` | 对工作簿执行 SpreadJS JavaScript（完成窄工具无法表达的复杂编辑）；执行后自动保存文件。 |
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

## 说明

- 未授权引擎会标记它的产出，这是预期行为：png 渲染在画布上带 **"Evaluation Version"** 戳记，导出的 `.xlsx` 会多出一张同名工作表（`.pdf` 与 `.csv` 没有）。**刻意保留、不做清除**——插件不清，Agent 也不应去清。它不影响数据。
- 截图 `png` 是引擎在真实浏览器里的原始渲染：字体、字重、颜色都是真的；截图绝不修改工作簿文件。
- 本版本的 worktree 支持 `create`/`list`；审批（`merge`/`discard`）为后续阶段。
- `sjs_execute` 可驱动图表、形状、切片器与数据透视表（`shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` 包随插件一起分发）；png 截图会覆盖浮动对象，即使它位于已用单元格范围之外，或处于没有已用单元格的工作表（如透视表布局页）。
- 越界写入会自动扩展工作表而不是被丢弃；针对同一工作簿的操作串行执行，因此并行工具调用不会互相覆盖。
- 每次 `sjs_execute` 都在批处理模式下运行——重绘、变更事件与计算服务全部挂起，实测 2 万行带公式的填充快 3.6 倍。脚本中途若要读计算值需先 `spread.resumeCalcService()`；落盘与导出的值始终是完整计算过的。
- 当工作表超出 2600×2200 光栅上限时，png 结果会带 `clipped: true`，此时图片是裁剪版而不是报错。

## 开发

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + export-integrity + tool-smoke
npm pack               # → dsh-spreadjs-excel-<version>.tgz
```

把 tarball 装进一个临时 profile，在真实会话中驱动这些工具做端到端冒烟。

## 许可证

MIT，见 `LICENSE`。所依赖的 `@grapecity-software/*`（SpreadJS）是独立产品，适用其自身的许可条款；本插件只负责把它接入 DSH。
