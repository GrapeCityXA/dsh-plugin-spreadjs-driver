# 测试计划 · dsh-spreadjs-excel 1.0

`pnpm run ci`（worker-smoke + tool-smoke + pack 校验 + 从 pack 冒烟）是无 LLM 的
**回归网**；`docs/e2e-checklist.md` 是发版前的**人工验收**。本文是两者的补充：按
风险维度穷举用例，标注覆盖状态，未覆盖的留给下一轮。

图例：✅ CI 已覆盖 ｜ 🧪 已手工验证 ｜ ⬜ 待测 ｜ ⚠️ 已知限制

---

## A. 数据完整性（最高风险：静默失败）

引擎的默认行为里有几处**不报错的丢数据**，已针对性加固，回归钉在 CI。

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| A1 | 写入超过默认行列（200×20） | ✅ | 自动扩容至 1,048,576×16,384；超上限报 `SJS_SHEET_LIMIT_EXCEEDED`。回归：tool-smoke「grows the sheet」 |
| A2 | 扩容后公式重算 | ✅ | 同一回归步断言 `=SUM(A1:A5000)` 得 12,497,500 |
| A3 | 并发编辑同一工作簿 | ✅ | host 层按工作簿路径串行；6 路并发全保留。回归：tool-smoke「concurrent edits」 |
| A4 | 不同工作簿并发 | ✅ | 各走各的链，互不阻塞（同上回归的隐含前提） |
| A5 | xlsx 往返保真：公式/样式/合并/列宽 | 🧪 | fixtures 往返已验证公式存活；样式待逐项核对 |
| A6 | xlsx 往返保真：条件格式、数据验证、批注、图片、定义名称 | 🧪 | **Leg 1 已验（2026-09-15，独立复核）：6/6 保留**。两处表示变化：图片经 xlsx 往返后进 `shapes` 而非 `pictures`（用 `pictures.all()` 会误报丢失）；数据验证边界变公式字符串 `"=1"`。Leg 2（真实 Excel/WPS 另存后再导入）仍未测 |
| A7 | 大文件导入（5–10 万行 xlsx） | ⬜ | 未测耗时/内存；2 万行写入约 3.5s 可作参考 |
| A8 | 空单元格 / 稀疏区域写入 | ⚪ | 未测 |
| A9 | 公式引用越界（`=A9999999`）、循环引用 | ⬜ | 未测 |

## B. 渲染与截图

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| B1 | 常规表截图（值/色/边框/合并/CJK） | ✅ | worker-smoke + tool-smoke |
| B2 | 带数字格式的表 | ✅ | 回归「renders a formatted sheet」（曾因缺 canvas 构造器全局必崩） |
| B3 | 视口外的浮动对象（图表） | ✅ | 回归「covers a chart placed outside the used range」 |
| B4 | 无已用范围的透视表页 + 越界切片器 | ✅ | 回归「covers a pivot sheet whose slicer sits past the viewport」 |
| B5 | 超大表：精确测算 + 超限裁剪 | ✅ | 回归「measures content exactly and clips past the raster ceiling」；`clipped: true` |
| B6 | 空表截图 | 🧪 | 回退到 900×400 视口，产出合法 png |
| B7 | 隐藏行列 | ⬜ | 代码按「隐藏占 0 像素」处理，**未经实测** |
| B8 | 冻结窗格对截图的影响 | ⬜ | 未测 |
| B9 | 多 sheet 选页（`setActiveSheetIndex`） | 🧪 | 透视表验证时用过；无专项断言 |
| B10 | 超长文本/换行的单元格 | ⬜ | 未测 |

## C. 错误恢复与模型可用性

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| C1 | 非法表名 | ✅ | `SJS_SHEET_NAME_INVALID`，指出具体违规字符。回归：tool-smoke |
| C2 | 不存在的表名 | ✅ | `SJS_SHEET_NOT_FOUND`（tool-smoke 已覆盖 `sheet(name)` 路径） |
| C3 | 脚本抛错 / 语法错误 | ✅ | 均归 `SJS_SCRIPT_ERROR`（tool-smoke） |
| C4 | 返回超大结果 | 🧪 | `SJS_RESULT_TOO_LARGE`（>200k 字符）正确触发 |
| C5 | 死循环 → 超时 | 🧪 | 超时被杀，**文件字节不变**（不会写坏） |
| C6 | 超时后同会话继续可用 | ⬜ | 未测：worker 是否留残留 / 队列是否恢复正常 |
| C7 | 模型据错误码自愈（真实会话） | ⬜ | 需真实会话观察：给一个不存在的 sheet，看它是否按 SKILL 表自愈 |

## D. 安全边界

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| D1 | 工作区越界路径 | ✅ | host 层 `SESSION_SCOPE_DENIED`（tool-smoke） |
| D2 | worker 层是否限制路径 | 🧪 | **不限制**（设计如此）：worker 只收 host 已授权的绝对路径，闸门在 host |
| D3 | `sjs_execute` 逃逸 `require`/`process`/`fs` | 🧪 | vm 上下文未注入；tool-smoke 有 `io` 越界用例 |
| D4 | 畸形 ssjson / 超深嵌套 / 巨大文件 | ⬜ | 未测 |
| D5 | 导入恶意 xlsx（zip 炸弹等） | ⬜ | 未测 |

## E. 会话级与 Agent 行为

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| E1 | 工资表全链路（建簿→公式→截图→导出） | 🧪 | E2E 通过；修复后 25 次调用/20 步 |
| E2 | 读真实 xlsx 做看板 | 🧪 | E2E 通过（区域汇总 121,239） |
| E3 | 真实 Excel/WPS 双向 | 🧪 | 人工验收通过 |
| E4 | `sjs_worktree` 真实使用 | ⬜ | **两次 E2E 里模型一次都没用过**——是不知道还是不需要？值得单独测 |
| E5 | 平行工具调用（模型并行下发） | ⬜ | 已从 host 层加固，但未在真实会话观察模型是否/如何并行 |
| E6 | 长会话（20+ 轮）稳定性 | ⬜ | 未测 |
| E7 | 两个 dsh 会话同工作区 | ⬜ | 跨进程无锁；同 #A3 但跨进程，未测 |
| E8 | 中途中断/取消 | ⬜ | 未测 |

## F. 格式与内容

| # | 用例 | 状态 | 说明 |
|---|---|---|---|
| F1 | CSV 导入导出（中文） | ✅ | worker-smoke 覆盖 UTF-8 往返 |
| F2 | CSV：BOM/GBK 编码、逗号引号转义 | ⬜ | 未测 |
| F3 | 日期与 Excel 序列号、时区 | ⬜ | 未测 |
| F4 | 浮点精度（`0.1+0.2`） | ⬜ | 未测 |
| F5 | emoji / 超长表名 | 🧪 | emoji ✅；>31 字符现按 Excel 规则拒绝 |
| F6 | 错误公式（`#DIV/0!`、`#REF!`） | ⬜ | 未测 |
| F7 | 图表/透视表/切片器 | 🧪 | 建表 + 渲染均已验证；导出到 xlsx 后 Excel 能否打开未测 |

---

## 已知限制（非缺陷，写入文档即可）

- 只支持 `.xlsx / .csv / .ssjson`；旧 `.xls` 需先另存。
- png 带 `Evaluation Version` 水印；PDF/导出文件无水印（设计如此）。
- 截图文本统一重绘为单一 CJK 字体，逐格字体差异被拉平（仅影响图片）。
- 纯文本模型路由下 png 进不了上下文，`read_image` 同样会拒绝。
- worktree 仅 `create`/`list`，无 `merge`/`discard`。
