# 设计方案 · 与 SpreadJS Editor 的活工作簿联动

**状态**：草案 v2（依赖方向已反转为 **editor → 本插件**）
**参与方**：`dsh-spreadjs-excel`（本仓库，被依赖方）、`dsh-spreadjs-editor`（依赖方）

> **v2 变更**：v1 让编辑器发布一个公开服务、我们去找它。v2 反过来——**编辑器调用我们发布的
> `attach()` 把工作簿交给我们**。原因是安全：`ctx.provide` 是全局服务，同上下文里任何客户端
> 插件都能拿到并修改用户的活文档；反转后编辑器**主动选择交给谁**（只给我们），且我们的客户端半
> **不对外暴露任何操作入口**。

---

## 1. 目标与不变量

### 目标

用户在 DSH 里用自然语言描述需求（"把金额列改成红色"），**改动落在用户在编辑器里正看着的那个工作簿上，界面立刻可见**。

### 不变量

1. **对象不被搬运。** host 与浏览器之间没有共享堆，对象过不去。任何"把 workbook 传过去"的设计都是错的。
2. **执行发生在浏览器内，且执行者是我们。** 只有调用点在浏览器里，改的才是设计器正在渲染的那个对象；只有执行者是我们，`SJS_*` 错误码、挂起规矩、SKILL 语义才不散架。
3. **不使用文件作为媒介、不使用 HTTP 传递对象。** 文件是另一份数据；HTTP 只能传副本。
4. **依赖方向是 editor → 本插件**，且为**可选**依赖：编辑器缺了我们仍能独立工作。
5. **本插件在无浏览器时（headless profile）能力不退化。** 现有 7 个工具与其语义、CI 全部不受影响。

### 为什么成立

两个插件的 client 半**由同一个 client-modules 系统加载进同一个页面、同一个 JS realm、同一个堆**。因此编辑器交过来的 `getWorkbook()` 返回值是**引用**而非副本，我们的修改就是设计器正在渲染的那个对象。

---

## 2. 总体架构

```
┌─ 浏览器标签页（同一 realm / 同一堆）────────────────────────┐
│                                                             │
│  编辑器 client 半（依赖方）                                  │
│    └─ designer（SpreadJS Designer）                         │
│         └─ getWorkbook() ──┐                                │
│                            │ 同一个对象引用                  │
│  本插件 client 半（被依赖方）│                               │
│    ├─ ctx.provide('spreadjsHostBridge', { attach })  ← 公开面 │
│    │     └─ 编辑器据此把工作簿交过来                          │
│    └─ 指令循环（私有，不对外暴露）                            │
│         suspendPaint → 执行 → resumePaint → 回报结果         │
└──────────┬───────────────────────────────┬──────────────────┘
           │ 指令下发                       │ 结果回传
┌──────────┴───────────────────────────────┴──────────────────┐
│  Node host 进程                                              │
│  本插件 host 半（现有 7 个工具 + 新增桥与新工具）              │
└─────────────────────────────────────────────────────────────┘
```

**公开面只有 `attach()` 一个方法**；指令通道是 host ↔ 我们自己 client 半的私有通道，第三方调不动。

---

## 3. 我们这边要改什么（`dsh-spreadjs-excel`）

### 3.1 新增 client 半

现状：本插件 **host-only**（`dsh.bundle.patch`，**无 `dsh.client`**）。

| 项 | 内容 |
|---|---|
| 声明 | `package.json` 增加 `dsh.client`（`platform: "web"`，`inject: []`） |
| 产物 | `lib/client.js`（CJS closure factory，`window.__ModuleLoader__.load({id, factory})` 包装） |
| 外部化 | `react` / `react-dom` / `@deepseek-ai/cordis` 保持外部，其余内联 |
| 构建 | 现有 `scripts/build.mjs` 增加第三个 entry（esbuild，`platform: 'browser'`） |

**client 半无 UI**。它只做：接收 attach → 领取指令 → 执行 → 回报。

### 3.2 唯一公开接口：`attach()`

```ts
/** 本插件发布的客户端服务名：'spreadjsHostBridge' */
export interface SpreadjsHostBridge {
  /**
   * 宿主插件把它的活工作簿交给我们托管。
   * @returns 注销句柄；宿主卸载时必须调用。
   */
  attach(provider: SpreadjsWorkbookProvider): () => void
}

export interface SpreadjsWorkbookProvider {
  /** 稳定标识；多宿主时用于寻址（建议用文件绝对路径）。 */
  readonly id: string
  /** 当前活工作簿；无工作簿时返回 undefined。 */
  getWorkbook(): unknown | undefined
  /** 当前打开的文件路径（可选）。 */
  getActivePath?(): string | undefined
  /** 让宿主把活工作簿写回其文件（可选；用于即时落盘）。 */
  save?(): Promise<void>
  /** 宿主状态变化通知，返回注销句柄（可选）。 */
  subscribe?(listener: () => void): () => void
}
```

