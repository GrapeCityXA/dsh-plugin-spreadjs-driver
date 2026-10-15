# Release Notes / 版本记录

## 0.1.1

### 中文

**优化与 SpreadJS 编辑器的协作方式**

- AI 通过桥接协议操作编辑器中的当前工作簿，编辑结果实时呈现。
- 支持从内置空白模板创建 `.xlsx` 文件，自动创建目标目录，并请求编辑器打开、完成初始化；已有文件不会被覆盖。
- 执行期间提供独占编辑保护；编辑器关闭或切换时中断任务，配套 Editor 保留未保存内容的恢复快照。
- 按聊天、文件和加载实例绑定任务；完善取消与保存权限检查。
- 支持其他实现相同桥接协议的 SpreadJS 编辑器，可配置 editor 设置命名空间。
- 适配 DSH `0.2.0-rc.2`，需要 Node.js ≥22.19。

**升级提示：** 本版调整了 AI 工具接口，统一使用 `sjs_live_open`、`sjs_live_status` 和 `sjs_live_execute`，旧版文件工具停止提供。AI 操作需要启用兼容的 SpreadJS 编辑器，并在执行期间保持工作簿可用。修改默认不保存，写回文件需明确请求；恢复快照仅在当前页面生命周期内有效。

### English

**Improve collaboration with SpreadJS editors**

- Operate on the editor's current Workbook through the bridge contract, with changes shown immediately.
- Create `.xlsx` files from the bundled blank template, create missing destination directories, and request editor initialization. Existing files are never overwritten during creation.
- Hold an exclusive editing lease during execution. Closing or switching the editor interrupts the task; the companion Editor preserves a recovery snapshot of unsaved work.
- Bind tasks to their chat, file and load instance, with cancellation and save-permission checks.
- Support other SpreadJS editors implementing the same bridge contract, with a configurable editor settings namespace.
- Target DSH `0.2.0-rc.2` and require Node.js ≥22.19.

**Upgrade notes:** AI tools now use `sjs_live_open`, `sjs_live_status` and `sjs_live_execute`; the previous file tools are no longer provided. AI operations require an enabled compatible SpreadJS editor and an available Workbook throughout execution. Changes remain unsaved by default; file write-back requires an explicit request. Recovery snapshots last only for the current page lifetime.
