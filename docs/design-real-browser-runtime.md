# 设计方案 · 引擎运行时从 jsdom 迁到真实浏览器（含阶段 2：常驻引擎）

**状态**：**阶段 1 已落地（2026-09-17）；阶段 2 常驻引擎已落地（2026-09-20）**。本文由"计划书"改写为"实际建成的东西 + 实测数字"，并逐条列出与原计划的偏差。阶段 2 的结论与数字见 §6，§3 的偏差表里"本阶段不做"的那一行已被阶段 2 取代。
**决策**：**采用系统已安装的 Edge/Chrome**（不自带浏览器二进制）；**浏览器是唯一运行时**，不保留 jsdom 退路。

---

## 1. 结论

阶段 1 换掉了 worker 的"肚子里"，外面一个字没动；阶段 2 换掉了进程模型，外面
同样一个字没动：

```
阶段 1  插件 host → Node 子进程（worker，一次性）→ headless Edge（随操作退出）→ 页面
阶段 2  插件 host → Node 子进程（engine，常驻）→ headless Edge（常驻）→ 每次操作新开一个页面
```

6 个操作、错误码体系、host 层接口、路径授权、工具返回的形状
**全部未变**——`src/shared/protocol.ts` 的请求形状、`src/shared/request.ts`、
`src/host/service/**`、7 个工具的定义一行未改。变的只有：

- **stdio 的分帧**：一次性是"一个请求进、一个信封出、退出"；常驻是 NDJSON，
  一行 `{id, request}` 进、一行 `{id, ok, result|error}` 出，按 id 配对。
- **`src/host/adapters/worker.ts`**：从"每次 spawn 一个进程"变成"持有引擎进程"。
- **`src/workers/sjs/**`**：入口变成请求循环（空闲退出、信号处理、stdin EOF），
  运行时把"启动浏览器"和"开一个页面"拆开。

---

## 2. 实际建成的东西

```
src/workers/sjs/
  operations.ts          只留协议语义：路径、错误码、原子写、结果形状
  files.ts               Node 侧文件原语（原子写/拷贝）
  fonts.ts               系统 TTF 发现（注册搬到页面侧）
  browser/
    runtime.ts           起 server + 浏览器 + 页面，对上层暴露按操作的方法
    cdp.ts               CDP 客户端（Node 自带 WebSocket）、浏览器启停、profile 卫生
    discovery.ts         找 Edge/Chrome：配置 → Edge → Chrome
    server.ts            回环 HTTP：/ws 与 /blob 两条授权级别不同的路由
    page.embed.js        页面那一半（Go 无文件系统，只做 SpreadJS）
```

### 2.1 两条传输、两级授权

| 通道 | 用途 | 授权 |
|---|---|---|
| `<script src>` / `fetch` 回环 HTTP | UMD bundle、ssjson、xlsx/csv/pdf 字节 | bundle 是包内静态文件；数据文件由 Node 按下面两条路由放行 |
| `/ws?p=<path>` | 沙箱用户代码的 `io.*` | **工作区受限**，每个请求都在 Node 侧重判一次；越权 → `SJS_FILE_PERMISSION_DENIED` |
| `/blob/<id>` | host 指定的那个文件（可能在工作区外） | **id 本身就是授权**：不透明 nonce，一次一个文件，路径由 Node 在注册时定死 |
| `Runtime.evaluate` | 只传控制信息（表达式、返回值） | 不传字节 |

字节**不走 CDP**：spike 实测 10 MB 负载下回环 HTTP 比 base64 过
`Runtime.evaluate` 快约 15 倍，而且大工作簿根本不进协议。

#### 为什么不是"带 token 的 /fs?p=<路径>"（曾经是，且不安全）

最初的实现是 `/fs?p=<绝对路径>&k=<进程级 token>`，token 只在 Node 构造调用的
时候内联，不进页面全局。**这个设计有一个已实测利用成功的洞：**