**设计约束**

- **只放客户端，不放 host 侧**：Node 侧插件**不应**能借我们的引擎使用 SpreadJS。host 侧的 `spreadjsHostBridge` 服务**不提供**。
- **不暴露"操作"方法**：除 `attach` 外没有第二个公开方法。第三方即便拿到服务，也只能交出**它自己本就拥有的**工作簿，够不到编辑器的。
- 第三方插件 attach **自己的** workbook 是允许的，且**不构成泄漏**——它只能影响它本已拥有的对象。

### 3.3 client 半的执行语义

```ts
ctx.inject([], (child) => {
  child.effect(() => {
    const attached = new Map<string, SpreadjsWorkbookProvider>()
    child.provide('spreadjsHostBridge', {
      attach(provider) { attached.set(provider.id, provider); return () => attached.delete(provider.id) },
    })
    const loop = startCommandLoop({
      claim:  (id) => remote.spreadjsLive.claim(id),        // 长轮询（见 §5）
      report: (id, r) => remote.spreadjsLive.complete(id, r),
      execute: (id, code) => {
        const wb = attached.get(id)?.getWorkbook()
        if (wb === undefined) throw new LiveNotAttached()
        wb.suspendPaint()
        try { return runSnippet(wb, code) }                  // 与 sjs_execute 同语义
        finally { wb.resumePaint() }                         // 必须配对
      },
    })
    return () => loop.stop()
  })
})
```

执行语义与现有 `sjs_execute` **保持一致**：同一沙箱形状（注入 `spread`/`GC`/`sheet()`/`snapshot()`，不注入 `require`/`process`/`fs`）、同一套 `SJS_*` 错误码、同样的挂起规矩。差别只在载体是浏览器里**已存在的活工作簿**，而非 Node 里新起的一次性 worker。

### 3.4 host 半的新增

| 项 | 内容 |
|---|---|
| 桥服务 | 指令队列：工具入队 → 挂起等待 → 客户端回报后 resolve；含超时与取消（`signal: AbortSignal`） |
| 可用性探测 | 记录当前已 attach 的 provider id 及其 `getActivePath()` |
| 新工具 | `sjs_live_status`（有无活工作簿、打开的是哪个文件） |
| 新工具 | `sjs_live_execute`（对活工作簿执行代码；无宿主时返回 `SJS_LIVE_NOT_ATTACHED`） |

> 备选：给现有 `sjs_execute` 加 `target: 'file' | 'live'`。**1.0 不建议**——会改动既有工具契约。

### 3.5 SKILL 更新

新增一节说明两条路径的选择：用户正看着某文件 → 优先 `sjs_live_execute`；无宿主 / 批量 / 离线 → 现有文件工具链。**同一文件两者不可混用**（见 §7）。

### 3.6 无浏览器时的行为

`dsh.client` 在 headless profile 中不加载；host 侧探测不到客户端 → `sjs_live_*` 返回 `SJS_LIVE_NOT_ATTACHED`，其余 7 个工具与全部 CI **一行不改**。

---

## 4. 编辑器那边要改什么（`dsh-spreadjs-editor`）

### 4.1 唯一必须做的事：调用我们的 `attach()`

```ts
// src/client/index.ts
export function apply(ctx: ClientContext): void {
  // …原有 viewer 注册…
  ctx.inject(['spreadjsHostBridge'], (c) => {
    const bridge = c.get('spreadjsHostBridge') as SpreadjsHostBridge
    const off = bridge.attach({
      id: 'spreadjs-designer',
      getWorkbook: () => designerRef.current?.getWorkbook(),
      getActivePath: () => pathRef.current,
      save: () => hostHandle.current?.save(),
    })
    return () => off()
  })
}
```

`inject` 为**可选**：我们不在场时 `ctx.inject` 不触发，编辑器行为与今天完全一致。

### 4.2 改动点清单

