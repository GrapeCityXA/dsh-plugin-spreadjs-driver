# 设计方案 · 引擎运行时从 jsdom 迁到真实浏览器

**状态**：草案
**决策**：**采用系统已安装的 Edge/Chrome**（不自带浏览器二进制）

---

## 1. 是什么

### 现在

```
插件 host 进程 → 起一个 Node 子进程（worker）
                   └─ jsdom（假 DOM）+ node-canvas（原生垫片）
                        └─ 让 SpreadJS 以为自己在浏览器里
```

### 目标

```
插件 host 进程 → 起一个真实浏览器进程（系统 Edge/Chrome，headless，用户不可见）
                   └─ 页面里加载 SpreadJS 的 UMD 构建
                        └─ 真 DOM、真 canvas、真字体
```

**只换 worker 的"肚子里"**，对上层透明。

---

## 2. 为什么换

| 理由 | 说明 |
|---|---|
| **产品叙事**（主因） | "Node.js 里跑 SpreadJS" 这种用法不宜对外暴露 |
| **无需自证** | SpreadJS 在浏览器里的行为已被广泛验证，没有我们要额外验证的东西 |
| **顺带修掉三类缺陷** | 我们已经为 jsdom 的差异付过三次代价：`ArrayBuffer` 跨 realm、`Date` 跨 realm（曾导致日期静默写成 1899 年）、`CanvasRenderingContext2D` 缺失（带数字格式的表截图/PDF 必崩）。**这三类问题在真浏览器里整类消失** |
| **截图保真度** | 现在整表被强制成单一 CJK 字体（逐格字重/字体被拉平）、无 subpixel；真浏览器下即为真实渲染 |
| **外部佐证** | 编辑器插件的 `scripts/smoke-client.mjs` 明确写道：完整加载 "requires a real browser: SpreadJS touches DOM + canvas at module init, **which jsdom cannot satisfy** without the native `canvas` package" |

---

## 3. 爆炸半径

```
✅ 不受影响：host 层全部 —— 7 个工具、provider、config、工作区越权校验、
             worktree、presentation、错误码体系、SKILL、pack 校验、CI 结构
🔧 必须重写：src/workers/sjs/**（jsdom 引导、worker 协议、IO）
➕ 新增：一个浏览器侧 entry（页面脚本）
```

host 层只通过**协议**与"一个 worker"对话，换掉 worker 的实现，上层不需要动。**这是本方案最大的有利条件。**

---

## 4. 运行时选型

### 4.1 用系统浏览器，不自带

| | 自带（Playwright/Puppeteer 完整版） | **系统 Edge/Chrome（选定）** |
|---|---|---|
| 包体积 | 0.91 MB → 150–300 MB | **基本不变** |
| 可靠性 | 到处都能跑 | 需要机器上有浏览器 |
| 版本可控 | ✅ | 随用户机器 |

驱动库建议 **`playwright-core`**（**不含浏览器二进制**，体积小），用其 `channel: 'msedge' | 'chrome'` 直接驱动系统已安装的浏览器；`puppeteer-core` 亦可，但需自己定位 `executablePath`。

> ⚠️ 需一次**小规模验证**：`playwright-core` 的 `channel` 在目标平台上能否正确发现系统 Edge/Chrome，以及找不到时的报错是否可读。

### 4.2 页面里怎么加载 SpreadJS —— 已核实可行

各 `@grapecity-software/spread-sheets*` 包都带**浏览器 UMD 构建**，命名规律一致：

```
spread-sheets/dist/gc.spread.sheets.all.min.js      5.52 MB
spread-sheets-io/dist/gc.spread.sheets.io.min.js    0.61 MB
spread-sheets-charts/dist/gc.spread.sheets.charts.min.js   3.19 MB
spread-sheets-pdf/dist/gc.spread.sheets.pdf.min.js  1.94 MB
spread-sheets-shapes/dist/gc.spread.sheets.shapes.min.js   0.93 MB
spread-sheets-pivot-addon/dist/gc.spread.pivot.pivottables.min.js  0.95 MB
```

**做法**：建一个空白页，按现有顺序把需要的 UMD 注入（`page.addScriptTag({ path })` 指向插件 `node_modules` 里的文件），再执行我们的初始化。**不需要把 SpreadJS 打进我们的产物**（编辑器插件是把 SpreadJS 内联进它的 client bundle 的，我们不必如此——我们不是要发布给浏览器加载的插件，而是自己起页面）。

---

## 5. 必须重新决定的四件事

### ① 进程模型：一次性 → 常驻浏览器 + 页面池

今天：一次调用一个进程，超时强杀。**进程隔离是 `sjs_execute` 跑任意代码的唯一依靠。**

浏览器启动 1–3 秒，不可能一次一开。必须常驻浏览器。

**隐患**：页面不是进程。**一个操作把浏览器搞死会连累其他操作** → 需要每页看门狗 + 浏览器级重启策略。`SJS_WORKER_TIMEOUT` 的语义变为"杀页面（必要时重启浏览器）"。

