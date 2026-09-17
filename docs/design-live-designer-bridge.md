# 设计方案 · 与 SpreadJS Editor 的活工作簿联动

**状态**：草案，待与 `@grapecity-software/dsh-spreadjs-editor` 作者对齐
**参与方**：`dsh-spreadjs-excel`（本仓库）、`dsh-spreadjs-editor`

---

## 1. 目标与不变量

### 目标

用户在 DSH 里用自然语言描述需求（"把金额列改成红色"），**改动落在用户在编辑器里正看着的那个工作簿上，界面立刻可见**。

### 不变量（不可违背）

1. **对象不被搬运。** host 与浏览器之间没有共享堆，对象过不去。任何"把 workbook 传过去"的设计都是错的。
2. **执行发生在浏览器内。** 只有调用点在浏览器里，改的才是设计器正在渲染的那个对象。
3. **不使用文件作为媒介、不使用 HTTP 传递对象。** 文件是另一份数据；HTTP 只能传副本。两者都会导致"改的是另一个实例"。
4. **本插件在无浏览器时（headless profile）能力不退化。** 现有 7 个工具与其语义、CI 全部不受影响。

### 为什么成立

两个插件的 client 半**由同一个 client-modules 系统加载进同一个页面、同一个 JS realm、同一个堆**（证据：编辑器的 client 半从模块表 `require('react')` 并把界面渲染进同一 document 的侧边栏，不是 iframe 也不是 Worker）。因此：

```js
ctx.get('spreadjsDesigner').getWorkbook() === designer.getWorkbook()   // true，同一个对象
```

`getWorkbook()` 返回**引用**而非副本，所以我们的修改就是设计器正在渲染的那个对象。

---

## 2. 总体架构

```
┌─ 浏览器标签页（同一 realm / 同一堆）────────────────────────┐
│                                                             │
│  编辑器 client 半                                            │
│    └─ designer（SpreadJS Designer 实例）                     │
│         └─ getWorkbook() ──┐                                │
│                            │ 同一个对象引用                  │
│  本插件 client 半（新增）   │                                │
│    └─ ctx.inject(['spreadjsDesigner']) → 拿到该引用          │
│         ├─ 订阅/领取指令                                     │
│         ├─ suspendPaint → 执行 → resumePaint                │
│         └─ 回报结果                                          │
└──────────┬───────────────────────────────┬──────────────────┘
           │ 指令下发                       │ 结果回传
           │                               │
┌──────────┴───────────────────────────────┴──────────────────┐
│  Node host 进程                                              │
│  本插件 host 半（现有 7 个工具 + 新增桥）                     │
│    └─ 工具 → 入队指令 → 等待结果 → 返回给 agent               │
└─────────────────────────────────────────────────────────────┘
```

通道只运**指令与结果（JSON）**，**永不运对象**。

---

## 3. 他们那边要改什么（`dsh-spreadjs-editor`）

### 3.1 唯一必须做的事：把活工作簿发布成客户端服务

现状（`src/client/SpreadsheetHost.tsx`）：`designerRef` 是组件私有，`useImperativeHandle` 只暴露
`save / exportAs / newWorkbook`（第 409 行），**没有访问器**。而 `designer.getWorkbook()` 在
组件内已被调用 5 次（第 299/335/366/388/402 行）——**要发布的正是它**。

建议接口（够用即最小）：

```ts
/** 发布为客户端服务：ctx.provide('spreadjsDesigner', impl) */
export interface SpreadjsDesignerService {
  /** 当前挂载的设计器所持有的活工作簿；无设计器时为 undefined。 */
  getWorkbook(): SpreadJSWorkbook | undefined
  /** 当前打开文件的绝对路径；新建未保存时为 undefined。 */
  getActivePath(): string | undefined
  /** 让设计器把活工作簿写回其文件（等价于面板上的保存）。 */
  save(): Promise<void>
  /** 外部改动后的记账通知：编辑器据此更新状态栏/脏标记。 */
  notifyExternalEdit(origin: string): void
  /** 设计器自身的生命周期变化（打开/关闭/保存），供桥做可用性判断。 */
  onDidChange(listener: (state: DesignerState) => void): () => void
}
```

### 3.2 改动点清单

| 位置 | 改动 |
|---|---|
| `src/client/SpreadsheetHost.tsx` | 通过 `useImperativeHandle` 已有能力 + 新增 `getWorkbook/getActivePath/notifyExternalEdit`；或改为向一个模块级注册表注册（见下） |
| `src/client/SpreadsheetViewer.tsx` | 它**已经**从 props 收到 `ctx`（`SidebarFileViewerProps.ctx`），但目前**没有往下传**——需要把 `ctx`（或一个注册表）传给 `SpreadsheetHost` |
| `src/client/index.ts` | 在 `apply(ctx)` 里 `ctx.provide('spreadjsDesigner', …)`，并把 service 与当前 viewer 实例绑定；viewer 卸载时撤销 |
| 文档 | README 增加"暴露给其它客户端插件"的说明 |

**工作量估计：十几到几十行**，无新依赖、无构建改动。