| 位置 | 改动 |
|---|---|
| `src/client/SpreadsheetHost.tsx` | 暴露 `getWorkbook()`（内部已调用 5 次，加个访问器即可）；如需即时落盘则复用已有的 `save()` |
| `src/client/SpreadsheetViewer.tsx` | 它**已经**从 props 收到 `ctx`，但没往下传——需把 `ctx`（或一个注册表）传给 `SpreadsheetHost` |
| `src/client/index.ts` | `ctx.inject(['spreadjsHostBridge'], …)` → `attach(…)` |
| `package.json` | 增加 **optional peerDependency**：`@grapecity-software/dsh-spreadjs-excel`（依赖方向可见，但不影响单独安装） |
| `README` | 说明"可选联动：装上 dsh-spreadjs-excel 后可用自然语言驱动当前工作簿" |

**工作量：十几到几十行**，无新依赖、无构建改动。

### 4.3 他们**不需要**做的事

❌ 不执行任何外部传入的代码 ❌ 不理解业务语义 ❌ 不加 HTTP 端点 ❌ 不做安全判定

### 4.4 验收（他们侧独立可测）

1. 只装编辑器（不装我们）：行为与今天完全一致，无报错；
2. 两个都装：打开 `.xlsx` 后，我们侧 `sjs_live_status` 报告已 attach 且路径正确；
3. 关闭文件/卸载面板后，`sjs_live_status` 报告未 attach；
4. 编辑器卸载时 `attach` 返回的注销句柄被调用，我们侧不再持有引用（**避免内存泄漏**）。

---

## 5. 通道选型（host → 浏览器）—— 已定并已实现

**约束**：agent 在 host 进程，"把指令送到浏览器"无法避免；**但对象永不参与**。

**结论：`connection.rpc` 上的 `/spreadjs-live` 通道，浏览器侧轮询领活。**
零 codegen、零新依赖、零新增服务端路由。

### 三个候选的核实结论

| 方案 | 结论 | 依据 |
|---|---|---|
| B · forwarded events | ❌ **不可能** | 允许清单是硬编码常量（`dsh-api-remotes/lib/index.js:17` 的 `API_REMOTE_FORWARDED_EVENTS`），且 `registerRemoteEvents` 一次性注册、重复即抛错（`dsh-api-gateway/lib/index.js:485`）。第三方插件无法添加自己的事件。审批（`dsh-user-approval` → `dsh-client-ui-approval` 的 `$on("approval/request")`）走的正是这条路，但那是第一方特权。 |
| A · `@Remote` | ❌ **方向不对，成本也过高** | 它是**客户端→主机单向**（`dsh-typert-protocol/README.md`）。而且生成器 `dsh-typert-generator` 根本没随包发布——24 个用它的包全是第一方，**无第三方先例**；descriptor 还要求 strict codec（`dsh-api-gateway/lib/client.js:1807`）。 |
| C · `connection.rpc` | ✅ **采用** | 主机 `handle(channel, handler)`、浏览器 `call(channel, endpoint, payload, signal)`。`register()` 会先跑 `requestRejection`（Host/Origin 围栏 + 签名 HttpOnly cookie），**鉴权零成本**。 |

### 为什么是短轮询，不是挂起长连接

`connection.rpc` 能把请求挂住到有活为止，延迟和流量都更好。**没采用**，因为"一个被长期挂住的
`/api` 响应能否一直存活"在本 codebase 里**没有任何证据**，而它买到的只是几百毫秒——不值得让
整条链的必经之路建立在一个未验证的假设上。轮询的代价实际很小：回环上一次 300ms 的请求，且
**没有工作簿打开时完全不发**（绝大多数时间）。真要升级，`src/client/live.ts` 的循环是唯一要改的地方。

### 通道命名

`/spreadjs-live`，**不是** `/spreadjs`。编辑器插件已在 `/spreadjs/api/health` 和
`/spreadjs/api/config` 注册了普通 webServer 路由（license 握手），共用前缀会让两个插件都得去
推理 web server 的匹配顺序。**两个插件，两个前缀。**

### 失败模式（刻意做成快速失败）

host 永远不向页面推送——浏览器不先开口就不可达。所以：

- 没有标签页在轮询 → `SJS_LIVE_NO_CLIENT`，**立即**返回，不等到超时
- 有标签页但不持有指定工作簿 → `SJS_LIVE_UNKNOWN_TARGET`，消息里列出**实际** attached 的 id

这两种是模型能据以行动的；超时不是。

> 注：`dsh-api-gateway/lib/index.js:457` 有 `webServer.registerUpgrade` + WebSocket 的写法可参考。
> 想换成真推送时用它，代价是要引入 `ws` 依赖并自己做 401/403 upgrade 拒绝与重连。

---

## 6. 安全模型