**建议**：**常驻浏览器进程 + 每次操作开新页面**。

| | 每次开新页面 | 常驻页面（状态留在页面里） |
|---|---|---|
| 隔离性 | ✅ 与今天一致（每次干净 realm） | ❌ 会串状态 |
| 大表性能 | ❌ 每次要搬内容 | ✅ 快 |
| 状态管理 | ✅ 文件仍是唯一事实源 | ❌ 脏状态、逐出、崩溃恢复 |

选前者，保住"干净上下文"与"文件是事实源"这两条**已验证**的性质。代价是大表传输要优化。

### ② 文件 IO 必须搬出引擎 —— 最大的新约束

浏览器没有 fs。协议变成：

```
host：读文件 + 工作区越权校验（现有 assertAuthorizedPath 继续有效）
  → 把内容交给页面
页面：纯 SpreadJS 计算
  → 把结果交回
host：原子写盘
```

⚠️ **注意这个数字**：P1 实测，10 万行工作簿的 ssjson 是 **232 MB**。今天这份数据**从不离开 worker 内存**；改造后**每次操作都要搬一遍**。大表性能会退化，需要针对性优化（例如只在需要时传必要区域、或对同一页面的连续操作复用已加载内容）。

### ③ 分发与环境要求

- 包体积基本不变（用系统浏览器）
- **但新增了运行时要求**：机器上要有 Edge 或 Chrome。缺失时必须有**清晰可执行的错误提示**（而不是诡异失败）
- **CI 要确认**：GitHub Actions 的 ubuntu 镜像是否自带 Chrome（据我所知有，但**需实测确认**），否则要加安装步骤

### ④ SKILL、错误码、CI 断言要跟着改

| 项 | 变化 |
|---|---|
| `SJS_PNG_FONT_UNAVAILABLE` / `SJS_PDF_FONT_UNAVAILABLE` | **变成死代码**（浏览器有字体）→ 删除或保留为不可能分支 |
| SKILL "截图字体被扁平化" | **不再成立** → 删除该说明 |
| SKILL 布局/渲染相关的说明 | 需复查（如列宽像素换算仍然成立，但"截图是扁平化的近似"这条要改） |
| CI | worker-smoke 里与 jsdom 特性相关的断言需复核；可能新增"浏览器不可用时的降级"用例 |
| 三个 jsdom realm 工作区（`canvas` 构造器注入、`Date` 注入、FileReader 的 ArrayBuffer 补丁） | **全部删除**——连同它们对应的 SKILL/文档说明 |

---

## 6. 建议分期

| 阶段 | 内容 | 产出 |
|---|---|---|
| **0 · 验证 spike** | 系统 Edge/Chrome 能否被 `playwright-core` 驱动；UMD 注入后 SpreadJS 能否初始化；一次 `fromJSON` → `setValue` → 导出 xlsx 走通 | 一份 spike 报告 + 结论 |
| **1 · 页面协议** | 定 host↔页面 的消息协议（复用现有信封思路：单请求 + 单响应 + 错误码）；大内容传输方案 | 协议文档 |
| **2 · 迁移 worker** | 按现有 `SjsWorker` 接口实现浏览器版：常驻浏览器 + 每次新页面 + 超时/强杀 | 新的 worker 实现 |
| **3 · 切流** | 默认走浏览器；清理 jsdom 路径与相关文档/CI 断言 | 全绿 |
| **4 · 清理** | 删除 `jsdom` / `canvas` 依赖、`headless.ts` 的垫片、三个 realm 工作区 | 依赖瘦身 |

> 阶段 3 之前**保持双实现**（配置选 `runtime: 'jsdom' | 'browser'`），这样迁移过程始终有一条**已验证的退路**。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 常驻浏览器内存随时间增长 | 空闲逐出 + 定期重启 + 页面数上限 |
| 浏览器被一个坏操作搞死，连累并发操作 | 每页看门狗 + 浏览器存活探测 + 自动重启后重试一次 |
| 目标机器没有 Edge/Chrome | 启动时探测并给出**可执行的**错误信息；文档写明前置条件 |
| 大表传输成为新瓶颈 | 阶段 1 专门设计；必要时"同页面连续操作复用已加载内容" |
| 迁移期间两套实现漂移 | 阶段 3 前双实现，同一套 worker-smoke 对两者都跑 |

---

## 8. 与"活工作簿联动"的关系

**两条线互相独立，可并行**：

- 本方案换的是**我们自己起的、用户不可见的浏览器**里的引擎
- 联动方案用的是**用户正开着的那个浏览器**里的设计器实例

两者**不会也不能互相替代**：前者保证无头能力，后者保证"改动落在用户正看着的文档上"。即便本方案落地，联动仍然需要用户浏览器里的那个对象。

唯一可能的交集：本方案的浏览器进程若空闲，理论上可用来跑"预览渲染"（把用户的活文档快照到我们自己的浏览器里出高质量图），但那是二期的事。