### 3.3 他们**不需要**做的事

- ❌ 不需要执行任何外部传入的代码（执行者是本插件，见 §4）
- ❌ 不需要理解样式/公式/合并等业务语义
- ❌ 不需要新增 HTTP 端点

### 3.4 验收（他们侧独立可测）

1. 打开一个 `.xlsx` 后，控制台 `ctx.get('spreadjsDesigner').getWorkbook()` 返回对象；
2. `ctx.get('spreadjsDesigner').getWorkbook() === designer.getWorkbook()` 为 `true`（同一引用）；
3. 关闭文件/卸载面板后，`getWorkbook()` 返回 `undefined`；
4. 不打开任何文件时调用不抛异常。

---

## 4. 我们这边要改什么（`dsh-spreadjs-excel`）

### 4.1 新增 client 半

现状：本插件是 **host-only**（`dsh.bundle.patch`，**无 `dsh.client`**）。需要新增浏览器半。

| 项 | 内容 |
|---|---|
| 声明 | `package.json` 增加 `dsh.client`（`platform: "web"`，`inject: []`） |
| 产物 | `lib/client.js`（CJS closure factory，`window.__ModuleLoader__.load({id, factory})` 包装） |
| 外部化 | `react` / `react-dom` / `@deepseek-ai/cordis` 保持外部，其余内联（与编辑器同款约定） |
| 构建 | 在现有 `scripts/build.mjs` 里增加第三个 entry（esbuild，`platform: 'browser'`），沿用现有 CI |

**client 半无 UI**。它只做四件事：拿到 workbook 引用 → 领取指令 → 执行 → 回报。产品定位不变（给 agent 用的无头表格引擎），client 半是**可选适配器**。

### 4.2 client 半的行为

```ts
ctx.inject(['spreadjsDesigner'], (child) => {
  child.effect(() => {
    const designer = child.get('spreadjsDesigner')
    const loop = startCommandLoop({
      claim:   () => remote.spreadjsLive.claim(),          // 长轮询，见 §5
      report:  (id, r) => remote.spreadjsLive.complete(id, r),
      execute: (code) => {
        const wb = designer.getWorkbook()
        if (wb === undefined) throw new NotAttached()
        wb.suspendPaint()
        try { return runSnippet(wb, code) }                 // 与 sjs_execute 同语义
        finally { wb.resumePaint() }                        // 必须配对，否则界面停在旧画面
      },
    })
    return () => loop.stop()
  })
})
```

**执行语义与本插件现有 `sjs_execute` 保持一致**：同一个沙箱形状（注入 `spread`/`GC`/`sheet()`/`snapshot()`，不注入 `require`/`process`/`fs`）、同一套 `SJS_*` 错误码、同样的挂起规矩。差别只在**执行载体是浏览器内已有的活工作簿**，而不是 Node 里新起的一次性 worker。

### 4.3 host 半的新增

| 项 | 内容 |
|---|---|
| 桥服务 | 一个指令队列：工具入队 → 挂起等待 → 客户端回报后 resolve；含超时与取消（沿用 `signal: AbortSignal`） |
| 可用性探测 | 记录"当前是否有客户端在领取指令"及其 `getActivePath()`，供工具判断 |
| 新工具 | `sjs_live_status`（有无活设计器、打开的是哪个文件） |
| 新工具 | `sjs_live_execute`（对活工作簿执行代码；离线时返回明确的不可用错误码，如 `SJS_LIVE_NOT_ATTACHED`） |

> 备选：给现有 `sjs_execute` 加 `target: 'file' | 'live'` 参数。**1.0 不建议**——会改动既有工具契约；先独立成工具。

### 4.4 SKILL 更新

新增一节说明两条路径的选择：

- 用户**正在设计器里看着某文件** → 优先 `sjs_live_execute`（改动立刻可见，且不覆盖未保存编辑）
- 无设计器 / 批量/离线处理 → 用现有文件工具链
- **同一文件两者不可混用**（见 §6）

### 4.5 无浏览器时的行为

`dsh.client` 在 headless profile 中根本不加载；host 侧探测不到客户端 → `sjs_live_*` 返回
`SJS_LIVE_NOT_ATTACHED`，其余 7 个工具与全部 CI **一行不改**。

---

## 5. 通道选型（host → 浏览器）

**约束**：agent 在 host 进程，所以"把指令送到浏览器"这一步无法避免；**但对象永不参与**。

| 方案 | 机制 | 评价 |
|---|---|---|
| **A · 第一方 RPC 长轮询（推荐）** | 客户端循环调用 host 暴露的 `@Remote` 方法 `claim()`；host 侧**把调用挂住**直到有指令（长轮询，非忙轮询）或超时；执行完调 `complete(id, result)` | 全程第一方（`@Remote` 即 DSH 的 client→host 通道，传输是既有 WebSocket，支持 `AbortSignal` 取消） |
| B · host 推送事件 | 客户端 `$on` 接收 forwarded Host events | 更优雅，但需确认按需推送的确切 API（文档只见"forwarded events reach `$on`"与 agent 作用域 waterfall） |
| C · `webServer` 路由承载指令 | 客户端 fetch 一个路由领取指令 | 生态里已有先例（编辑器自己的 `/spreadjs/api/config`）。**但它是 HTTP**，若你们对"HTTP"本身有顾虑则不选 |

