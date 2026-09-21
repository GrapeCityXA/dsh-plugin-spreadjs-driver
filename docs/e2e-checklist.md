# 任务 7 · E2E 验收清单

发布 1.0 前的人工验收。**CI 已覆盖无 LLM 全链回归**（见 §1，`pnpm run ci` 全绿即可）；
本节覆盖 CI 盖不到的两类：**真实 Agent 会话**（§2–§3）与 **真实 Excel/WPS 文件双向兼容**（§4），
外加任务 6 延后到本任务的两个 live-session 确认（§5）。

---

## 0. 前置（每次验收先核对）

| 项 | 期望 | 核对命令 |
|---|---|---|
| 打包并重装进 `spjs` profile | tarball 9 文件、44.7kB 级 | `npm pack`；`dsh plugin --profile spjs add ./grapecity-software-dsh-spreadjs-driver-<ver>.tgz` |
| patch 层生效 | dump 出现 `# == @grapecity-software/dsh-spreadjs-driver` | `dsh --profile spjs --dump-config` |
| 工具可枚举 | `sjs_new/import/export/status/execute/screenshot/worktree` | profile 会话 `/tools` 或 settings |
| 工作区含 fixture | 两份真实形状 xlsx | `node scripts/make-fixtures.mjs` 后拷到会话 data/ |
| 中文字体（PDF/PNG 可选） | 至少一个 .ttf/.otf 非 .ttc | 有 Windows 字体即满足；否则 `GC_SJS_PDF_FONT_DIRS` |
| 版本基线 | DSH `0.1.5-rc.2`、Node ≥22.19 | `dsh --version`、`node -v` |

fixture 数值基线（与 Excel/WPS 重算结果应一致）：
- `工资表2026-05.xlsx` — 15 名员工，`实发工资 = 基本 + 绩效 − 社保`（公式），合计行 实发总额 **147,136**。
- `q2-sales-2026.xlsx` — 60 行订单，`销售额 = 单价×销量`（公式），数据首行 998（499×2），销售额合计 **121,239**。

> 两者经真实 xlsx 往返（SpreadJS 导出 → 再导入）已验证公式存活、值可重算；上方两个合计即 xlsx 往返后由 worker 重算的结果。

---

## 1. 无 LLM 回归（CI 已盖，本机可复跑）

```bash
pnpm run ci
```

各段覆盖：typecheck（tsc --noEmit）→ `verify:public-dependencies`（禁 file:/link:/git: 运行时依赖）
→ build（host bundle + worker）→ `test:worker`（信封/错误码/导入导出/pdf/png，23 步）
→ `test:integrity`（**独立读字节**：zip 每个条目的 CRC-32/尺寸、CJK 字节级一致、公式的缓存值、
数字格式、往返；PDF 的字体是否真的**嵌入**（子集前缀 + FontFile 流）而非仅具名；PNG 真实墨迹与
IHDR 尺寸，14 步。reader 在 `test/lib/`，不 import `src/`、`lib/` 或任何 `@grapecity-software/*`）
→ `test:tool`（cordis 全链 + worktree + skill 注册，28 步）→ `verify:pack`（tarball 必备运行时文件）
→ `test:pack`（把 tarball 当安装抽进 node_modules、从 packed `lib/index.js` 引导 cordis、真跑 worker + `skills.list`）。

> `test:worker` 对产物的校验是**魔数与长度**级的（xlsx 看 `PK`、pdf 看 `%PDF`、png 看 `PNG` 且
> `>1000` 字节）；结构损坏、内容错误、空壳 PDF、空白帧都能穿过。**产物的字节级正确性由
> `test:integrity` 负责**——它用与写方无共享代码的 reader 复读导出结果，这是两条互补的网，不是重复。

## 2. Agent 全链路 A · 工资表指令（建簿→公式→截图→导出）

在真实 DSH 会话（profile `sjs`，无头工作区指向一个空目录）下达：

> 新建一个工资表工作簿：表名「工资表2026-05」，列标题 序号/姓名/部门/基本工资/绩效工资/社保扣款/实发工资。
> 录入至少 15 名员工（含中英文混合姓名、销售/技术/财务/行政等部门），基本工资 6000–11000。
> 实发工资用公式 = 基本 + 绩效 − 社保；末行加合计。检查渲染后用截图看一眼，再导出 .xlsx 和 .pdf。

通过标准（逐项勾）：
- [ ] 走 SKILL 推荐流：`sjs_new → sjs_execute（写数据+公式）→ sjs_status（核对 used range/表名）→ sjs_screenshot → sjs_export`，无无效往返。
- [ ] 产物 `.xlsx` 用真实 Excel **与 WPS** 打开：中文不乱码、表名在、合计公式可算且与 Excel 重算一致；**列宽足以完整显示内容**（内容不被截断、不出现肉眼过窄的列）。
- [ ] 导出 PDF 有字（非空壳）、无授权水印；无字体环境时报 `SJS_PDF_FONT_UNAVAILABLE` 且会话能据此恢复。
- [ ] 未授权标记符合预期且**未被模型动过**：png 画布带 `Evaluation Version` 戳记，导出的 xlsx 多一张同名工作表（pdf/csv 没有）；模型**没有**手工改 xlsx 去删这张表，也没有为它浪费调用。