页面 fetch 过的每一个 URL 都对页面代码可见——
`performance.getEntriesByType('resource')` 会列出全部 URL **含查询串**，随时可读。
沙箱里的用户代码只要：

```js
const u = performance.getEntriesByType('resource').map(e => e.name).find(u => u.includes('k='))
const k = new URL(u).searchParams.get('k')
await (await fetch('/fs?p=C:/任意路径&k=' + k)).text()   // 读；POST 即写
```

就绕过了 `io.*` 的工作区围栏，读写进程够得到的**任意文件**。原文把这条记为
"残余风险（脚本劫持 `fetch` 抓 token，且必须在同一个一次性进程内得手）"——
**低估了**：既不需要劫持，也不需要抢时机。而且这是相对 jsdom 版的**回归**：
那时用户代码跑在 `node:vm` 里，作用域中没有 `fs`，任意路径本就够不到。

**教训**：页面能读到的秘密不是秘密。所以修法不是换一个更好的秘密，而是
**取消页面"指认路径"的能力**。host 授权的文件改由 Node 注册成一个不透明 id，
`/blob/<id>` 映射到唯一一个已授权的路径；没有任何路由接受来自页面的路径。
即使页面代码读到 `/blob/<id>`，它拿到的也只是 host 本就打算交给这个页面的那
一份。回归测试见 `test/sandbox-confinement.mjs`。

### 2.2 页面侧怎么加载 SpreadJS

页面用 `<script src>` 逐个加载 9 个 UMD 包，顺序是真实依赖链：
core → io → shapes → charts → slicers → print → pdf → pivot → datacharts。
每个文件在浏览器启动**之前**就验证存在（否则 `SJS_BROWSER_FAILED`），
所以打包变化不会退化成页面里一句静默的 `GC is undefined`。

**页面脚本必须作为外部脚本提供，不能用 `Runtime.evaluate` 注入**：求值包裹
会把脚本套进函数里，顶层 `var GC` 于是变成函数局部——不抛异常，只是之后
`typeof GC === 'undefined'`。`page.embed.js` 因此也是走 HTTP 的。

---

## 3. 与原计划的偏差（逐条对账）

| 原计划 | 实际 | 为什么 |
|---|---|---|
| 用 `playwright-core`（`channel: 'msedge'`）驱动 | **零依赖**：Node 24 自带 `WebSocket`/`fetch`，自己写 ~300 行 CDP 客户端 | 少一个 npm 依赖，少一层版本漂移；CDP 要用的只有 6 个方法 |
| 阶段 3 前**保持双实现**（`runtime: 'jsdom' \| 'browser'`），留一条已验证的退路 | **不做**。浏览器是唯一运行时，jsdom 路径整体删除 | 项目决定：双实现必然漂移，且"Node 里跑 SpreadJS"正是要摆脱的叙事 |
| ① 常驻浏览器 + 每次操作开新页面 | **阶段 2 已做**（见 §6）：常驻引擎进程 + 一个浏览器 + 每次操作一个新页面 | 阶段 1 的立场是"一次性进程是隔离故事的承重墙"，阶段 2 用**页面**接过这个角色：新页面 = 全新的 SpreadJS 原型，操作之间不可能串状态；进程级的隔离（宿主路径授权、超时、崩溃恢复）另有其层 |
| ② 文件 IO 必须搬出引擎，大表要专项优化 | IO 已搬完（Node 独占），**大表优化还没做** | 232 MB 级 ssjson 每次操作搬一遍的成本是下一阶段的事 |
| ③ CI 需确认 ubuntu 镜像是否自带 Chrome | 未动 GitHub Actions | 本阶段验收在本机 Windows 完成；CI 跑在宿主机的 Edge 上 |
| ④ `SJS_PDF_FONT_UNAVAILABLE` 变成死代码 | **错的**，守卫保留 | spike 06 已证：`savePDF` 是 SpreadJS 内部的纯 JS PDF 写出器，只嵌入注册过的字体，未注册的中文被静默丢弃（空壳 PDF、Times-Roman、无 FontFile）。真浏览器只是换了取字体的方式（fetch 而不是 fs），约束本身照旧 |
| ④ `SJS_PNG_FONT_UNAVAILABLE` 变成死代码 | **对的**，已删除该守卫 | 浏览器有真字体，PNG 不再需要强制字体 |
| ④ SKILL "截图字体被扁平化"不再成立 | 已改写 | 逐格字体/字重/颜色现在都是真的 |
| ④ 三个 jsdom realm 工作区全删 | 已删除（连同 `headless.ts`、`render-png.ts`） | 跨 realm ArrayBuffer / Date / CanvasRenderingContext2D 三类问题整类消失 |

