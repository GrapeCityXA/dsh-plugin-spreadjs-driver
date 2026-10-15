# SpreadJS Driver for DeepSeek Harness

[GitHub](https://github.com/GrapeCityXA/dsh-plugin-spreadjs-driver) · npm: `@grapecity-software/dsh-spreadjs-driver`

[中文说明](#中文说明) · [English](#english)

让 AI 在 DSH Web UI 中打开、新建和操作 editor 提供的真实 SpreadJS 工作簿。

Open, create and edit editor-owned SpreadJS workbooks with AI in the DSH Web UI.

---

## 中文说明

driver 操作兼容 DSH 前端 editor 通过[桥接契约](docs/bridge-contract.md)提供的真实 SpreadJS Workbook 引用。editor 负责实例、授权、界面、加载、保存和恢复；driver 负责 AI 工具、聊天路由以及在该实例上执行代码。DSH 服务端只转发代码和 JSON 结果，不启动浏览器，不创建另一份 Workbook。

### 安装与使用

使用配套 Editor 时，可将两个插件安装到同一个 web profile：

```sh
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-editor
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-driver
```

将本 driver 和兼容 editor 安装到同一个 DSH web profile。使用配套 `@grapecity-software/dsh-spreadjs-editor` 时，在“设置 → 电子表格编辑器”中选择本 driver，打开工作簿并等待加载完成。SpreadJS 授权及使用 Designer 时所需的授权在 editor 中配置，按实际 Web UI 部署域名使用。需要 Node.js ≥22.19，需要 DSH ≥0.2.0-rc.2 以使用配套 editor 的桥接选择器。服务端无需安装 Chrome/Edge；纯命令行模式无法操作工作簿。

### 其他 editor 与依赖

配套 editor 是契约的一种实现，不是本 driver 的包依赖。其他 SpreadJS editor 可以发布 `spreadjsBridgeRegistry`，遵循用户明确选择 driver 的规则，并提供自己的 Workbook provider。将本 driver 的 `editorSettingsNamespace` 配置成该 editor 的 DSH 设置命名空间（默认 `spreadjs-editor`），工具与 skill 即跟随其中的 `bridge` 字段启停。Loader 配置示例、必需的实例身份/独占锁/保存能力，以及可选的导航能力见[接入契约](docs/bridge-contract.md)。仅使用 SpreadJS 不能自动适配，具体 API 还取决于 editor 的 SpreadJS 版本和已加载模块。一个 profile 由一个 editor 或协调器拥有 registry。

Driver 沿用 editor 的 SpreadJS 版本、模块和语言设置；配套 Editor 已加载中文语言资源。

本包没有运行时 `dependencies`，不包含 SpreadJS/Designer 引擎，也不把任何 editor 包列为 peer dependency。DSH peers 提供 Cordis、schema、tools、LLM 错误类型和 skills；开发依赖用于这些 API 的编译、构建与安装包测试。已清理旧 attachment 依赖及直接 session 依赖，聊天上下文由 DSH tools 服务提供。SpreadJS 授权及 Designer 依赖由 editor 管理。

### 工具

| 工具 | 用途 |
| --- | --- |
| `sjs_live_status` | 查询当前聊天的连接状态及可用工作簿。 |
| `sjs_live_open` | 打开工作区文件并等待 Workbook 就绪；`create:true` 从内置空白模板新建 `.xlsx`。 |
| `sjs_live_execute` | 在 editor 提供的 Workbook 实例上执行 JavaScript。 |

执行工具只接受 code/codeFile 之一，可指定 target；save 默认为 false。执行环境提供 spread/workbook、GC、sheet(name?)、snapshot()、console 和 signal（AbortSignal），结果必须可 JSON 序列化。代码共享 editor 页面环境。

状态和执行只针对调用工具的当前聊天。`target` 使用 status 返回的完整 `id`，不要自行拼接，文件重载或重新打开后需刷新状态。同一聊天有多个可用实例时必须指定 target，包括多个浏览器标签页打开同一个文件的情况。任务绑定浏览器、provider、聊天、文件和加载实例；实例被替换后旧任务不能继续执行。editor 必须提供当前实例身份与独占锁协议；缺少这些能力的旧 provider 不会作为可执行目标。

新聊天没有打开工作簿时，可以直接创建文件：

```js
sjs_live_open({ path: "test-output/report.xlsx", create: true })
```

Driver 从插件内置的 `templates/empty.xlsx` 复制新文件，再由 editor 打开并初始化。模板保留一个空白 Sheet1，包含 200 行、20 列。用户无需准备模板或创建目标目录；缺少的目录会在当前会话工作区内自动创建，已有文件不会被覆盖。不传 create 和 template 则打开已有文件。也可通过 template 指定工作区内的自定义模板，要求与目标扩展名一致，且不能与 create:false 同时使用。内置模板目前仅支持新建 `.xlsx`，其他格式需提供对应格式的模板。当前聊天必须显示在 Web UI 中；如果复制成功但打开失败，已复制的文件会保留。

执行代码示例：

```js
const s = sheet()
s.setValue(0, 0, '合计')
return snapshot()
```

### 执行、保存与恢复

修改立即显示在 editor 中。仅当用户要求保存时使用 save: true，写入由 editor 完成；保存失败会明确返回错误，即使此前的编辑已经成功。直接 API 修改不保证进入 SpreadJS 撤销历史。

执行期间 editor 授予独占 lease，阻止并发编辑，并禁用冲突的保存、另存为、新建、导出操作。关闭或切换 editor 会使任务返回 `SJS_LIVE_INTERRUPTED`。配套 Editor 在销毁 Workbook 前保留页面内恢复快照；重新打开后检查已完成的部分再继续。该快照不会恢复 JavaScript 的执行位置，也不会跨页面刷新保留；快照失败会记入控制台。其他 editor 的恢复方式由各自实现，要求见接入契约。

取消或超时会撤销任务的保存权限。浏览器在异步执行期间、脚本完成后，以及导出完成、写回前检查权限；脚本可通过 `signal` 配合取消。若脚本忽略取消信号，独占锁会保留到脚本结束或 editor 销毁实例。已产生的部分修改保留；无法强行终止任意 JavaScript，已发送到服务端的写入仍可能完成。恢复缓存按完整聊天资源地址隔离，不同聊天中的同名文件互不影响。

### 迁移

已移除服务端 worker、CDP/无头浏览器引擎、SpreadJS 运行时依赖，以及 sjs_new、sjs_status、sjs_execute、sjs_import、sjs_export、sjs_screenshot、sjs_worktree 七个文件工具。旧 browserPath/live 配置不再支持。sjs_live_open 可以复制模板创建文件，Workbook 初始化、导入、导出继续由 editor 提供，driver 不会在缺少 editor 时回退到后台引擎。

只有 editor 明确选中本 driver 时才注册工具和 skill。无实例、正在加载或保存的工作簿不会作为可执行目标上报；旧状态可能在心跳过期前短暂保留，真正执行时会再次检查实例。

### 开发与文档

安装开发依赖后运行 `pnpm run ci`。构建产物只有 host/client bundle 及 host source map；验证覆盖桥接选择、聊天隔离、浏览器执行、保存失败、取消和安装包。

- [架构说明](docs/architecture.md)
- [第三方 editor / driver 接入契约](docs/bridge-contract.md)
- SpreadJS API 参考随包附带，位于 `skills/spreadjs/reference`。

---

## English

Inspect and edit live SpreadJS Workbooks supplied by compatible DSH web editors through the [bridge contract](docs/bridge-contract.md). The editor owns the browser instance, licensing, UI, loading, saving and recovery. This driver supplies AI tools, session routing and execution against that reference. The host dispatches code and returns JSON results; it never starts a browser or creates a second Workbook.

### Setup

For the companion Editor, install both plugins into the same web profile:

```sh
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-editor
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-driver
```

Install this driver and a compatible editor into a DSH web profile. With `@grapecity-software/dsh-spreadjs-editor`, open Settings → Spreadsheet Editor and select this driver, then open a workbook and wait for loading to finish. Configure SpreadJS licensing and, if used, Designer licensing in the editor for the domain serving the web UI.

Node.js 22.19 or later is required. DSH 0.2.0-rc.2 or later is required for the editor bridge picker. No browser installation on the DSH server is required. A CLI-only profile cannot edit spreadsheets through this driver.

### Other editors and dependencies

The companion editor is one implementation of the contract, not a package dependency. A third-party SpreadJS editor can publish `spreadjsBridgeRegistry`, honor explicit driver selection, and supply its own Workbook provider. Configure this driver's `editorSettingsNamespace` to that editor's DSH settings namespace (default `spreadjs-editor`); tools and skill follow its `bridge` field. See the contract for the Loader example, required identity/lease/save capabilities and optional navigation. Sharing the SpreadJS engine alone does not make an editor compatible, and supported APIs depend on the owner's SpreadJS version and loaded modules. One editor or coordinator owns the registry in a profile.

The Driver follows its owner's SpreadJS version, modules and language settings. The companion Editor loads Chinese language resources.

This package has no runtime `dependencies`, no SpreadJS/Designer runtime and no peer dependency on an editor package. DSH peers provide Cordis, schema, tools, LLM errors and skills. Development dependencies supply those APIs and build/pack tests; the old attachment dependency and direct session dependency have been removed. The session context is supplied by DSH's tools service. Spreadsheet licensing and any Designer dependency remain the editor's responsibility.

### Tools

| Tool | Behavior |
| --- | --- |
| sjs_live_status | Report transport readiness and the open editor workbooks. |
| sjs_live_open | Open a workspace file and wait for the editor's Workbook; use create:true to create an .xlsx from the bundled blank template. |
| sjs_live_execute | Run an async JavaScript body against the editor's Workbook. |

Execution accepts exactly one of code or codeFile (a file inside the session workspace), an optional target, and save (default false). It provides spread/workbook, GC, sheet(name?), snapshot(), console, and signal (AbortSignal). Return a compact JSON-serializable value. Code runs in the editor page and shares its globals.

Status and execution are confined to the calling chat. Use the opaque `id` returned by status as `target`; do not construct it or reuse it after a reload/reopen. Several available workbooks require an explicit target, including the same file open in several browser tabs. Jobs bind to a browser, provider, chat, file and load instance, and reject a replacement instance. Editors must provide the current identity/lease protocol; an older provider without these capabilities is not an executable target.

Example execution body:

```js
const s = sheet()
s.setValue(0, 0, 'Total')
return snapshot()
```

For a new chat without an open workbook, create a file, then execute against the loaded workbook:

```js
sjs_live_open({ path: "test-output/report.xlsx", create: true })
```

The plugin ships its own `templates/empty.xlsx` with one blank Sheet1 spanning 200 rows and 20 columns; users do not need to prepare a template or destination directories. Missing directories are created inside the calling session workspace, and an existing destination is never overwritten. Omit `create` and `template` to open an existing file. An optional `template` path inside the workspace creates a file of the same extension, including other supported formats; `create:false` cannot be combined with `template`. The bundled default supports `.xlsx` only. The calling chat must be visible in the web UI. Copying and opening are separate steps: if opening fails, a successfully copied file remains on disk.

### Execution, saving and recovery

Changes remain in the editor until saved. Pass save: true only when the user requested writing the file; save errors are returned even if the preceding edit succeeded. Direct API calls are not guaranteed to enter SpreadJS's undo history.

During execution the editor grants an exclusive lease, blocks concurrent editing, and disables conflicting save/new/export actions. Closing or switching the editor interrupts the job with `SJS_LIVE_INTERRUPTED`. The companion Editor snapshots before destruction into a page-local cache; reopen and inspect partial changes before continuing. That cache does not resume JavaScript or survive a page refresh; snapshot failures are logged. Other editors own their recovery policy as described in the contract.

Cancellation and timeout revoke the job's permission to save. The browser checks permission during async work, after the script, and after export before write-back. Use `signal` for cooperative cancellation. A script that ignores it retains its lease until it settles or the editor destroys the instance. Partial edits remain; arbitrary JavaScript cannot be forcibly stopped, and a write already sent to the server may still complete. Recovery snapshots are keyed by the full chat resource address, so same-named files in different chats remain separate.

### Migration

The server worker, CDP/hidden-browser runtime, SpreadJS runtime dependencies, and seven file tools (sjs_new, sjs_status, sjs_execute, sjs_import, sjs_export, sjs_screenshot, sjs_worktree) have been removed. browserPath and live configuration options are unsupported. There is no fallback to a server engine when the editor is absent. New files can be copied from templates through sjs_live_open; all Workbook initialization, import and export remain editor features.

The driver registers its tools and bundled skill only while explicitly selected in the editor. An unavailable/loading Workbook is not offered as a runnable target. A previously advertised target can remain visible briefly until the channel's heartbeat expires; execution checks the reference again.

### Development

Install dependencies, then run pnpm run ci. The build emits only lib/index.js and lib/client.js (plus the host source map). Tests cover selection, authenticated transport, browser execution and save failures; pack checks reject legacy engine artifacts. The bundled API reference is under skills/spreadjs/reference. See [architecture](docs/architecture.md).
