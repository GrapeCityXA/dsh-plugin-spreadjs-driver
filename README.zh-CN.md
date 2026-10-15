# @grapecity-software/dsh-spreadjs-driver

[English](README.md) · 简体中文

driver 只操作 DSH 前端 editor 提供的真实 SpreadJS Workbook 引用。SpreadJS 的创建、授权和渲染都由用户浏览器中的 editor 负责；DSH 服务端只转发代码和 JSON 结果，不启动浏览器，不创建另一份 Workbook。

## 使用

将 editor 和 driver 安装到同一个 DSH web profile，在“设置 → 电子表格编辑器”中选择本 driver，打开工作簿并等待加载完成。SpreadJS 和 Designer 授权在 editor 中配置，按实际 Web UI 部署域名使用。需要 Node.js ≥22.19，需要 DSH ≥0.2.0-rc.2 以使用 editor 的桥接选择器。服务端无需安装 Chrome/Edge；纯命令行模式无法操作工作簿。

提供三个工具：sjs_live_status 查询连接及打开的工作簿；sjs_live_open 打开文件并等待 Workbook 就绪；sjs_live_execute 在 editor 的实例上执行 JavaScript。执行工具只接受 code/codeFile 之一，可指定 target；save 默认为 false。执行环境提供 spread/workbook、GC、sheet(name?)、snapshot()、console 和 signal（AbortSignal），结果必须可 JSON 序列化。代码共享 editor 页面环境。

状态和执行只针对调用工具的当前聊天。`target` 使用 status 返回的完整 `id`，不要自行拼接，文件重载或重新打开后需刷新状态。同一聊天有多个可用实例时必须指定 target，包括多个浏览器标签页打开同一个文件的情况。任务绑定浏览器、provider、聊天、文件和加载实例；实例被替换后旧任务不能继续执行。两侧需同时更新以支持实例身份协议；旧 editor 不会作为可执行目标。

新聊天没有打开工作簿时，可调用 `sjs_live_open({ path: "test-output/report.xlsx", create: true })`，从插件内置的 `templates/empty.xlsx` 复制新文件，再由 editor 打开并初始化。模板保留一个空白 Sheet1，包含 200 行、20 列。用户无需准备模板或创建目标目录；缺少的目录会在当前会话工作区内自动创建，已有文件不会被覆盖。不传 create 和 template 则打开已有文件。也可通过 template 指定工作区内的自定义模板，要求与目标扩展名一致，且不能与 create:false 同时使用。内置模板目前仅支持新建 `.xlsx`，其他格式需提供对应格式的模板。当前聊天必须显示在 Web UI 中；如果复制成功但打开失败，已复制的文件会保留。

修改立即显示在 editor 中。仅当用户要求保存时使用 save: true，写入由 editor 完成；保存失败会明确返回错误，即使此前的编辑已经成功。直接 API 修改不保证进入 SpreadJS 撤销历史。

执行期间 editor 授予独占 lease，阻止鼠标和键盘编辑，并禁用冲突的保存、另存为、新建、导出操作。关闭或切换 editor 会使任务返回 `SJS_LIVE_INTERRUPTED`；editor 在销毁 Workbook 前，将当时的快照保存在现有页面内恢复缓存中。重新打开文件后可恢复，再检查已完成的部分并继续。快照不会恢复 JavaScript 的执行位置，也不会跨页面刷新保留；快照失败会记入 editor 控制台。

## 迁移

取消或超时会撤销任务的保存权限。浏览器在异步执行期间、脚本完成后，以及导出完成、写回前检查权限；脚本可通过 `signal` 配合取消。若脚本忽略取消信号，独占锁会保留到脚本结束或 editor 销毁实例。已产生的部分修改保留；无法强行终止任意 JavaScript，已发送到服务端的写入仍可能完成。恢复缓存按完整聊天资源地址隔离，不同聊天中的同名文件互不影响。

已移除服务端 worker、CDP/无头浏览器引擎、SpreadJS 运行时依赖，以及 sjs_new、sjs_status、sjs_execute、sjs_import、sjs_export、sjs_screenshot、sjs_worktree 七个文件工具。旧 browserPath/live 配置不再支持。sjs_live_open 可以复制模板创建文件，Workbook 初始化、导入、导出继续由 editor 提供，driver 不会在缺少 editor 时回退到后台引擎。

只有 editor 明确选中本 driver 时才注册工具和 skill。无实例、正在加载或保存的工作簿不会作为可执行目标上报；旧状态可能在心跳过期前短暂保留，真正执行时会再次检查实例。

开发验证：安装依赖后运行 pnpm run ci。详见 [架构说明](docs/architecture.md)。