> **原文档还有一条错误，不要传播**：它声称 `spread-excelio` 在 19.1.4 里不存在。
> 已核实：`npm pack @grapecity-software/spread-excelio@19.1.4` 带
> `dist/gc.spread.excelio.min.js`（还有 `.d.ts`）。当初没找到，只是因为按
> `spread-sheets*` 通配去列目录，名字里没有 `sheets`。

---

## 4. 实测数字

测量条件：同一台机器（Windows 11 / Edge），**无并发负载**；每次操作都
spawn 一个 worker 进程、跑一个请求、退出（阶段 1 的模型）。jsdom 一列取自 spike
`05-process.mjs`（同机、同负载条件、3 次取最小）。阶段 2 的对照见 §6。

⚠️ 口径说明：jsdom 一侧的 `status` / `execute` / `export pdf` 是**空工作簿**的
数字（spike 当时没跑这三项的基线），浏览器一侧是**真实 fixture**
（`q2-sales-2026.xlsx`，62 行 × 8 列）的数字；这几行只宜看量级，不宜看倍率。
`new` / `import` / `export xlsx` / `screenshot png` 两侧都是可比口径。

| 操作 | jsdom worker | 浏览器 worker | 变化 |
|---|---|---|---|
| `new` | 3.39 s | **3.41 s**（15 次中位；min 3.08 / max 3.66） | ≈ 持平 |
| `status` | 5.16 s（空表） | **3.4 s** 量级 | 快 |
| `import`（xlsx） | 3.66 s | **3.55–4.13 s** | 略慢 |
| `execute` | 8.62 s（空表，含 jsdom 启动） | **3.40–3.53 s** | 快 |
| `export xlsx` | 4.63 s | **3.44–3.64 s** | 快 21–26% |
| `export pdf` | 4.28 s（空表） | **5.88–6.39 s** | 慢（见下） |
| `screenshot png` | 10.85 s | **3.69–4.61 s** | **快 58%** |
| 7 个操作平均 | — | **4.04 s** | — |

冷启动分解（每次操作都要付一遍）：**页面就绪 ≈2.5 s**（浏览器启动 ≈1.0–1.1 s
＋导航与 9 个 UMD bundle ≈1.4 s，共约 14 MB），其余是操作本身（0.3–3 s，
看操作）。也就是说**一次操作里有六成是冷启动**——这正是下一阶段要消灭的。

**诚实结论**：一次性模型下，简单操作（import/execute 一类）比 jsdom 略慢或
持平，**大表截图快一倍多**（jsdom 要在 node-canvas 上栅格化整张表，浏览器
直接读自己的 canvas），PDF 导出最慢——因为要按老规矩把系统字体目录里
**全部 136 个 .ttf/.otf（248 MB）**取进页面注册一遍（jsdom 也是全量
`readFileSync` 注册，这一项是保平行为，不是新增开销）。

这个冷启动成本（≈2.5 s 页面就绪，占一次操作的一半以上）就是
下一阶段要消灭的东西。

---

## 5. 下一阶段（阶段 2 已完成，见 §6）

阶段 1 当时的判断：spike `05-process.mjs` 实测**常驻浏览器 + 每次开新页面 =
约 1.4 s/操作**，比一次性快 2–3 倍。阶段 2 实测为 **0.6–1.0 s/操作**（PDF 除外），
与预测量级一致；"页面不是进程"的取舍逐条落在 §6.4。