## 3. Agent 全链路 B · 读真实 xlsx 做管理看板

会话工作区放 `q2-sales-2026.xlsx`。下达：

> 读取 data/q2-sales-2026.xlsx（60 行订单明细）。先把它转成工作簿，另开一个「区域看板」表：
> 按 区域 汇总 销售额 与 订单数（华东/华北/华南/西南/华中），并给出全表销售额合计。核对后截图。

工具契约提醒（模型靠 SKILL）：`sjs_import` 只认 `.xlsx/.csv/.ssjson → .ssjson`；`sjs_*` 都以 `.ssjson` 为源。

通过标准：
- [ ] 区域汇总 × Excel 透视/SUMIF 重算一致（合计 **121,239**）；订单数合计 60。
- [ ] 看板在独立 sheet、模型描述了方法（分组/SUMIF 或执行兜底），无幻觉列。
- [ ] 截图清晰可辨（中文渲染、数值可读）。

## 4. 真实 Excel/WPS 文件双向兼容（需装有 Excel/WPS 的机器，人工执行）

**Leg 1 · Excel/WPS → DSH**：任选 ≥2 份真实文件（建议含中文表头、公式、合并单元格、多 sheet；可用下面模板另存扩充）：
1. 用 Excel 打开 `examples/fixtures/*.xlsx` → 改 1–2 个单元格 → 另存为 `_fromExcel.xlsx`（WPS 同样另存一份）。
2. `sjs_import` 两份 → `sjs_status`/`sjs_execute` 抽查改动点仍在、公式列可重算、中文不乱码。

**Leg 2 · DSH → Excel/WPS**：取 §2/§3 导出产物（或 fixture 副本）：
1. Excel 与 WPS 分别打开：无修复提示或仅水印提示；公式可算；中文、列宽、表名保留。
2. 另存（原格式）后再导回 DSH，内容不丢 —— 二次往返闭合。

> 边界：只支持 `.xlsx/.csv/.ssjson`；旧 `.xls` 需先在 Excel/WPS 另存为 `.xlsx`。

## 5. 任务 6 延后的 live-session 确认

### ① spreadjs skill 出现在 system prompt（registry 级已验证，待端到端确认）
起真实会话（`sjs` profile），查第一轮 system prompt / 会话工具说明中含 spreadjs skill 正文：工具地图 8 行、Recommended flow、「未知 API 先查证再写代码」。通过标准：模型无需外挂即能说出推荐流与错误码恢复表。

### ② sjs_screenshot png 回传 Agent 可见（read_image 模式）
呈现面裁决：DSH `0.1.5-rc.2` 的 Client **不消费插件的 `presentCall`/`presentResult`**（`dsh-client-ui-tool` 的说明原文：卡片只从第一方原始事件字段派生，"Host `presentCall` and `presentResult` values never enter the Client"），因此插件无法自带 image/file 工具结果卡片；Agent 可见图 = `ctx.attachments.saveImage` + image ContentBlock（官方 `read_image` 模式），需视觉路由。
- **已接入（task 7）**：`sjs_screenshot` png 在 ①当前路由声明 image 输入（经 `llm.resolveModelInfo`）②attachments 存储已挂 ③部署接受 `image/png` 时，自动把 png 存为 durable attachment 并附 image block；任一条件不满足则静默回退纯文本 + 文件路径（附 PDF 兜底建议）。**CI 已无头覆盖两条路径**（无 store → 文本回退；stub store + image 路由 → image block + saveImage 收到真实字节）。
- **仍待人工**：在**真实视觉模型会话**让模型截图并"看"内容，确认 png 真被模型读到、无 store 的纯文本回退下模型能用 `read_image`/路径接续。客户端内联渲染归阶段 2。

## 6. 记录模板

```
date / DSH ver / plugin ver / profile / node ver:
A 工资表      : 建簿[ ] 公式重算[ ] Excel开[ ] WPS开[ ] PDF[ ] 截图[ ]
B 销售看板    : 区域汇总=121239[ ] 订单60[ ] 截图[ ] 方法描述[ ]
Leg1 Excel→DSH: [ ]   WPS→DSH: [ ]    改动保留/公式可算/中文OK
Leg2 DSH→Excel: [ ]   DSH→WPS: [ ]    水印预期/公式/中文/列宽
§5① skill 进 system prompt : [ ]   ② png 回传视觉实测 : [ ]  （或 记录为1.0边界）
```
