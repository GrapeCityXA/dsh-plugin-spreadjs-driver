# 设计方案 · 引擎运行时从 jsdom 迁到真实浏览器

**状态**：**已落地（2026-09-17）**。本文已从"计划书"改写为"实际建成的东西 + 实测数字"，并逐条列出与原计划的偏差。
**决策**：**采用系统已安装的 Edge/Chrome**（不自带浏览器二进制）；**浏览器是唯一运行时**，不保留 jsdom 退路。

---

## 1. 结论

worker 的"肚子里"换了，外面一个字没动：

```
插件 host 进程 → 起一个 Node 子进程（worker，一次性）
                   └─ 起一个 headless Edge/Chrome（用户不可见，随操作结束退出）
                        └─ 页面里加载 SpreadJS 的 UMD 构建
                             └─ 真 DOM、真 canvas、真字体
```

进程模型、stdin/stdout 信封、6 个操作、错误码体系、host 层接口、路径授权
**全部未变**——`src/shared/protocol.ts`、`src/shared/request.ts`、`src/host/**`、
7 个工具与 provider 的接口一行未改。改的只有 `src/workers/sjs/**`。

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
| ① 常驻浏览器 + 每次操作开新页面 | **本阶段不做**，仍是一次性进程（见 §5） | 一次性进程是 `sjs_execute` 隔离故事的承重墙，本阶段只换"肚子里" |
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
spawn 一个 worker 进程、跑一个请求、退出。jsdom 一列取自 spike `05-process.mjs`
（同机、同负载条件、3 次取最小）。

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

## 5. 下一阶段（未做，已量好）

spike `05-process.mjs` 实测：**常驻浏览器 + 每次开新页面 = 约 1.4 s/操作**
（import 641 ms + 编辑重算 403 ms + 导出 356 ms），即比现在快 2–3 倍。代价与
取舍（页面不是进程：一个坏操作会不会连累其他操作、看门狗与浏览器重启策略、
`SJS_WORKER_TIMEOUT` 的语义要改成"杀页面"）在本文早期版本的风险表里已经列过，
那些判断仍然有效。

在那之前，本阶段的选择是：**先把"里面是什么"换对，保持"外面怎么用"一字不动**。