---

## 6. 阶段 2 · 常驻引擎（2026-09-20 落地）

### 6.1 形状

```
DSH 进程 ──spawn 一次──▶ engine 进程（常驻） ──spawn 一次──▶ 一个 headless Edge
                              └── 每个请求：新开一个页面 → 干活 → 关掉页面
```

- **engine 常驻**：第一次操作时启动，之后服务整个会话。浏览器只起一次。
- **每次操作一个新页面**：页面是隔离边界。现有页面脚本会在
  `Worksheet.prototype` 上装守卫（自动扩容、表名校验），重用页面就意味着往
  已打过补丁的原型上再打一遍——这是真实风险，不是理论风险。
- **请求串行**：一次一个，按到达顺序。操作本身已经快了 4 倍左右，排队不花什么
  钱，却消掉了一整类并发问题。
- **stdout 纪律**：一次性进程只需要在退出前守住一次；常驻进程要守整个生命周期。
  页面的 `console`、启动诊断、浏览器噪音全部走 stderr，浏览器自己的 stdout 干脆
  没接管（`stdio: 'ignore'`）。

### 6.2 分帧：NDJSON（一行一个 JSON 消息）

选它的理由：不需要任何依赖；管道的一次 `data` 事件与消息边界无关，按行切天然
正确；终端里肉眼可读（调试时能直接 tail）；载荷里没有二进制——字节走环回 HTTP，
不过这条管道，所以长度前缀换不来任何东西。

请求行 `{id, request}`，应答行 `{id, ok, result|error}`。**无法归属到请求的行**
（比如根本不是 JSON）用 `id: null` 回一个 `SJS_BAD_REQUEST` 而不是静默丢弃：丢弃
会让发送方永远等下去。EOF 时最后一行**没有换行**也算（"一个请求然后 EOF"这种
一次性调用方式仍然可用）。

### 6.3 实测数字（同一台机器、同一 fixture、同一测量脚本）

`node test/perf-operations.mjs --mode=engine|oneshot --rounds=3`；baseline 一列是
上一个提交（`f443b8a`，一次性运行时的代码）在同一个 worktree 里跑出来的，
fixture 是 62 行 × 8 列（中文、数字、公式列、日期）。

| 操作 | 阶段 1（一次性，`f443b8a`） | 阶段 2（常驻引擎） | 倍率 |
|---|---|---|---|
| `new` | 3 333 ms | **604 ms** | 5.5× |
| `execute` | 3 637 ms | **825 ms** | 4.4× |
| `export xlsx` | 3 658 ms | **874 ms** | 4.2× |
| `import xlsx` | 3 850 ms | **1 030 ms** | 3.7× |
| `export xlsx`（第 2 次） | 3 775 ms | **886 ms** | 4.3× |
| `screenshot png` | 3 819 ms | **934 ms** | 4.1× |
| `export pdf` | 6 003 ms | **2 810 ms** | 2.1× |
| `screenshot pdf` | 6 195 ms | **2 934 ms** | 2.1× |
| `status` | 3 508 ms | **799 ms** | 4.4× |
| 平均 | 4 198 ms | **1 299 ms** | **3.2×** |

每个操作剩下的那 ~0.8 s 是什么：**页面引导 ~0.3 s**（浏览器 HTTP 缓存里的 9 个
UMD 包，`[sjs] page ready in 300ms (document 40ms, runtime 7ms, boot 275ms)`）加上
操作本身。第一个操作贵得多（浏览器启动 ~0.7 s + 页面 ~1.5 s），第二次仍偏高
（~2.4 s，V8 code cache 要写到第二遍才生效），**第三次起进入稳定态**。这是一次
性运行时没有的现象，必须在报告里说清楚：单次调用的场景下这次改造几乎不省钱。

