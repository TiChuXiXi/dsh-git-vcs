# task-001 上下文：DSH Git 版本管理插件（IDEA 风格）

- **任务ID**: task-001
- **任务名称**: 创建 DSH 专用 Git 仓库管理插件，功能与 UI 参照 IDEA 版本管理工具，入口在默认侧边栏
- **关联模块**: 插件清单（package.json / cordis.patch.yml）、host 半区（RPC 通道 + git 执行器）、浏览器半区（侧边栏入口 + 全局面板 UI）
- **关联分支**: main
- **创建日期**: 2026-09-14

## 涉及的关键文件和代码路径（规划）

| 文件 | 职责 |
|------|------|
| `package.json` | `dsh.bundle.patch` → cordis.patch.yml；`dsh.client`（platform web）+ `exports["./client"]`；`dsh.engines.dsh >= 0.1.5-rc.1` |
| `cordis.patch.yml` | `- insert: - id: git-vcs / name: <包名> / config: {...}` |
| `lib/index.js`（host 半区） | 注册 `ctx.connection.rpc.handle('/git-vcs', handler)`；用 `ctx.subprocess`（argv、无 shell）执行 git；Schemastery `Config`；(可选) `ctx.tools.register` 暴露模型工具 |
| `lib/client.js`（浏览器半区） | 闭包工厂产物：`sidebar.panellist` 图标注册 + `main` keyed 面板注册 + IDEA 式 React UI |
| `README.md` | 安装/配置/生效说明 |

## 调研结论（真源已核对，2026-09-14）

### A. 侧边栏入口怎么接（本机安装包实测，非猜测）

- **默认侧边栏由 `dsh-client-ui-sidebar` 占据**：它注册 `sidebar` 槽并在 `children` 中声明 `sidebar.panellist`（kind `list`, scope `root`）。**不要替换整个 `sidebar`**（会连带移除它声明的子槽）。
- **侧边栏面板行直接由 `sidebar.panellist` 的注册项生成**（读自本机 `dsh-client-ui-sidebar/lib/client.js`）：
  ```js
  const syncPanels = () => ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => ({
    id: options.id, order: options.order ?? 0,
    label: resolveSlotLabel(options.label) ?? id,
  })).sort((a, b) => a.order - b.order)
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'ui-sidebar: panel entries')
  ```
  行渲染 `renderSlot('sidebar.panellist', { size, active }, { only: id })`，点击调用 `ctx.layout.selectPanel(id)`。
- **`ctx.layout.selectPanel(id)` 要求 `main` keyed 槽里存在同 id 的注册**，否则抛 `main panel "..." is not registered`（读自 `dsh-client-ui-layout/lib/client.js`）。默认组合**不注册任何全局面板**，`main` 里只有保留 key `conversation`。
- ⇒ **入口方案：同 id 两次注册**
  1. `sidebar.panellist`（list，id = 面板 id，order，`label: () => '版本管理'`，组件画 16/18px 图标，收 `{size, active}`）
  2. `main`（keyed，id = 同一面板 id，组件是整块 IDEA 式工具窗口；选中时占据中栏，替换会话视图）
  用 `ctx.slots.inject(<slot>, () => ctx.slots.register(...))` 贡献（owner 折叠时随之移除）。
- 其他被否掉的入口：`sidebar.footer.action`（只够一个小动作）、`sidebar.workspaces`（会替换整个会话/工作区浏览区）、`rightbar` 的 `sidebar.right.pane.tab`（右侧栏，IDEA 的 VCS 窗口也可停靠右侧，但用户要求默认侧边栏）。

### B. host ↔ 浏览器 通信怎么走

- **首选（已核实签名）**：generic Connection RPC 通道，**不需要 Typert 代码生成**。
  - host：`ctx.connection.rpc.handle(channel, handler)`（`dsh-client-connection/lib/types/rpc-host.d.ts` → `Context.connection: HostConnectionHandle`），`handler = (endpoint, payload, signal) => Promise<ConnectionRpcResult<unknown>>`，注册的是**带认证的绝对通道前缀**（如 `/git-vcs`）。
  - client：`ctx.connection.rpc.call(channel, endpoint, payload, signal)`（`ClientConnectionRpc`），返回 `{ok:true,value} | {ok:false,error:{code,message,details}}`，**载体故障折入 error 分支，不 reject**。
  - 信任与认证由 Connection 统一负责（loopback + 签名 cookie；`Host`/`Origin` 校验），插件不需要自己搭 RPC。
