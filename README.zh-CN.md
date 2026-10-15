# @grapecity-software/dsh-spreadjs-driver

[English](README.md) · 简体中文

driver 只操作 DSH 前端 editor 提供的真实 SpreadJS Workbook 引用。SpreadJS 的创建、授权和渲染都由用户浏览器中的 editor 负责；DSH 服务端只转发代码和 JSON 结果，不启动浏览器，不创建另一份 Workbook。

## 使用

将 editor 和 driver 安装到同一个 DSH web profile，在“设置 → 电子表格编辑器”中选择本 driver，打开工作簿并等待加载完成。SpreadJS 和 Designer 授权在 editor 中配置，按实际 Web UI 部署域名使用。需要 Node.js ≥22.19，需要 DSH ≥0.2.0-rc.2 以使用 editor 的桥接选择器。服务端无需安装 Chrome/Edge；纯命令行模式无法操作工作簿。

保留两个工具：sjs_live_status 查询连接及打开的工作簿；sjs_live_execute 在 editor 的实例上执行 JavaScript。后者只接受 code/codeFile 之一，可指定 target；save 默认为 false。执行环境提供 spread/workbook、GC、sheet(name?)、snapshot() 和 console，结果必须可 JSON 序列化。代码共享 editor 页面环境。

修改立即显示在 editor 中。仅当用户要求保存时使用 save: true，写入由 editor 完成；保存失败会明确返回错误，即使此前的编辑已经成功。直接 API 修改不保证进入 SpreadJS 撤销历史。

## 迁移

已移除服务端 worker、CDP/无头浏览器引擎、SpreadJS 运行时依赖，以及 sjs_new、sjs_status、sjs_execute、sjs_import、sjs_export、sjs_screenshot、sjs_worktree 七个文件工具。旧 browserPath/live 配置不再支持。新建、导入、导出继续由 editor 提供，driver 不会在缺少 editor 时回退到后台引擎。

只有 editor 明确选中本 driver 时才注册工具和 skill。无实例、正在加载或保存的工作簿不会作为可执行目标上报；旧状态可能在心跳过期前短暂保留，真正执行时会再次检查实例。

开发验证：安装依赖后运行 pnpm run ci。详见 [架构说明](docs/architecture.md)。