**PDF 为什么只快 2.1 倍（诚实回答）**：字体注册是**按页面**的
（`GC.Spread.Sheets.PDF.PDFFontsManager` 活在页面里），每个 PDF 操作都要把 ~345
个字体重新取一遍、注册一遍。实测（stderr 上的 `[sjs:page] registered N PDF fonts
in Xms`）：**每次 1.6 s**，三次导出完全一样（1667 / 1613 / 1610 ms），说明它既不
随操作次数摊销，也不被 HTTP 缓存省掉（省掉的只是传输，注册的计算省不掉）。它占
2.8 s 里的 57%。要再快就得让多个页面共享字体管理器，也就是**不**每次开新页面——
这笔交易本设计不做。

### 6.4 生命周期与取舍

| 事件 | 行为 |
|---|---|
| 空闲超时（`SJS_ENGINE_IDLE_MS`，默认 60 s） | 关浏览器（`Browser.close`）→ 退出；下次请求重新起 |
| DSH 退出 | provider 的 `dispose()` 关掉引擎 stdin；引擎收到 EOF → 关浏览器 → 退出（6 s 后强杀兜底） |
| 请求超时 / 被 abort | 杀引擎（连带浏览器），报 `SJS_WORKER_TIMEOUT` / 调用方的中断原因；下次请求起新引擎 |
| 引擎中途死亡 | 在飞的调用报 `SJS_ENGINE_DIED`；下次请求起新引擎 |
| 引擎崩溃 | 浏览器是它的直接子进程，随之结束（实测：被杀 / 被 detach / 崩溃三种模式都不留孤儿）。因此**不做 PID 看门狗**——实测不需要 |
| 关停时有请求在飞 | 等在飞请求跑完再关（`consume()` 的 finally），6 s 后强杀 |
| 页面未关闭 | 每个操作结束都会关页面；关闭失败会重试一次并记日志，下一次操作开始前再兜底清扫一次 |

**没有采用的**：看门狗（实测多余）、重用页面（原型补丁风险）、并行请求
（引擎只有一个页面位）。

### 6.5 这阶段新引入的失败面

1. **引擎中途死亡**（一次性进程不可能这样）：映射到 `SJS_ENGINE_DIED`，下次调用
   自动重启。`test/tool-smoke.mjs` 用一个"卡在页面里 60 s 的脚本 + 杀引擎"把它钉住。
2. **blob 注册表无限增长**：注册表原本随进程消失；常驻进程里必须显式清理，改成
   **每个操作开始时清空**——nonce 只对铸造它的那次操作有效。一次 PDF 导出就要铸
   造 ~345 个 nonce，不清理就是稳定泄漏。`test/sandbox-confinement.mjs` 新增一条
   断言：上一次操作的 blob URL 在下一次操作里必须 403。
3. **页面泄漏 = 窗口泄漏**：页面只要还开着就是浏览器里的一个顶层窗口（headless
   下不可见，但真实存在于系统的窗口列表里，并且占着一个渲染进程）。所以"一个操作
   一个页面、结束即关"是硬不变量，且**从进程外部**断言：`test/worker-smoke.mjs`
   检查引擎空闲时没有一张标题为 `sjs-runtime` 的窗口。
4. **浏览器不再随操作消失**：一个卡住的引擎会一直攥着 150–250 MB 和 15 个进程。
   由空闲超时 + 有界关停（关闭超过 15 s 就强退）兜住；`scripts/audit-browsers.mjs`
   在整轮 CI 上采样存活浏览器数（见 §6.6）。

### 6.6 回归守卫

- `test/worker-smoke.mjs`：引擎空闲时**没有**标题为 `sjs-runtime` 的窗口；引擎进程
  结束后**没有**我们的浏览器存活（按 `--user-data-dir` 前缀识别；Windows 上枚举）。
- `scripts/audit-browsers.mjs -- pnpm run ci`：整轮 CI 期间每 2 s 采样一次存活浏览器
  数，跑完后留 10 s 宽限，**结束后还有存活 → 失败**；并发数超过
  `--max-concurrent`（默认 4）→ 失败。这是"窗口越积越多"这个现象的直接守卫。