- 备选（仅当需要流式/大响应）：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 注册精确 Fetch 路由。
- 已排除：`ctx.remote.<ns>` 生成式 Remote（需家族仓库的 Typert 生成管线，第三方插件不适用）。

### C. git 怎么执行（host 侧）

- `ctx.subprocess`（`dsh-subprocess`）：`resolveExecutable('git')` + `spawn({ argv, cwd, stdio, graceMs })`，**argv 不经 shell**（无注入面）；stdout/stderr 用 collect 模式（`maxBytes` + 可选 spill）或 pipe 流。
- `ctx.shell`（`dsh-shell`）也可，但它是"bash/pwsh 命令"语义且带沙箱模式；本插件用 subprocess 的 argv 形式更精确可控。
- 沙箱提醒：host 侧 git 写入发生在工作区内，但 `~/.dsh/profiles` 安装动作仍可能被沙箱拒（见 memory.md）。

### D. 会话/项目根从哪来（**2026-09-29 订正：DSH 0.1.7 起**）

- client 侧：`useSessions` 是**会话清单快照的选择器 hook**（`GlobalStandardProps`，所有 scope 都有），
  快照类型是 `SessionListState { ids, byId: Record<SessionId, SessionSummary{cwd?}>, phase, projectionsBySession }`
  （`dsh-api-session-controller/lib/types/client/sessions/service.d.ts`）—— **0.1.5 时代用来定位当前会话的 `current` 已被移除**。
  "本 tab 属于哪个会话"改由 session 作用域 slot 的标准 prop **`sessionId`** 给出
  （`SessionStandardProps`，见 `dsh-client-ui-session/lib/types/client/index.d.ts`），
  所以默认仓库路径 = `useSessions((s) => s.byId[sessionId]?.cwd)`（官方 `dsh-client-ui-sidebar-files` 在 0.1.7 里就是这句）。
  本插件实现在 `lib/client.js` 的 `sessionCwdOf()`（以 `sessionId` 为准，旧版本回退 `state.current`）。
- host 侧对路径做校验：必须在配置允许的根之下，且必须是 git 工作树（`git rev-parse --show-toplevel`）。

### E. 浏览器半区硬约束

- 运行时只能 import 平台模块表 9 项（`react` / `react/jsx-runtime` / `react-dom{,/client}` / `@deepseek-ai/cordis` / `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`），其余一律内联或不用。
- 产物必须是闭包工厂：`window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { var module={exports:{}}; var exports=module.exports; …; return module.exports } })`。
- 组件**收不到 ctx**：私有数据/回调走注册项 `inject` 工厂（在 apply 世界里闭包捕获 `ctx.connection`），共享视图状态走 `store` 或组件本地 state。

### F. IDEA 版本管理工具功能面（官方帮助核实）

| IDEA 位置 | 行为 | 本项目对应 |
|---|---|---|
| Version Control 工具窗（Alt+9） | 多视图：Console / Local Changes / Log / Shelf / Repository / Incoming | 面板内 Tab：Local Changes / Log / Console / Branches / Stash |
| Commit 工具窗（Alt+0，非模态） | 变更列表 + 提交消息 + 复选框选择 + Amend + Commit/Commit and Push | 与 Local Changes 合并成一个 tab（IDEA 2020.1+ 默认形态） |
| Local Changes 树 | 按 changelist 分组（Changes / Unversioned Files），目录分层，状态色：蓝=修改、绿=新增、灰=删除、红=冲突；右键 Add/Rollback/Show Diff/Ignore | v1 实现（简化目录树 + 右键菜单） |
| Diff Viewer | 双击文件看差异；可勾选 hunk/行级提交 | v1 统一 diff（只读着色）；v2 并排 + hunk 勾选 |
| Log | 所有分支提交表（Graph/Author/Date/Commit/Message），选中显示变更文件与详情；右键 Cherry-Pick / Revert / Undo Commit / Reset / Copy Revision Number | v1 提交表 + 文件列表 + Revert/Cherry-Pick/Copy/Reset |
| Git Branches 弹窗 | 本地/远程分支树，New Branch / Checkout / Merge / Delete / Fetch | v1 Branches tab 等价实现 |
| Console | 显示 VCS 命令执行结果 | v1 命令流水（含退出码/耗时/stdout+stderr） |
| Gutter 变更标记、Shelf、多 VCS root、3-way merge | 编辑器内标记、搁置、多仓库 | 不做/v2（DSH 无编辑器面板可挂 gutter） |

## 方案设计

### 形态
**单包，host 半区 + 浏览器半区**（路径 B）。理由：UI 必须在 Web GUI 的默认侧边栏与中栏出现（浏览器半区），git 执行必须在 host 进程（`ctx.subprocess`），两者靠 Connection RPC 通道连接。

