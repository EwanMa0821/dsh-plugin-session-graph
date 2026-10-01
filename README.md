# 会话图谱 · Session Graph

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的插件：把会话从一条**线**变成一张**图**。

一轮交互是一个块。从任意块可以**分叉**出一条继承完整历史的新对话。散落在各分支上的结论可以用**连线**接起来。
整张图可以**导出**成思维导图软件认得的格式，用户提问与助手回答在同一个节点内分段区分。

```
   会话头 ──┬── 第1轮 ── 第2轮 ──┯── 第3轮 ── 第4轮
            │                   │
            │                   └── ⑂ 子会话 ── 第1轮 ── 第2轮
            │
            └── 第1轮 ── 第2轮        ← 另一条分支（会话头独立成列）
```

竖排是同一个会话的先后轮次，向右是分叉出去的子孙，实线是派生关系。

---

## 功能

| | |
|---|---|
| **图谱视图** | 与「对话」「轨迹」并列的第三个视图；整族会话（自己 + 祖先 + 所有分叉）一起出现 |
| **块** | 一轮交互一个块，显示轮次、状态、提问与回答摘要、工具调用与交付物计数 |
| **分叉** | 双击块，或选中后点「从这里分叉」，从那一轮的结束边界切出一条新会话 |
| **连线** | 手动把两个块接起来，表达"结论 B 建立在 A 之上"这类跨分支关系 |
| **隐藏** | 把探索过程中的死胡同折叠起来；被隐藏块的连线一并消失，导出时记录跳过数量 |
| **导出** | FreeMind `.mm` 与 Markdown `.md`，可直接导入 XMind / Freeplane / MindManager |

---

## 安装

要求 DeepSeek Harness `0.2.0-rc.2` 或同一 minor 的更高版本。

1. 打开 Web 界面左侧栏的 **插件** 页
2. 点 **安装插件**，填入本仓库地址：
   ```
   https://github.com/EwanMa0821/dsh-plugin-session-graph
   ```
   （也可以填本地目录的绝对路径）
3. 安装完成后如果显示为**已停用**，点 **启用**

然后**刷新页面**。图谱是客户端插件，浏览器需要重新取一次模块图才会出现新标签；刷新后仍没有就重启宿主进程。

### 从源码安装

克隆到任意目录，然后在插件页填入该目录的绝对路径。插件**零依赖**，安装过程不会执行任何构建脚本。

---

## 用法

| 操作 | 结果 |
|---|---|
| 点视图标签栏的 **图谱** | 进入图谱，与「对话」「轨迹」并列 |
| 单击块 | 右侧详情：完整提问、完整回答、元信息与操作 |
| **双击块** | 从该轮分叉出新会话（继承到该轮为止的完整历史） |
| 拖空白 | 平移视口 |
| **拖块** | 移动块，连线跟随，松手后写入自有布局 |
| 滚轮 / 捏合 | 以指针为锚缩放（25%–200%） |
| 双击空白，或按 `F` | 适应视图 |
| 方向键 | 在相邻块之间移动选中，只在按键方向的锥内走 |
| `Esc` | 关闭导出对话框 / 清除选中 |
| 点会话头 | 切换当前会话 |
| **显示已隐藏** | 半透明显示被隐藏的块，连线一并恢复 |
| **折叠其他会话** | 只保留会话头与派生边，用于压密度 |
| **↶ 撤销** / `Ctrl+Z` | 回退上一步（隐藏、重命名、连线的新建与删除） |
| **导出** | 选格式、看预览、下载 |

**进行中的轮次不能分叉。** 日志里没有 `turn/end` 的轮次没有可用的切点，产品自身的分叉动作同样用不了它——
这不是限制，而是不让你切在一个错误的 seq 上。

---

## 导出：一个块 = 一个节点，节点内区分问答

导出结果里**每个块是同一个节点**，节点内部用三层保底区分用户提问与助手回答——
同一份文本，任何一层都不缺内容：

| 层 | `.mm` 里的表现 | 谁会用到 |
|---|---|---|
| 1 | `richcontent TYPE="NODE"`：`<p><b>问</b>…</p><p><b>答</b>…</p>` | Freeplane / XMind / MindManager 直接看到两段 |
| 2 | `richcontent TYPE="NOTE"`：完整问答 + 元信息 | 大多数工具显示备注，作为保底 |
| 3 | `TEXT` 里的提问截断 | 连备注都不显示的工具至少能看到提问 |

结构映射：

