# @grapecity-software/dsh-spreadjs-driver

> 为 DeepSeek Harness (DSH) 提供 SpreadJS 电子表格能力：通过内置的 `sjs_*` 工具创建、查看、编辑、导入、导出与截图 `.xlsx`/`.ssjson` 工作簿。

[English](README.md) · 简体中文

`@grapecity-software/dsh-spreadjs-driver` 是 DeepSeek Harness 的 [SpreadJS](https://www.grapecity.com/spreadjs) 插件。它把 SpreadJS 引擎内嵌进 Agent 运行时，让 Agent 能够构建表格、写入数值与公式、调整工作表结构，并可视化地核验结果——最终交付可直接用 Excel、WPS Office 等兼容应用打开的 `.xlsx`（或 `.csv` / `.pdf`）。引擎跑在一个隐藏的系统浏览器里（插件把它常驻着：第一次表格操作时启动，每次操作给它一个新页面，随 DSH 进程一起结束，用户看不到）。

## 环境要求

- **Node.js ≥ 22.19**，以及 **DeepSeek Harness** 运行时（`@deepseek-ai/dsh` `0.1.7-alpha.1` 或更高）。
- **宿主机需装有 Google Chrome 或 Microsoft Edge**。引擎运行在真实浏览器进程中（插件不自带浏览器内核，也不会弹出任何界面）。两者都在时优先用 Chrome——Edge 会把自己的标签页发布进 Windows 外壳，在 Alt+Tab 里堆积条目；两种情况都可以用插件配置 `browserPath` 指定具体可执行文件。都找不到时报 `SJS_BROWSER_UNAVAILABLE`，并在消息里列出探测过的路径。
- 需要一个可写的临时目录，用于浏览器的一次性 profile。
- **`.pdf` 导出要保留中文，字体必须由宿主机提供。** 插件**不自带任何字体**：它在操作系统的字体目录（以及环境变量 `GC_SJS_PDF_FONT_DIRS` 追加的目录）里找 `.ttf` / `.otf`，有一个就够。Windows 和 macOS 一定有；**默认安装的 Linux 通常没有**——它的中文字体多是 `.ttc`，而 SpreadJS 无法嵌入 `.ttc`，所以要事先装一个 `.ttf`，或用 `GC_SJS_PDF_FONT_DIRS` 指过去。找不到可用字体时，`.pdf` 导出会以 `SJS_PDF_FONT_UNAVAILABLE` 明确失败，而不是交回一份文字缺失的 PDF。`png` 截图不需要这些——浏览器自带真实字体，且按字形逐个回退。

**关于 DSH 版本区间。** `dsh.engines.dsh` 与各 `@deepseek-ai/*` peer 区间写的是 `>=0.1.7-alpha.1`：
本插件用到的 settings API 从 0.1.7 起才存在（见《被设计器驱动》），更早的宿主跑不了。

关于这个写法有两点要直说，因为 peer 区间最容易被人误读。**DSH 并不校验它**：`peerDependencies`
在全树只有两处读取，且都只取**名字**，而 `dsh-package-manifest` 明写 `engines.dsh` 是
「declarative until a reader enforces it」。所以这个区间是**文档，不是闸门**——在 0.1.6 上照样
装得上，然后插件安静地不工作；这也正是为什么下限要写下来，而不是指望它拦。另外，peer 里只列**运行时
真正会解析**的包（`schemastery`，浏览器半还有 `react`）；那几个 `@deepseek-ai/dsh-*` 列出来，是因为
宿主组合必须提供它们，不是因为 bundle 里 import 了它们。

## 安装

需要 DSH `0.1.7-alpha.1` 或更高，并装有 Google Chrome 或 Microsoft Edge（引擎跑在系统浏览器里，插件不自带浏览器内核）。

插件无需编译。使用已安装的 DSH CLI 安装并启动：

```sh
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-driver
dsh --profile web
```

启动后，直接让 Agent 处理表格即可——例如"把 data 目录下的 q2.xlsx 导入，加一列合计再导出"。

无头 profile 同样可用（该插件只添加工具，不依赖 Web UI）：

```sh
dsh plugin --profile sjs add @grapecity-software/dsh-spreadjs-driver
dsh --profile sjs "在工作目录建一个新表格并导出 xlsx"
```

也可以通过 npx 安装并启动：

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile web add @grapecity-software/dsh-spreadjs-driver
npx --yes @deepseek-ai/dsh@latest --profile web
```

从本地 tarball 安装（开发用）：

```sh
dsh plugin --profile web add ./grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

## 提供的工具

插件内置一个薄编排 skill（`spreadjs`）与以下工具：

| 工具 | 用途 |
| --- | --- |
| `sjs_new` | 为一张新表创建工作簿。 |
| `sjs_import` | 将已有的 `.xlsx` / `.csv` / `.ssjson` 引入为工作簿。 |
| `sjs_status` | 查看工作表、尺寸与已用区域。 |
| `sjs_execute` | 对工作簿执行 SpreadJS JavaScript（完成窄工具无法表达的复杂编辑）；执行后自动保存文件。 |
| `sjs_live_execute` | 对**用户在设计器里正打开的那个工作簿**执行 SpreadJS JavaScript（跑在用户浏览器里）——改动立刻上屏，除非显式传 `save: true`，磁盘文件不动。仅 web profile 可用，且要求设计器里确实打开着文件。 |
| `sjs_screenshot` | 视觉快照：`png` 对活动工作表做像素渲染，或 `pdf` 打印布局快照。 |
| `sjs_export` | 产出你要打开的文件：`.xlsx`、`.csv`、`.pdf`，或 `.ssjson` 副本。 |
| `sjs_worktree` | 为已提交的工作簿创建隔离的草稿快照（`create`），或列出打开的草稿（`list`）。 |

### 关于那两个文件

你面对的是 **`.xlsx`**。它旁边还有一份 **`.ssjson`** 同伴文件——那是 SpreadJS 自己的
无损格式，也是引擎每次调用真正读写的对象。它**是给程序看的**：你不需要打开它，
Agent 也被要求不要把它带进对话。

数据流是刻意**单向**的：

```
你的 .xlsx  ──sjs_import──▶  .ssjson（工作文件）  ──sjs_export──▶  你打开的 .xlsx
```

导出的 `.xlsx` **永远从工作文件派生，而不是从上一个 `.xlsx` 再导入**。每次编辑都往
Excel 里绕一圈，会让 `.xlsx` 转换固有的细小损耗逐次累积；单向流动则把损耗限制在
「一次导入 + 一次导出」之内。

导出同时也是刷新已有 `.xlsx` 的方式：更早导出的文件在此后继续编辑就会变旧，
需要就重新导一次，别默认它是最新的。

## 典型流程

用自然语言描述你想要的表——Agent 会遵循 skill 的推荐流程：定位或新建工作簿，非平凡改动先建草稿（worktree），用 `sjs_execute` 小步编辑并核验，最后用 `sjs_screenshot`/`sjs_export` 交付成品。

例如："做一个月度销售表：表头一行、四个产品行、加一列 SUM，最后导出成 Excel。"

也可手写编辑：`sjs_execute` 运行一个 async 函数体，作用域含 `spread`/`workbook`、`GC`、`sheet(name?)`、仅限工作区的 `io`、`console` 与 `snapshot()`（**没有** `require`、`process`、`fs`）：

```js
const s = sheet()
s.setValue(0, 0, '产品'); s.setValue(0, 1, '数量')
for (let r = 1; r <= 4; r++) { s.setValue(r, 0, 'SKU-' + r); s.setValue(r, 1, r * 10) }
s.setFormula(5, 1, '=SUM(B2:B5)')
return { total: s.getValue(5, 1) }
```

完整的工具地图、执行环境契约与错误码恢复表见 `skills/spreadjs/SKILL.md`；引擎运行时的嵌入方式见 `docs/architecture.md`。

## 被设计器驱动：`spreadjsBridgeRegistry`

`sjs_*` 那些工具只是这个插件的一半。另一半是它作为**桥**的身份：编辑器插件发布一份"桥"的
名册，有能力驱动活工作簿的插件注册进去，**用户在 设置 → SpreadJS 里选用哪一个**。本插件
就是名册上的一项。

之所以成立，是因为 DSH 客户端插件的浏览器半**不是沙箱**：所有插件的客户端半被加载进同一个
页面、同一个 JS realm、同一个堆，所以工作簿是**以引用而非副本**过去的。不序列化、不走 HTTP、
不落文件。宿主插件继续渲染的就是 Agent 刚写过的那个对象，改动落地即上屏；而且因为它落在
活文档上，**不会覆盖用户尚未保存的编辑**——这一点是按文件走的路子给不了的。

### 为什么是名册，不是服务名

原来是 `spreadjsHostBridge`：本插件发布它，编辑器按名字注入。那种形状**结构性**地只允许
一个桥——第二次 `provide` 一个已存在的服务名会**抛错**，而抛错发生在第二个插件的 `apply`
里，所以那个插件根本装不上。没有成链、没有后者覆盖、没有扇出：`get`/`inject` 只看得到一个值。
（实证：一份完整 DSH 树里的 239 个包，没有任何两个共用一个服务名。）所以"让用户选"用那种
形状做不出来。

它要按 DSH 处理所有"多方贡献"的方式来做——`ctx.tools`、`ctx.llm.registerAdapter`、
`ctx.slots`——即**一个服务，多方注册进去**。名册总得有人发布，而**编辑器**是握着工作簿的
那一方，所以它拥有"谁可以拿到这份工作簿"的名单。于是依赖方向变成 **提供方 → 编辑器**。
这是这段关系诚实的描述：桥本来就是编辑器工作簿的消费者。依赖仍然是可选的——没有编辑器时
注入不会触发。

### 契约

```ts
// 你的插件/src/client/index.ts
const REGISTRY = 'spreadjsBridgeRegistry'

interface SpreadjsBridgeEntry {
  readonly id: string                   // 名册内唯一；也是条目键
  readonly title: () => string          // 设置页上显示的名字
  attach(provider: SpreadjsWorkbookProvider): () => void
}

interface SpreadjsWorkbookProvider {
  readonly id: string                   // Agent 靠它寻址
  getWorkbook(): unknown | undefined    // 你的活 Workbook；没打开时返回 undefined
  getNamespace?(): unknown              // SpreadJS 命名空间，会作为 `GC` 注入 Agent 代码
  getActivePath?(): string | undefined  // 会随每次编辑回报给 Agent
  save?(): Promise<void>                // 仅在 Agent 明确要求保存时被调用
}

export function apply(ctx: ClientContext): void {
  ctx.inject([REGISTRY], (child) => {
    child.effect(() => {
      const registry = child.get(REGISTRY) as SpreadjsBridgeRegistry | undefined
      if (registry === undefined) return
      return registry.register({
        id: '@acme/dsh-spreadjs-bridge',
        title: () => 'Acme Bridge',
        attach(provider) {
          // 编辑器把一份活工作簿交过来；留住这个引用，并在返回的函数被调用时释放它
          held = provider
          return () => { held = undefined }
        },
      })
    }, 'my-plugin: spreadjs bridge')
  })
}
```

`getNamespace` 不是装饰：Agent 代码里注入的名字是 `GC`，脚本一旦要用枚举——比如
`GC.Spread.Sheets.UsedRangeType`、某个图表类型、某个对齐常量——没有它就根本跑不起来。
`save` 同样是可选的，而且只有显式传 `save: true` 才会走到，绝不会作为编辑的副作用被调用。

### Agent 因此获得什么

`sjs_live_execute`，通过它的 `target` 参数按你的 `id` 寻址。作用域与 `sjs_execute` 一致——
`spread`、`workbook`、`GC`、`sheet()`、`snapshot()`、`console`——唯独没有 `io`：`io` 由引擎
自己的回环服务提供，而这段代码跑在用户浏览器里。

**磁盘文件不动。** 编辑只活在活工作簿里，直到 Agent 显式要求保存——那是唯一会调用你的
`save()` 的路径。这个默认值是刻意的：Agent 应当能先提出一个用户看得见、撤得回的改动，
再谈落盘。

**这些工具是有条件的。** 本插件注册的所有东西——七个文件工具、两个 live 工具、以及自带的
skill——都只在**本插件是被选中的桥**时存在。在 设置 → SpreadJS 里选了别人，它们会一起让位，
因为这个 setting 命名的是**在此拥有电子表格**的插件，而不只是拿着活文档的那个。桥那一层是
编辑器执行的硬约束，工具那一层是每个 driver 各自遵守的约定——见下面的《自己实现一个 driver》。

### 有几件事是刻意不做的

- **名册是候选名单，不是广播。** 只有**一个**条目会拿到活文档——用户选中的那个——而编辑器
  始终是看门人。插件没有任何办法**够到**一份没被交给它的工作簿。
- **这个名册只存在于浏览器。** host 侧刻意**没有**对应物，所以 Node 侧插件无法借这个引擎在
  服务端跑 SpreadJS。
- **对你没有任何强制要求。** 编辑器不在场时 `ctx.inject` 不会触发，你的插件行为与从前完全
  一致；而 `register` 返回的注销句柄会在卸载时释放条目，被销毁的文档不会被吊着不放。

`@grapecity-software/dsh-spreadjs-editor`（**0.1.5 及以上**）就是示范消费方：名册由它发布，
它的 `src/client/bridge-registry.ts` 是契约的完整定义，`docs/design-live-designer-bridge.md`
记着这段历史。版本下限是有意义的——更早的编辑器里根本没有这个名册，联动会**静默缺席**而不是
报错，`sjs_live_execute` 只是永远找不到设计器。

> `subscribe` 目前只在 provider 接口上声明了，桥还没有读它——实现了也不会有效果。

## 自己实现一个 driver

在名册里注册一个条目，买到的是**工作簿**，买不到**模型的注意力**——工具清单是另一层，没有
任何东西在仲裁它。两个 driver 同时装着，就是两套重叠的工具并排摆在模型面前，而屏幕上选的是
谁、哪一套配它，没有任何东西说得清。要补上这个缺口，需要你做两件事。

### 一、提供你自己的工具

`ctx.tools.register()` 是**按插件**的：你注册的名字归你，而模型看到的清单是**所有已安装插件
的并集**。一个光有名册条目、背后没有工具的桥，等于把一份活工作簿交给模型却不让它碰。

| 工具 | | 必须做到什么 |
|---|---|---|
| `sjs_live_execute` | **必需** | 对编辑器交给你的工作簿执行 Agent 写的代码 |
| `sjs_live_status` | 强烈建议 | 回答"现在有没有设计器连着"——没有它，模型只能靠失败来发现这件事 |
| `sjs_new` `sjs_import` `sjs_export` `sjs_status` `sjs_execute` `sjs_screenshot` `sjs_worktree` | 仅当你也有无头实现时 | 在workspace 文件上操作，不涉及浏览器 |
| 一份描述这些工具的 `skill` | 如果你提供的话 | 教模型怎么用它们——并且跟着工具一起撤下（见下面的《让位》） |

关于命名有两条规矩：

- **用一个你自己占住的前缀。** `ctx.tools.register` 遇到重名会**抛错**，而这个抛错落在你的
  `apply` 里——一次撞名，你的插件根本不会激活。本插件占 `sjs_`，夹具
  `dsh-plugin-fake-driver` 用 `fake_sjs_` 正是因为这个。
- **不要换个名字把上面这套再注册一遍。** 十个工具描述同一份工作簿，等于让模型在两份清单之间
  选，而这正是让位协议要消掉的问题。

### 二、用户选了别人时让位

编辑器把选中的 id 写进它自己的 settings 命名空间。读它，让它决定你的工具在不在：

```ts
// 你的插件/src/host/presence.ts
const EDITOR_NAMESPACE = 'spreadjs-editor'
const MINE = '@acme/dsh-spreadjs-bridge'

let release: (() => void) | undefined

/** 在场与否是"当前选择"的纯函数——绝不是你进入、又必须离开的一个状态。 */
function sync(ctx: Context, register: () => () => void): void {
  const chosen = read(ctx)                     // 任何失败都返回 undefined
  const want = chosen === undefined || chosen === '' || chosen === MINE
  if (want === (release !== undefined)) return // 已经对了；重复注册会搅动工具清单
  if (want) release = register()
  else { release?.(); release = undefined }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const onDocument = ctx.on('settings/document-updated', (ns) => { if (ns === EDITOR_NAMESPACE) sync(ctx, register) })
    sync(ctx, register)
    return () => { onDocument(); release?.(); release = undefined }
  }, 'acme-bridge: tool presence follows the chosen bridge')

  // settings 服务可能在你之后才起来；条目被服务这件事本身不发事件。
  ctx.inject(['settings'], () => sync(ctx, register))
}
```

本仓库的 `src/host/activation.ts` 是同一件事加上写全了的理由，`test/activation.mjs` 是它必须
具备的行为。

真正要紧的几条：

- **读选择，别猜——而且要清楚哪种读法才有效。** 字段是 `bridge`，位于编辑器 Loader 条目
  id 所指的那个 settings 命名空间（`spreadjs-editor`）。在 DSH 0.1.7 上，宿主侧读另一个条目
  的值**只有** `ctx.settings.describe()` 一条路：它每个条目返回一个描述符，找到 `ns` 匹配的
  那个，读 `value.bridge`。早期版本那种按命名空间读的 `settings.get(ns)` 已经没了，而在这里
  抓错方法会以最糟的方式失败——抛错被下面的"失败往在场倒"吞掉，于是"在场"永远回答"是"，
  让位协议一声不吭地失效。想在任何回调里都读得到，就走 `ctx.get('settings')` 而不是注入。
- **派生，不要记忆。** 最容易写错的样子是"选中 A 时注销、A 走了再注册回来"——这需要一个东西
  记着把你放回来，而那个东西可能丢（刷新、崩溃、卸载）。把在场做成当前值的纯函数、每个事件
  都重新派生一次，就没有状态可失同步。
- **你发的每个工具都要 gate，不只是 live 那几个。** 这个 setting 命名的是**在此部署中拥有
  电子表格**的插件，而不只是"接收活文档"的那个。用户在别处选了别人、你还把文件工具留在清单
  里，模型就又回到猜的状态。本插件把九个工具全 gate 了。
- **你摆在模型面前的别的东西，也要一起 gate。** 本插件连同自带的 `spreadjs` skill 一起撤下，
  这不是细节：SKILL.md 就是教模型按名字调用 `sjs_*` 的那份文档，工具都撤了还留着它，等于递给
  模型一本它没有的能力的说明书。过期的 skill 比多余的工具更糟——它读起来是权威的。
- **失败往"在场"倒——但别让这一点掩盖了读坏掉。** 没有 settings 服务、编辑器命名空间没有
  描述符、值不是字符串——一律算**在场**。两种失败不对称：需要你时你不在，代价是用户失去工具；
  没事可做时你在，代价是清单里多一行。这个选择的代价是：一个**读错了**的实现（方法改名、
  字段搬家）看起来和"用户没做过选择"一模一样。所以把这段迁到新版 DSH 时，要拿真实会话验一遍，
  别因为编译过了就信。
- **听 `settings/document-updated`，按命名空间过滤。** 值变化时它触发，选择被**清回默认值**时
  也触发——后者才是这里要紧的情况。0.1.5 还会发一个 `settings/updated`，0.1.7 不再发，所以
  订阅它等于挂了一个永不执行的监听器：无害，但读起来像是有一层并不存在的覆盖。
  `inject(['settings'])` 那一遍，补的是"服务在你之后才起来、而选择早已做出"的那扇窗。
- **别动名册条目。** 让位让的是**工具**，不是你的桥条目。用户要靠在设置页上看到那个条目才能
  切回来，注销它等于把选择变成单向的。
- **不打招呼，也不指望回应。** 你读一个事实、自己判断、作用在自己身上。你永远不需要知道另一个
  driver 叫什么、在不在、配不配合。

### 你不能指望的东西

**对等回报。** 桥那一层是**硬约束**——活工作簿只会交给一个条目，而且是编辑器在把关。工具这一层
是**约定**，没有东西在执行它。无视这个 setting 的 driver 照样把工具留在清单里，症状恰好就是这
套协议要消掉的那个：两套重叠的工具，模型靠猜在它们之间选。单方面让位仍然值得做——它不花你什么，
靠自己就消掉一半问题——但用户要拿到正确的结果，得两个 driver 都这么做。

本 workspace 里的 `dsh-plugin-fake-driver` 就是为了让这件事**看得见**：它是第二个 driver，
让位方式和本插件一样，`build_fake.bat` 把它和另外两个一起装上。装好、在 设置 → SpreadJS
里选一个，看清单里剩下哪些工具。

## 说明

- 未授权引擎会标记它的产出，这是预期行为：png 渲染在画布上带 **"Evaluation Version"** 戳记，导出的 `.xlsx` 会多出一张同名工作表（`.pdf` 与 `.csv` 没有）。**刻意保留、不做清除**——插件不清，Agent 也不应去清。它不影响数据。
- 截图 `png` 是引擎在真实浏览器里的原始渲染：字体、字重、颜色都是真的；截图绝不修改工作簿文件。
- 本版本的 worktree 支持 `create`/`list`；审批（`merge`/`discard`）为后续阶段。
- `sjs_execute` 可驱动图表、形状、切片器与数据透视表（`shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` 包随插件一起分发）；png 截图会覆盖浮动对象，即使它位于已用单元格范围之外，或处于没有已用单元格的工作表（如透视表布局页）。
- 越界写入会自动扩展工作表而不是被丢弃；针对同一工作簿的操作串行执行，因此并行工具调用不会互相覆盖。
- 每次 `sjs_execute` 都在批处理模式下运行——重绘、变更事件与计算服务全部挂起，实测 2 万行带公式的填充快 3.6 倍。脚本中途若要读计算值需先 `spread.resumeCalcService()`；落盘与导出的值始终是完整计算过的。
- 当工作表超出 2600×2200 光栅上限时，png 结果会带 `clipped: true`，此时图片是裁剪版而不是报错。这些数字是 **CSS 像素**，而渲染是 **2 倍**的，所以结果里会报两个尺寸：`width`/`height` 是 CSS 像素（核对列宽算术时用的就是它），`pixels` 是文件本身的真实像素。

## 开发

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + export-integrity + tool-smoke
npm pack               # → grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

把 tarball 装进一个临时 profile，在真实会话中驱动这些工具做端到端冒烟。

## 许可证

MIT，见 `LICENSE`。所依赖的 `@grapecity-software/*`（SpreadJS）是独立产品，适用其自身的许可条款；本插件只负责把它接入 DSH。