### 包名与清单
- 包名（kebab-case，同时是 client bundle id 与 patch 行的 `name`）：**`dsh-git-vcs`**（待确认）
- 依赖锁版本：`@deepseek-ai/cordis ^4.0.2`、`@deepseek-ai/schemastery ^3.18.2`、`@deepseek-ai/dsh-tools ^0.1.5-rc.1`（仅当暴露模型工具）、类型侧 `@deepseek-ai/dsh-client-ui-slots ^0.1.5-rc.1`（npm 上确认存在 0.1.5-rc.1/rc.2）。
- `dsh.client.inject`：只写真正需要先到位的包（如 `@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-connection`）；注意该字段是**加载/预取元数据，不构成 apply 顺序**，槽位依赖一律用 `slots.inject()` 等待。

### host 半区
- 服务：插件内实现 `runGit(args, { cwd, signal })`（`ctx.subprocess.resolveExecutable('git')` → `spawn` argv → collect 输出 → 解析），对外只暴露一个 RPC 通道 `/git-vcs`。
- RPC 端点（全部返回 JSON；失败用 `{code,message,details}`，错误码前缀 `git-vcs/`）：

| 端点 | 作用 | 写操作 |
|---|---|---|
| `repo/info` | 仓库根、当前分支、HEAD、ahead/behind、remote、git 版本 | 否 |
| `status` | `git status --porcelain=v2 --branch -z` 解析：staged/changed/untracked/conflicted | 否 |
| `diff` | `git diff [--cached] -U<n> --no-color -- <path>` | 否 |
| `log` | `git log --date=iso --pretty=…`（limit/skip/branch/path） | 否 |
| `show` | 单提交元数据 + 变更文件 + patch | 否 |
| `branches` | 本地/远程分支 + upstream + ahead/behind | 否 |
| `stage` / `unstage` | `git add --` / `git restore --staged --` | 是 |
| `discard` | `git restore --`（丢弃工作区改动，UI 二次确认） | 是 |
| `commit` | `git commit -m … [--amend] [-- paths]` | 是 |
| `checkout` / `branchCreate` / `branchDelete` / `merge` | 分支操作 | 是 |
| `fetch` / `pull` / `push` | 远端同步（`push` 默认由配置关闭） | 是 |
| `stash` | `list/push/pop/apply/drop` | 是 |
| `revert` / `cherryPick` / `reset` | 危险操作，UI 二次确认 | 是 |

- `Config`（Schemastery，全部可只改 patch 行生效）：`gitPath`（默认空=从 PATH 解析）、`allowWrite`（默认 true）、`allowPush`（默认 **false**）、`allowDangerous`（reset/revert/cherry-pick/branchDelete，默认 true）、`maxOutputBytes`（默认 2 MiB）、`diffContextLines`（默认 3）、`autoRefreshSeconds`（默认 0=关）、`exposeModelTools`（默认 false）。
- 可选（待确认）：`exposeModelTools=true` 时注册 `git_status` / `git_diff` / `git_log` / `git_commit` 四个模型工具（`defineTool`），让 agent 也能驱动同一仓库。

### 浏览器半区（UI）
- 入口：侧边栏 `sidebar.panellist` 图标（分支图形），宽度收缩时只显示图标（`size` 由 owner 给）。
- 面板结构（自上而下）：
  1. **工具栏**：当前分支按钮（弹出分支树）、Refresh、Commit、Update Project（pull）、Push、Fetch、Show Diff、Rollback
  2. **Tab 条**：Local Changes / Log / Console / Branches / Stash
  3. **主体**：按 tab 渲染（变更树+提交区、提交历史、命令流水、分支树、Stash 列表）
  4. **底部状态栏**：仓库根路径、分支、ahead/behind、最后刷新时间
- 颜色沿用 IDEA 语义：修改=蓝、新增=绿、删除=灰、冲突=红（用主题 CSS 变量，写死前先查 `Theme.listTokens`）。
- 数据流：`apply(ctx)` 里建一个面板级 store（或组件内 state）→ 调用 `ctx.connection.rpc.call('/git-vcs', endpoint, payload)` → 渲染；写操作后自动 refresh status/log。