| 图谱 | 导出结果 |
|---|---|
| 分叉出来的会话 | 挂在**它的分叉源块**节点之下（真正的树，不平级） |
| 引用式会话 | 挂在源块之下，加虚线边与书签图标 |
| 手动连线 | `<arrowlink>` 箭头链接 / 文末清单 |
| 别名 | `TEXT` 前置 `✎ `，轮次后括号标注 |
| 隐藏块 | 按选项跳过，跳过数量写进根备注 |

**正文按其原有 Markdown 结构嵌入**，不会被压成一行：

- `.md` 里正文是一个**缩进块**，所以表格、代码围栏、有序列表都能正确渲染
- `.mm` 的 richcontent 是 **HTML 而不是 Markdown**，所以行内标记会转成 `<b>` / `<code>` / `<a>`，
  表格分隔行与 ``` 围栏标记被丢掉，**围栏内的内容原样保留**（代码里的 `a ** b` 不会被误吃）

---

## 工作原理

插件由两半组成，都是**纯 JavaScript，零依赖**。

**Host 半**（`index.js`）只做一件事：贡献一条 Fetch 路由 `/api/session.graph-export`。

- `GET` 返回家族数据（`format=json`）或导出文件（`format=mm|md`）
- `HEAD` 取消响应体，只回状态与响应头——浏览器的下载预检要用
- 参数非法 → 400，依赖服务缺失 → 503

**客户端半**（`client.js`）向 `conversation.view` 槽位注册「图谱」视图，另外注册一个视图数据层，
把装配器的轮次时间线折成快照。

正文一律按 **Markdown** 处理：详情面板直接用宿主的 `MarkdownText` 渲染，与产品其余部分排版一致；
画布上的一行摘要用 `extractMarkdownPlainText` 抽成纯文本。正文在数据层**保留换行**——
表格、代码块、列表全靠它成立，压成一行就全塌了。

`src/` 是唯一真源，分成三层：

```
src/core/model.js    块、边、家族范围、图模型（纯函数）
src/core/graph.js    分层布局、路径、适应视图、键盘导航（纯函数）
src/core/export.js   FreeMind .mm 与 Markdown .md（纯函数）
src/host/fold.js     事件流 → 轮次；由继承事件数反推分叉源
src/client/app.js    客户端应用
```

### `client.js` 是生成物

宿主的 `__ModuleLoader__` 以懒加载 CJS 装载客户端产物，里面只能 `require('react')`，
**无法 `import` 本包的 ESM 源码**。所以构建放在作者侧：`scripts/build-client.mjs`
把三个核心模块的 `import/export` 降级后内联，拼成 `client.js`。

发布物是**预构建**的，安装时不跑任何构建脚本。改了 `src/` 必须重新生成，
否则 `check-package.mjs` 会直接判失败。

---

## 开发

```bash
node scripts/run-tests.mjs      # 182 项测试，在同一进程内运行
node scripts/check-package.mjs  # 清单、图标、patch、产物是否过期
node scripts/build-client.mjs   # 改过 src/ 之后必须跑
```

测试分三层：`test/core.test.mjs`（纯逻辑）、`test/host.test.mjs`（事件折叠与路由）、
`test/client.test.mjs`（把生成的 `client.js` 装进最小浏览器环境，用带 hook 运行时的小 React
**真渲染一次**，而不是只断言字符串）。

---

## 实现说明：与 DSH 的契约

这些是在真实宿主上逐条核对出来的，写下来省得后来者再踩。

| 项 | 事实 |
|---|---|
| 视图注册 | `ctx.slots.register` 接受 `{name, id, order, label, inject}`；`inject(sessionId)` 的返回值会并进组件 props |
| 视图数据层 | `ctx.uiConversation.views.register({target, create})`；`target` 为键，重复注册抛错 |
| builder 契约 | 整体重建走 `replace({nodes, timeline, changedTurns})`，增量走 `apply({upserts, timeline, changedTurns})`；**时间线没变时必须返回同一个引用**，否则下游每次都重建 |
| 轮次记录 | `{turn, start, end, status, steps, data}` —— 有边界，**没有问答文本**。文本只在 `data` 里按插件定义键存放，且是呈现态，取不出原文 |
| 内容来源 | 因此必须由 Host 侧折叠原始事件；装配器的 `timeline` 只能提供结构 |
| 事件类型 | `turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/message`；`turn/end` 是**唯一**的轮终止事件 |
| `user/message` | `source` 是**对象** `{kind:'user'}`（不是字符串），内容在 `data.content` |
| `assistant/message` | 内容在 `data.message.content` |
| `sessionQuery.observeSession(id)` | **异步**，返回需要释放（`Symbol.dispose`）的观察句柄；`await` 之后才有 `.events` |
| Host 服务名 | `sessions` / `sessionQuery` / `sessionPersistence` / `attachments`，用 `ctx.get(name)` 读 |
| 分叉切点 | 子会话 header 的 `inheritedEventCount - 1` 就是源会话的切点 seq，找出 `endSeq` 等于它的那一轮即可 |
| 客户端分叉 | `ctx.sessions.fork({sessionId, atSeq, increaseTitle})`；失败抛 `SessionForkError` |
| Fetch 路由 | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` |
| 下载 | `document.createElement('a')` → 设 `href` → **不挂到 `document.body`** 直接 `click()` |
| 客户端 UI 基础件 | `@deepseek-ai/dsh-client-ui-primitives` 是**基线模块**，客户端产物可直接 `require`（`dsh-client-ui-conversation` 自己也这么干，且没有插件把它写进 `dsh.client.external`）。`MarkdownText` 的 props 是 `{text, labels, variant, streaming}`，**`labels` 必给**，否则内部读属性会炸；键只有 6 个。`extractMarkdownPlainText(text, {mode})` 支持 `all` / `first-line` / `first-paragraph` |
| 主题 | 只用 `--dsw-alias-*` 变量；除 `react` 与上面那个基础件外不 require 任何宿主包 |