| 面 | 做法 |
|---|---|
| 工作簿暴露给谁 | **只有我们**——编辑器主动 `attach`，不发布公共服务 |
| 第三方能否够到编辑器的工作簿 | ❌ 不能——我们的公开面只有 `attach`，没有操作入口 |
| 第三方能否 attach 自己的工作簿 | ✅ 可以，且无泄漏（它只能影响它本就拥有的对象） |
| Node 侧插件能否借我们的引擎用 SpreadJS | ❌ **设计上禁止**——`spreadjsHostBridge` 只存在于客户端 |
| 信任归属 | 工作簿到我们手上后，**我们成为必须被信任的一方**；`sjs_execute` 按设计执行任意代码。对外表述应为"**收敛到单一受控消费者**"，不是"无风险" |

---

## 7. 一致性：本方案最难的部分

活工作簿被改动后，**磁盘文件是旧的**；而我们的 `sjs_export` / `sjs_screenshot` / `sjs_status`
都读**文件** → 会看到过期内容。

**建议（v1）：活编辑即时落盘。**

```
sjs_live_execute → 浏览器执行 → 立即调 provider.save() 写回文件 → 返回结果
```

- 好处：**文件始终是唯一事实源**，现有 7 个工具语义完全不变，不存在分歧
- 代价：每次操作多一次保存（序列化 + 上传，几百毫秒量级）
- 后续若性能成为问题，再改为批量落盘

### 其余待决策（建议值）

| 问题 | 建议 |
|---|---|
| 多个设计器实例 | `attach` 以 `id` 寻址；`sjs_live_execute` 必须显式指定或使用"唯一活动项"，多于一个时报冲突 |
| 撤销栈 | 一次 `sjs_live_execute` 包成**一个** undo 单元 |
| 用户正在编辑时插入改动 | 落在同一活文档上，**天然不覆盖**用户未保存的编辑（相对"文件媒介"的核心优势） |
| 编辑器状态栏/脏标记 | 通过 `notifyExternalEdit(origin)` 告知，避免界面显示"已保存"而实际有未落盘改动 |

---

## 8. 失败与降级

| 情形 | 行为 |
|---|---|
| 无浏览器（headless profile） | client 半不加载；`sjs_live_*` 返回 `SJS_LIVE_NOT_ATTACHED` |
| 编辑器未安装 / 未 attach | 同上 |
| 宿主已 attach 但未打开文件 | `getWorkbook()` 返回 `undefined` → `SJS_LIVE_NO_WORKBOOK` |
| 指令执行抛错 | 与 `sjs_execute` 同款 `SJS_SCRIPT_ERROR` 等错误码回传 |
| 浏览器中途关闭 / 断连 | host 侧等待超时（建议 30 s，可配）→ `SJS_LIVE_TIMEOUT`，不阻塞会话 |
| 保存失败 | 改动已在活文档中生效，**明确回报"已应用但未落盘"**，不谎报成功 |

---

## 9. 建议分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **0 · 验证** | 编辑器接上 `attach` 后，控制台验证同一引用（`attach` 收到的 `getWorkbook()` 与设计器内部为同一对象） | 他们：~10 行 + optional peer |
| **1 · 打通** | 我们加 client 半 + host 桥（选 A/B/C）+ `sjs_live_status`、`sjs_live_execute`，含即时落盘 | 双方 |
| **2 · 体验** | SKILL 引导、undo 单元、冲突处理、状态栏联动 | 双方 |
| **3 · 收敛** | 评估是否把 live 并入 `sjs_execute` 的 `target` 参数 | 我们 |

---

## 10. 开放问题

1. **通道选型**：A（`@Remote` 长轮询，需评估 typert codegen 成本）/ B（forwarded events）/ C（`webServer` 路由）。
2. **即时落盘是否接受**（§7 建议值）。
3. **编辑器是否可能同时挂载多个设计器**（多面板/分屏）？若有，`attach` 需按实例寻址。
4. **live 路径的沙箱强度**：client 半的代码在用户浏览器里执行，与 Node 子进程的隔离级别不同。是否要禁用 `io.*` 文件访问等能力？

---

## 附：本方案不做什么

- ❌ 不搬对象 ❌ 不用文件作媒介 ❌ 不新增 HTTP 端点（若选 A/B）
- ❌ 不让编辑器执行我们的代码 ❌ 不让 Node 侧插件借我们的引擎使用 SpreadJS
- ❌ 不改动现有 7 个工具与其语义 ❌ 不影响 headless profile 与 CI