### 验证计划
1. `node <skill>\scripts\validate-plugin.mjs <dir>`（零 ERROR）
2. `node <skill>\scripts\smoke-boot.mjs <dir>`（隔离 DSH_HOME 成为一层 + 真启动，能抓到 `apply()` 加载期错误）
3. `dsh plugin --profile web add link:<绝对目录>` → `dsh --profile web --dump-config` 必须见到 `# == dsh-git-vcs`
4. 重启 `dsh web` → 刷新 http://127.0.0.1:3080 → 检查：Console 无报错、`window.__DSH_BOOT__` 出现该包、**侧边栏出现"版本管理"图标**、点击后中栏出现面板
5. 真机功能实测（就用本仓库 `D:\zxh\code\git-plugin`）：status/diff/log/branches 只读通过 → stage/commit 写操作通过（产生一次真实提交）

## 已知坑点/注意事项

1. 装了 bundle 就不要再手写 `insert`（会 `duplicate loader entry id`）。
2. 新面板/新工具只对**新建会话**生效；bundle 层改动必须重启 `dsh web`（刷新页面不够）。浏览器半区改动通常只需刷新页面。
3. patch 的 `config` 是整值替换，覆盖行需重述全部键。
4. `dsh.client.inject` 不是加载顺序保证；槽位必须 `slots.inject()`。
5. 本机 npm 默认缓存目录 `D:\zxh\deepseek\.npm-cache-tmp` **在沙箱外**（写入 EPERM）→ 本项目改用 `--cache D:\zxh\code\git-plugin\.npm-cache`，并已加入 .gitignore。
6. 组件拿不到 `ctx`；所有 host 调用必须在注册项 `inject` 工厂里闭包捕获。

## 技术决策记录

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-09-14 | ~~入口 = `sidebar.panellist`（list）+ `main`（keyed）同 id 双注册~~ **已被用户否决**：入口改为右侧栏 tab 类型（`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`），与官方「工作区文件」同机制 | 用户明确要求入口与面板都跟「工作区文件」一致；分栏/全屏/浮窗由 ui-sidebar-right + dockkit 提供。副作用：引导入口由 1 个变 2 个，右侧栏默认页从「工作区文件」变为引导页（用户已确认接受） |
| 2026-09-14 | host↔client 走 `ctx.connection.rpc.handle/call` 自定义通道，不用生成式 Remote | 免 Typert 代码生成管线；认证/信任由 Connection 统一处理 |
| 2026-09-14 | git 用 `ctx.subprocess` argv 形式（非 `ctx.shell`） | 无 shell 解释面、cwd/argv 精确可控、输出可 collect+spill |
| 2026-09-14 | Local Changes 与 Commit 合并为同一 tab | 对齐 IDEA 2020.1+ 默认的非模态提交界面 |
| 2026-09-14 | 右侧栏 tab 的注册照抄 `dsh-client-ui-sidebar-files` 的两阶段写法：`ctx.sidebarRightTabs.register({id, kind, title, guide})` + `slots.inject('sidebar.right.pane.tab', () => slots.register({name, key: id, inject}, Body))` | 该包是产品内唯一活着的同类实现，照抄即对齐官方契约（keyed slot 用 `key` 而非 `id`） |
| 2026-09-14 | 客户端只 `require('react')`，UI 全用 `React.createElement`、样式全内联；不用 CSS Modules、不写 `document.head` | 零构建路线下这是唯一不触碰构建链的写法；避开 purity 门禁与全局样式污染 |
| 2026-09-14 | 写操作分三级门禁：`allowWrite` / `allowDangerous`（reset·revert·cherry-pick·删分支·回滚文件）/ `allowPush`（默认 false） | push 与破坏性操作默认最保守；危险操作在 UI 内还要过一次内联确认条 |
| 2026-09-29 | 会话工作目录改走标准 prop `sessionId` + `useSessions` 选择器（0.1.7 起；旧版回退 `state.current`），`dsh.engines.dsh` 提到 `>=0.1.7-rc.2` | DSH 0.1.7 的 `SessionListState` 移除了 `current`，旧写法让面板永远停在「（未加载）」；两个探针夹具必须同步成真机 props 形态，否则"自检全绿、真机红" |

## 实现进展（2026-09-14）

已落盘（零构建，共 5 个源文件）：