### 三个会让插件静默失效的坑

`scripts/check-package.mjs` 会拦住前两个。

1. **`Config` 必须是 Schemastery schema。** 用普通对象声明会让配置校验失败、fiber 被拒，
   **整个 Host 半不加载**，浏览器侧只看到一个 404。
2. **插件级 `inject: ['connection']` 在服务缺席时会让插件永远停在 pending**，模块不加载、路由不注册。
   要用可选服务就写 `ctx.inject([...], cb)`，让插件本体先挂载。
3. **不要把新的事件 `type` 写进会话日志。** 读取方要求 `ignorable: true`，而 `Session.append()`
   设不了它——写进去会让整个会话打不开。插件只读不写，正是为了绕开这条。

---

## 完成度

**已完成**

| | |
|---|---|
| 图谱视图 | 与「对话」「轨迹」并列；整族会话一起呈现 |
| 分叉 | 双击块，或选中后从该轮的结束边界切出新会话 |
| 手动连线 | 拖块右下圆点、或详情面板「连接到…」再点目标；标签可就地编辑与删除 |
| 重命名 | 块可设别名（图谱上带 ✎），留空恢复自动标题 |
| 撤销 | 工具条 `↶ 撤销` 与 `Ctrl+Z` 逐步回退，上限 50 步 |
| 手动布局 | 拖块摆放，连线跟随，松手写入自有布局；已摆过的坐标即权威 |
| 隐藏 | 被隐藏块参与的所有连线一并隐藏；工具条开关可半透明显示回来 |
| 持久化 | 隐藏 / 别名 / 连线 / 坐标 / 视口写进宿主存储域，跨重启保留 |
| 导出 | FreeMind `.mm` 与 Markdown `.md`，块内分段区分问与答 |
| 规模降级 | 按块数分档：>800 省略块内正文与边标签，>3000 只画骨架 + 当前会话（可 ▸ 就地展开）；布局超预算时提示 |

**未做**

| | |
|---|---|
| 引用式新建会话（FR-7） | 建模与渲染已就位（点线 + 空心箭头），缺创建入口 |
| 跨会话定位该轮（FR-14） | 需要切到对话视图并滚动到指定轮次 |
| 界面文案本地化（NFR-3） | 文案目前硬编码中文；`locale/` 只供插件管理页展示 |
| 位图绘制（NFR-1 字面要求） | 需求写「>800 由矢量元素切换为位图绘制」，这里改为丢弃块内正文与边标签达到同样的预算目标，理由见下 |

### 关于 NFR-1 的一处有意偏差

需求文档写「块数 > 800：渲染由矢量元素切换为位图绘制」。**位图绘制没有实现。**

改成丢弃块内正文与边标签，因为：

- 位图绘制要重写整个渲染层（自绘文字、命中测试、缩放重绘），代价与收益不成比例；
- 它会一起丢掉**文本选中**与**可访问性**——而这两条分别写在 FR-10 与 NFR-5 里；
- 实测的耗时大头正是每块的富文本与每条边的标签，去掉它们就已拿到同样的预算效果。

骨架档（> 3000）的行为与文档一致：只画分叉骨架 + 当前会话块，其余会话**只出头**，
点会话头上的 `▸` 就地展开。祖先会话默认不展开——那往往正是最大的那一个。

---

## 许可证

[MIT](./LICENSE)