**注意区分**：C 与你们否掉的"用 HTTP 拿对象"不同——**对象始终留在浏览器**，路由只运指令。
不过 A 完全没有这个问题，代价是 host 半要接入 DSH 的 `@Remote` 生成管线（typert codegen），
这是一项**新增的构建复杂度**，需要先评估。

> **待确认**：`@Remote` 的严格生成贡献（"only strict generated contributions can mount on the
> Client face"）具体要求什么构建步骤；若成本过高，退到 B 或 C。

---

## 6. 一致性：本方案最难的部分

活工作簿被改动后，**磁盘上的文件是旧的**。而我们的 `sjs_export` / `sjs_screenshot` / `sjs_status`
都读**文件** → 会看到过期内容。这是本方案的核心风险。

**建议（v1 采用）：活编辑即时落盘。**

```
sjs_live_execute → 浏览器执行 → 立即调 designer.save() 写回文件 → 返回结果
```

- 好处：**文件始终是唯一事实源**，现有 7 个工具语义完全不变，不存在分歧
- 代价：每次操作多一次保存（序列化 + 上传，量级几百毫秒）
- 后续若性能成为问题，再改为"批量落盘"或"活状态优先"

**若不做即时落盘**，则必须引入"某个文件正在被活编辑"的状态机，并让所有读文件的工具据此报错或改道——复杂度高得多，不建议 v1 做。

### 其余待决策（建议值）

| 问题 | 建议 |
|---|---|
| 多个标签页各开一个设计器 | 当前浏览器标签页 = 一个 realm = 一个设计器；服务以"本标签页当前挂载的设计器"为准。两标签页同时开着同一文件时，host 只能服务其中一个——`claim()` 带 `path` 做归属判定，不匹配则拒绝并回报冲突 |
| 撤销栈 | agent 的一次 `sjs_live_execute` 包成**一个** undo 单元（`spread.undoManager()`），便于用户一次撤销 |
| 用户正在编辑时 agent 插入改动 | 落在同一活文档上，**天然不覆盖**用户未保存的编辑（这正是相对"文件媒介"的核心优势） |
| 编辑器状态栏/脏标记 | 通过 `notifyExternalEdit(origin)` 告知，避免界面显示"已保存"而实际有未落盘改动 |

---

## 7. 失败与降级

| 情形 | 行为 |
|---|---|
| 无浏览器（headless profile） | client 半不加载；`sjs_live_*` 返回 `SJS_LIVE_NOT_ATTACHED` |
| 设计器未打开任何文件 | `getWorkbook()` 返回 `undefined` → 返回 `SJS_LIVE_NO_WORKBOOK` |
| 编辑器未安装 / 服务未发布 | 可选注入拿不到服务 → client 半静默待命 |
| 指令执行抛错 | 与 `sjs_execute` 同款 `SJS_SCRIPT_ERROR` 等错误码回传，含原始消息 |
| 浏览器中途关闭 / 断连 | host 侧等待超时（建议 30 s，可配）→ `SJS_LIVE_TIMEOUT`，不阻塞会话 |
| 保存失败 | 改动已在活文档中生效，明确回报"已应用但未落盘"，不谎报成功 |

---

## 8. 建议分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **0 · 验证** | 编辑器发布服务后，控制台验证同一引用（§3.4）；不写任何我们的代码 | 他们：~10 行 |
| **1 · 打通** | 我们加 client 半 + host 桥（选 A/B/C 之一）+ `sjs_live_status`、`sjs_live_execute`，**含即时落盘** | 双方 |
| **2 · 体验** | SKILL 引导、undo 单元、冲突处理、状态栏联动 | 双方 |
| **3 · 收敛** | 评估是否把 live 并入 `sjs_execute` 的 `target` 参数 | 我们 |

---

## 9. 开放问题（需双方确认）

1. **通道选型**：A（`@Remote` 长轮询，需 typert codegen）/ B（forwarded events）/ C（`webServer` 路由）。**A 最干净但要评估生成管线成本。**
2. **即时落盘是否接受**（§6 建议值）。若不可接受，需要重新设计一致性方案。
3. **编辑器是否可能同时挂载多个设计器**（多面板/分屏）？若有，服务需按 viewer id 寻址。
4. **沙箱强度**：client 半的代码在用户浏览器里执行，`sjs_execute` 在 Node 子进程里执行——两者的隔离级别不同。live 路径是否需要更严格的限制（例如禁止 `io.*` 文件访问）？

---

## 附：本方案不做什么

- ❌ 不搬对象
- ❌ 不用文件作媒介
- ❌ 不新增 HTTP 端点（若选 A/B）
- ❌ 不让编辑器执行我们的代码
- ❌ 不改动现有 7 个工具与其语义
- ❌ 不影响 headless profile 与 CI