| 文件 | 内容 |
|------|------|
| `package.json` | `dsh.bundle.patch` + `dsh.client`（platform web，inject 只写 `@deepseek-ai/dsh-client-ui-sidebar-right`）+ `dsh.engines.dsh >= 0.1.5-rc.1`，**无 dependencies** |
| `cordis.patch.yml` | `insert: id: git-vcs / name: dsh-git-vcs / config: {allowWrite, allowPush:false, allowDangerous}` |
| `index.js` | host 半区：`ensureWorkdir` 路径守卫 → `runGit`（argv，`GIT_COMMON` 关 quotepath/color，`GIT_ENV` 禁交互提示，`AbortSignal.timeout` 超时，collect + 命令环形缓冲）→ 21 个 RPC 端点 → `ctx.connection.rpc.handle('/git-vcs')` |
| `lib/client.js` | 浏览器半区闭包工厂：`GitGlyph` 图标 + `GitBody`（工具栏 / 5 个 tab / 差异视图 / 内联确认条 / 状态栏），`inject: ['slots','sidebarRightTabs','connection']` |
| `README.md` | 形态、安装（含跨盘符坑与三条修法）、使用、配置表、安全边界、v1 已知限制 |
| `scripts/verify-host.mjs` | 不挂 profile 的 host 半区自检（假 `ctx.subprocess` + 文件重定向抓输出，只读端点，不改仓库状态） |

已验证：

- `node --check index.js` / `node --check lib/client.js` 均通过。
- `validate-plugin.mjs`：**0 ERROR / 0 WARN**。
- `smoke-boot.mjs`（隔离 DSH_HOME）：**通过** —— 组合层出现 `# == dsh-git-vcs`，启动无报错，`apply()` 真的跑了并打印配置，证明**不导出 Schemastery `Config` 时 config 仍会透传**（payload 值来自 patch 行）。

**未完成 / 当前阻塞**：

- 真实 profile 安装失败：跨盘符 `link:` 生成坏 junction → dsh 判定 `declares no dsh.bundle`，插件未进 `dsh.profile.bundles`。修法已写进 README（手动 `mklink /J` + `dsh plugin --profile web install` 对账）。
- `~/.dsh/profiles/web` 写入需提权，本会话一次 `danger-full-access` 提权被用户拒绝 → 停止尝试，改由用户自行执行 README 里的命令。
- 真机 UI 未验证（需重启 `dsh web` 后刷新页面看侧边栏引导页胶囊与面板）。
- `scripts/verify-host.mjs` 已写好但**未运行**（用户要求先不急着验证）。

## 实现进展（2026-09-14 · 第二轮：动态验证 + 回灌源码）

先以动态 Cordis 插件（`gitvc-1`，`pkg-1`…`pkg-4`）在当前页面热加载同一套机制的移植版，验证右侧栏 tab 与
host git 通路，再按用户确认「全部同步」把结论回灌到本包源码：

| 变化 | 位置 | 说明 |
|------|------|------|
| `repo/snapshot` 聚合端点 | `index.js` | status / log / for-each-ref(本地+远程合并) / stash / 版本 / remote 六项 `Promise.all` 并发，一次往返；面板刷新与写操作后刷新都只用它 |
| 缓存 | `index.js` | git 可执行路径、仓库根（`rev-parse --show-toplevel`，按 cwd 缓存，`init` 回写）、`git --version`、`remote.origin.url` |
| `remote/list` 端点 | `index.js` | `git remote -v` 解析成 `{name, fetch, push}`，供 Remotes 页 |
| `show` 三段并发 | `index.js` | meta / name-status / patch 由串行改并发 |
| `parseStatus` 修 bug | `index.js` | porcelain v2 的 path 下标：`1 ` → 8、`2 ` → 9、`u ` → 10（原实现统一 9 → path 空串） |
| 详情默认隐藏 + 可关闭 | `lib/client.js` | 文件差异与提交详情都不常驻，点选才展开，右上角 `×` 关闭；再点同一行可收起 |
| Log 连线列 | `lib/client.js` | 首列表头留空，单轨竖线 + 节点（HEAD 实心，首行线只向下 / 末行只向上），行间无分割线；列宽用 `<colgroup>` + `table-layout:fixed` 对齐 |
| 按提交建分支 | `lib/client.js` | 提交详情内输入分支名 → `branch/create` + `startPoint`（只建不切换） |
| Remotes 页 | `lib/client.js` | 懒加载（切到该页才请求），展示每个远程的 fetch / push 地址 |
| tab 标题不裁 | `lib/client.js` | 注册 `sidebar.right.pane.tab.title`，`inline-flex` + `nowrap` + `min-width:78px` |
| 分阶段反馈 | `lib/client.js` | 顶部进度条 + 页脚阶段文案 + 分区占位（读取差异 / 读取提交详情 / 读取远程）+ 状态栏 `上次操作 N ms` |

验证：`node --check` 全过、`validate-plugin.mjs` 0 ERROR / 0 WARN、`smoke-boot.mjs` 通过、
`scripts/verify-host.mjs` **13 通过 / 0 失败**（新增 snapshot 与 remote/list 断言）。

