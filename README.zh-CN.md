# dsh-spreadjs-excel

> 为 DeepSeek Harness (DSH) 提供 SpreadJS 电子表格能力：通过内置的 `sjs_*` 工具创建、查看、编辑、导入、导出与截图 `.xlsx`/`.ssjson` 工作簿。

[English](README.md) · 简体中文

`dsh-spreadjs-excel` 是 DeepSeek Harness 的 [SpreadJS](https://www.grapecity.com/spreadjs) 插件。它在 Agent 运行时中内嵌了一个无头 SpreadJS 引擎，让 Agent 能够构建表格、写入数值与公式、调整工作表结构，并可视化地核验结果——最终交付可直接用 Excel、WPS Office 等兼容应用打开的 `.xlsx`（或 `.csv` / `.pdf`）。

## 环境要求

- **Node.js ≥ 22.19**，以及 **DeepSeek Harness** 运行时（`@deepseek-ai/dsh` `0.1.1-rc.2` 或 `0.1.2-rc.1`）。
- `.pdf` 导出与含中文的 `png` 截图需要宿主机上至少有一个可发现、支持 CJK 的 `.ttf`/`.otf` 字体（默认自动扫描系统字体目录；可通过环境变量 `GC_SJS_PDF_FONT_DIRS` 追加目录——不支持 `.ttc`）。

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
| `sjs_new` | 新建空 `.ssjson` 工作簿。 |
| `sjs_import` | 将 Excel `.xlsx`、`.csv` 或 `.ssjson` 导入为规范的 `.ssjson`。 |
| `sjs_status` | 查看工作表、尺寸与已用区域。 |
| `sjs_execute` | 对工作簿执行 SpreadJS JavaScript（完成窄工具无法表达的复杂编辑）；执行后自动保存文件。 |
| `sjs_screenshot` | 视觉快照：`png` 对活动工作表做像素渲染，或 `pdf` 打印布局快照。 |
| `sjs_export` | 导出为 `.xlsx`、`.csv`、`.ssjson` 或 `.pdf`。 |
| `sjs_worktree` | 为已提交的工作簿创建隔离的草稿快照（`create`），或列出打开的草稿（`list`）。 |

`.ssjson` 是本插件的规范工作区格式：无损、JSON、也是工具直接编辑的唯一格式。真实文件经 `sjs_import` 进入、经 `sjs_export` 离开。

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

完整的工具地图、执行环境契约与错误码恢复表见 `skills/spreadjs/SKILL.md`；无头引擎的嵌入方式见 `docs/architecture.md`。

## 说明

- `sjs_screenshot` 的 png 渲染带 **"Evaluation Version" 水印**（未授权引擎会在它绘制的画布上盖章）；PDF 导出与导出的 `.xlsx` / `.csv` / `.ssjson` 文件均不带水印。这是引擎的预期行为，不影响功能。
- 截图 `png` 的文字会统一用一种可读的中文字体重绘，因此图像中逐格字体/字重差异会被拉平——**仅影响图片**；截图绝不修改工作簿文件。
- 本版本的 worktree 支持 `create`/`list`；审批（`merge`/`discard`）为后续阶段。
- `sjs_execute` 可驱动图表、形状、切片器与数据透视表（`shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` 包随插件一起分发）；png 截图会覆盖浮动对象，即使它位于已用单元格范围之外，或处于没有已用单元格的工作表（如透视表布局页）。
- 越界写入会自动扩展工作表而不是被丢弃；针对同一工作簿的操作串行执行，因此并行工具调用不会互相覆盖。
- 当工作表超出 2600×2200 光栅上限时，png 结果会带 `clipped: true`，此时图片是裁剪版而不是报错。

## 开发

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + tool-smoke
npm pack               # → dsh-spreadjs-excel-<version>.tgz
```

把 tarball 装进一个临时 profile，在真实会话中驱动这些工具做端到端冒烟。

## 许可证

MIT，见 `LICENSE`。所依赖的 `@grapecity-software/*`（SpreadJS）是独立产品，适用其自身的许可条款；本插件只负责把它接入 DSH。
