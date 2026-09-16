# dsh-git-vcs

DSH Web GUI 的 **Git 版本管理插件**：在右侧栏新增「版本管理」页，功能与界面参照 IntelliJ IDEA 的
Version Control 工具窗（`Alt+9`）与 Commit 工具窗（`Alt+0`）——本地变更与勾选提交、提交树与提交详情、
分支 / 远程 / 贮藏管理、git 命令流水。

## 版本与兼容性

| 项目 | 值 |
|------|-----|
| 插件版本 | **`0.1.0`**（`package.json` 的 `version`，已发布到 npm：[dsh-git-vcs](https://www.npmjs.com/package/dsh-git-vcs)） |
| 仓库 / Release | <https://github.com/TiChuXiXi/dsh-git-vcs>（tag `v0.1.0`） |
| npm 包名 / 插件行 id | `dsh-git-vcs` / `git-vcs` |
| 兼容的 DeepSeek Harness | **`@deepseek-ai/dsh` ≥ `0.1.5-rc.1`**（写在 `package.json` 的 `dsh.engines.dsh`；开发与验证版本就是 `0.1.5-rc.1`） |
| 依赖的官方插件 | `@deepseek-ai/dsh-client-ui-sidebar-right`（客户端半区 `dsh.client.inject` 声明；随 web-app 分发，本机为 `0.1.5-rc.2`） |
| 依赖的 host 服务 | `subprocess`（跑 git）、`connection`（RPC 信任栅栏）、`webServer`（注册 `/git-vcs` 路由） |
| 依赖的 client 能力 | `sidebarRightTabs`（注册 tab 类型）、`slots`（`sidebar.right.pane.tab` / `.title`） |
| git | 2.x；argv 调用（不进 shell），从 PATH 解析或由配置 `gitPath` 指定 |
| Node.js | ESM；本机验证 `v22.23.2` |
| 构建 | **零构建**：无编译步骤、无运行时依赖（host 半区不 import 任何 `@deepseek-ai/*` 值） |

> 最低版本取 `0.1.5-rc.1` 的原因：host 侧走「自己注册 `webServer` 前缀路由」这条通道，需要
> `webServer` 与 `connection` 两个服务同时可注入（细节见文末「RPC 通道是怎么挂的」）。更低版本未验证；
> 升级 DSH 后先跑一遍 `node scripts/verify-host.mjs`。

## 插件说明

### 提供什么

- **一个右侧栏 tab 类型**：`版本管理`（同时在右侧栏引导页注册一个胶囊入口，`order: 20`），
  内容全部由本插件渲染；**分栏、全屏、展开/收起**由官方 `@deepseek-ai/dsh-client-ui-sidebar-right`
  （右侧栏的停靠面与 header 展开控件）提供，本插件不碰布局。
- **一条 host RPC 通道** `/git-vcs`（29 个端点，见下表）：所有 git 调用都在 host 进程里以 argv 形式执行。
- **六页功能**：Local Changes / Log / Console / Branches / Remotes / Stash。
- **目录不是仓库时**：整页换成居中的空态 + 「在当前目录初始化 Git 仓库」按钮（`repo/init`）。

### 形态与文件

单包双半区、**零构建**（手写闭包工厂，无 tsdown、无运行时依赖）：

| 半区 | 文件 | 职责 |
|------|------|------|
| host | `index.js` | 用 `ctx.subprocess` 执行 git；自己注册 `webServer` 前缀路由 `/git-vcs` 暴露端点；写操作门禁；`repo/snapshot` 一次刷新一次往返 |
| 浏览器 | `lib/client.js` | 注册右侧栏 tab 类型 + 正文（`sidebar.right.pane.tab[.title]`）；IDEA 风格 React UI（`React.createElement`，无 JSX） |
| 组合层 | `cordis.patch.yml` | 插件行 `git-vcs`：`inject: [subprocess, connection, webServer]` + `config` |

### 作用范围

当前**会话的工作目录**（`session.cwd`），语义等同 IDEA 的「项目根」——换会话即换仓库；
也可以在面板顶部手填绝对路径后点「打开仓库」。配置 `repoRoot` 可把它限定在某个仓库根之下。

### RPC 端点

浏览器侧统一 `ctx.connection.rpc.call('/git-vcs', endpoint, payload)`；失败返回稳定错误码
（`git-vcs/bad-request`、`git-vcs/not-a-repo`、`git-vcs/write-disabled`、`git-vcs/auth-required`、
`git-vcs/network`、`git-vcs/timeout`、`git-vcs/git-failed` …）。

| 端点 | 作用 | 门禁 |
|------|------|------|
| `repo/info` | 仓库根、分支、upstream、ahead/behind、git 版本、`remote.origin.url`、插件配置回显 | — |
| `repo/snapshot` | 一次刷新所需的全部数据（status + log + 本地/远程分支 + stash + 版本 + remote），host 侧并发探测；`all: true` 时提交列表覆盖所有分支 | — |
| `repo/init` | 把目录初始化为 git 仓库（初始分支名可传 `branch`）；已是仓库根返回 `already: true`，仓库内子目录直接拒绝 | write |
| `status` | `git status --porcelain=v2` → 按「冲突 / 已暂存 / 已修改 / 未跟踪」分组 | — |
| `diff` | 单文件统一 diff；`staged` 取 index、`untracked` 走 `--no-index`、其余取工作区 | — |
| `log` | 提交列表（`limit` / `skip` 分页、`all` 覆盖所有分支、可按 `branch` / `path` 过滤） | — |
| `show` / `show/file` | 提交元数据 + 文件列表 / 单个文件的 diff（按需拉取） | — |
| `branches` | 本地 + 远程分支（hash、upstream、ahead/behind；过滤 `origin/HEAD` 符号引用） | — |
| `remote/list` | `git remote -v` | — |
| `remote/add` | 新增远程（可同时给出用户名/密码，加完即存凭据） | write |
| `stash` | `action: list / push / pop / apply / drop` | push/pop/apply/drop → write |
| `console/list` | git 命令流水（argv、退出码、耗时、stderr、是否截断） | — |
| `stage` / `unstage` | `git add` / `git restore --staged` | write |
| `commit` | `git commit`（可 amend）；带 `paths` 时先 `git add -- <paths>` 再按 pathspec 提交 | write |
| `checkout` / `branch/create` / `merge` | 切换或新建分支、合并 | write |
| `branch/delete` | 删除分支（`-d` / `-D`） | dangerous |
| `fetch` / `pull` | 抓取（`--prune`）/ `pull --no-edit`（Update Project） | write |
| `push` | 推送：直推 → SSL 后端兜底 → 认证兜底 | push |
| `credential/approve` | 把用户名/密码（Token）存进 git 凭据助手 | write |
| `discard` / `revert` / `reset` / `cherry-pick` / `remote/remove` | 丢弃改动、回滚提交、重置、拣选、删远程 | dangerous（`remote/remove` 为 write） |
| `init` | `git init`（host 已实现，面板暂无入口） | write |

## 安装

### 1. 从 npm 安装（推荐）

```powershell
$env:Path = "C:\Users\zdz20\AppData\Roaming\npm;" + $env:Path
dsh plugin --profile web add dsh-git-vcs
dsh --profile web --dump-config | Select-String "dsh-git-vcs"   # 必须看到 "# == dsh-git-vcs" 层
```

装具体版本用 `dsh plugin --profile web add dsh-git-vcs@0.1.0`（pnpm 对已存在的依赖会认为"已是最新"，
只有带 `@版本` 才替换 spec）。本机 registry 是 npmmirror，必要时加 `--registry=https://registry.npmjs.org`。

### 2. 本地路径安装（开发调试）

```powershell
dsh plugin --profile web add D:\zxh\code\git-plugin
```

### 3. 改完代码怎么生效

| 改了哪里 | 生效方式 |
|----------|----------|
| `index.js`（host）、`cordis.patch.yml` | **重启 `dsh web`**（bundle 层在进程启动时加载，刷新页面不够） |
| `lib/client.js`（浏览器） | 刷新页面即可 |

期望日志（启动时各一行，缺任意一行说明能力没挂上）：

```
[dsh-git-vcs] host 半区激活：subprocess=就绪 connection=就绪
[dsh-git-vcs] RPC 通道已注册：/git-vcs
```

### 4. 跨盘符安装坑（历史/本地开发才会遇到）

> 只有「本地路径安装」（第 2 种）且插件目录与 profile 不同盘符时才会踩到；从 npm 安装不受影响。

插件目录在 `D:`，profile 在 `C:\Users\zdz20\.dsh\profiles\web`。pnpm 对跨盘符的 `link:` / `file:`
算不出相对路径，会生成**目标被拼错的坏 junction**；于是 dsh 的 bundle 对账读不到
`node_modules/dsh-git-vcs/package.json`，判定 "declares no dsh.bundle"，插件只当普通依赖装、
**不进 `dsh.profile.bundles` 层**（现象：`dsh plugin add` 末尾提示 `declares no dsh.bundle`，
`--dump-config` 里没有自己的层）。

三条可行路线，任选其一：

1. **手动建正确 junction，再让 dsh 自己对账**（推荐，改动最小）
   ```powershell
   $p = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-git-vcs"
   cmd /c rmdir "$p"                                                     # 先删掉坏 junction（rmdir 只删链接）
   cmd /c mklink /J "$p" "D:\zxh\code\git-plugin"
   dsh plugin --profile web install                                       # 对账：自动把 dsh-git-vcs 追加进 bundles
   dsh --profile web --dump-config | Select-String "dsh-git-vcs"
   ```
2. **把插件挪到 C: 盘同一盘符**，再 `dsh plugin --profile web add <新路径>`（例如 `%USERPROFILE%\code\dsh-git-vcs`）。
3. **发布成 npm 包后按包名安装**（`dsh plugin --profile web add dsh-git-vcs`），走 registry 就没有跨盘符问题。

清理残留（若第一次安装已经把坏依赖写进 profile 的 `package.json`）：

```powershell
dsh plugin --profile web remove dsh-git-vcs
# remove 若也失败，手工删链接与依赖条目：
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-git-vcs"
# 然后编辑 ~\.dsh\profiles\web\package.json，去掉 dependencies.dsh-git-vcs，并确认 dsh.profile.bundles 里没有它
```

## 使用方法

右侧栏 tab 条的「+」或引导页胶囊 → **版本管理**。首次加入后右侧栏默认页会从「工作区文件」变为
引导页（官方规则：引导入口多于一个时打开引导页），页面上有两个胶囊：工作区文件 / 版本管理。

### 目录还不是 Git 仓库时

面板只渲染一块**居中空态**：Git 图标 + 「当前目录不是 Git 仓库」+ 目录路径 + 一个
**「在当前目录初始化 Git 仓库」**按钮，页签、工具栏、提交树等一律不显示（那些内容在非仓库下
全是空壳）。点按钮即在当前目录执行 `git init`，成功后空态自动消失、面板自己长回完整功能
（不必再点 Refresh）。初始分支名依次取：端点入参 → `git config init.defaultBranch` → `main`。

host 侧的语义边界（`repo/init`，受 `allowWrite` 门禁）：

| 目录状态 | 行为 |
|----------|------|
| 不是仓库 | `git init -b <branch>`；git < 2.28 无 `-b` 时退回 `git init` + `symbolic-ref HEAD` |
| 已经是仓库根 | 不重复初始化，返回 `already: true`（重复点击 / 竞态都安全） |
| 在别的仓库**内部**（子目录） | 拒绝并报 `git-vcs/bad-request`，避免凭空造出嵌套仓库 |

### 工具栏

| 控件 | 说明 |
|------|------|
| 仓库路径 + 「打开仓库」 | 默认取会话工作目录，也可手填绝对路径 |
| 分支胶囊 | 显示当前分支（detached 显示 `DETACHED`），点击跳到 Branches 页；右侧显示 `↑N ↓M`（相对 upstream 的领先/落后） |
| Refresh | 重新拉一次 `repo/snapshot` |
| Fetch | `git fetch --prune` |
| Update Project | `git pull --no-edit` |
| Push | 推送当前分支（仅 `allowPush=true` 时可用） |
| 凭据 | 随时配置当前 upstream 所属远程的用户名 / 密码（Token） |

### Local Changes

按「冲突 / 已暂存（Index）/ 已修改（Working Tree）/ 未跟踪文件」分组，行内状态字母
（蓝=修改、绿=新增、灰=删除、红=冲突）；**差异默认不显示**，点文件才在右侧展开，右上角 `×` 关闭。

> 两种「选择」在面板里是分开的、互不影响：
> **勾选框**决定本次提交包含哪些文件（提交走 `git add -- <勾选的文件>` +
> `git commit -m <信息> -- <勾选的文件>`：先暂存再按 pathspec 提交，**未跟踪文件也能直接勾选提交**，
> 且忽略索引里其它内容）；
> **「暂存 / 取消暂存」**是 `git add` / `git restore --staged`，把改动放进或移出**索引（Index）**，
> 供你在终端或别的工具里按标准 git 工作流使用。`MM` 状态的文件会同时出现在「已暂存」和「已修改」两个分组里。

- 差异按行所属分组取：已暂存组走 `diff --cached`、其余走工作区 `diff`；**未跟踪文件必须带 `untracked=true`**
  （未跟踪文件不在 index 里，普通 `git diff -- <path>` 恒为空，只有 host 的 `--no-index` 分支拿得到"新文件"差异）；
  命中 `.gitignore` 的文件不发请求，直接说明没有可展示的差异。
- 选中项会随快照校验：条目消失（文件被别处提交/回滚）即收起差异面板与底部操作条，
  条目只是换了分组（刚点了暂存）则跟随到新分组，避免右侧继续显示已经不存在的差异。
- 差异面板：**行号 gutter**、↑/↓ 在**改动块之间跳转**（当前改动的高亮只画在 gutter 上）、
  改动计数、长行**自动换行**（不出现横向滚动，红/绿底色保留）。

### 提交区

提交信息、Amend（`allowDangerous` 控制）、Commit，行内还有「全选 / 全不选」与「清空」。
每一行改动前面的**勾选框**（零构建下自己画的方块）只切换勾选、不打开右侧差异；
**只提交勾选的文件**，未跟踪文件同样可选。
没有可提交的改动、或一个文件都没勾时 **Commit 置灰**（悬停说明原因），不会"点了才报错"。
Amend 语义是修补上一次提交，**忽略勾选**（按钮文案里已注明）。

### Log

列顺序对齐 IDEA：**时间 · 提交树 · Message · Author · Commit**。

- **提交树列**：**多泳道图**，画法对齐 IDEA 与 `git log --graph`——每条分支一条自己的泳道，
  分叉/汇合画在**真正分叉的那次提交**上（基于历史提交拉出来的分支不会被画成当前分支的延续）。
  泳道算法：维护「每条泳道下一个期待的提交（= 上一条提交的父提交）」，
  没有泳道期待本提交就是分支起点（新开一条泳道），多条泳道同时期待本提交就在本行汇合；
  第一个父提交留在原泳道，合并提交的其余父提交各开一条斜线泳道。
  圆点用 **SVG 真圆**（外径 10px、圆环 2px），**HEAD 提交实心**、其余空心；
  泳道颜色按**分支名排序取模**分配（当前分支优先，跨渲染稳定），圆环用深色、连线用同色系**不透明**浅色
  （不透明才敢让上下两段各越界 1px 重叠消接缝，半透明会叠出更深的色带）。
  竖直段用 div 画（`calc(50% ± 半径)` 精确止于圆环外沿，圆点内部不画线），
  跨泳道的斜线画在一张铺满泳道区的 SVG 里（纵向 0–100 的百分比坐标 + `non-scaling-stroke`，
  行高随标签换行变化也不用重新测量）。
  节点右侧标出**所有指向该提交的分支标签**（同色系描边 + 淡底，本地实线 / 远程虚线，当前 HEAD 分支加粗，
  `origin/HEAD` 符号引用跳过），一眼看出每个分支停在哪次提交；标签区**统一对齐**在泳道区右侧（不跟着泳道左右跳）。
  该列宽度按泳道数与标签内容**自适应**（64–420px）且**不可拖动**。
- **行交互**：鼠标移到任意提交行即高亮（零构建下没有 CSS `:hover`，用状态模拟），光标为 `pointer`，点击展开该提交详情。
- **右键菜单**（屏蔽浏览器原生菜单）：按功能分组并带分组标题与分隔线，支持多级子菜单
  （父项 hover 或点击展开，按可用宽度自动向左翻转；点菜单外 / `Esc` 关闭）：
  - **查看**：展开提交详情
  - **复制**：复制完整 ID / 短 ID / 提交信息 / 作者与邮箱
  - **分支** ▸：基于此提交新建分支（自动展开详情并聚焦分支名输入框）、检出此提交（分离 HEAD）、
    把此提交合并到当前分支
  - **修改历史（危险）** ▸：拣选（Cherry-Pick）、回滚（Revert）、重置到此提交 ▸（Soft / Mixed / Hard，Hard 走二次确认）
  - 受 `allowWrite` / `allowDangerous` 门禁的项自动置灰禁用。
- **Commit 列**：显示短哈希，**直接点击短哈希即复制完整提交 ID**（无独立按钮）。
  复制结果走**右下角浮动提示条**（绝对定位、不参与流式布局，出现/消失不会顶动高度造成抖动；2 秒后自动消失，
  失败为红底）；提交详情里的完整哈希同样可点。
- **列宽**：时间 / Message / Author / Commit 四列表头右侧有拖动手柄（`col-resize`，pointer capture，
  不依赖 window 监听），拖动范围各自钳制（92–360 / 120–900 / 60–280 / 64–220px）；
  Message 列默认吃掉剩余宽度，被拖动后改为固定宽度，总宽超出面板即横向滚动。
- **范围与懒加载**：列表覆盖**所有分支**（本地 + 远程）的节点，不只是当前分支——host 侧走
  `git log --exclude=refs/stash --all`，stash 的提交被挡在外面（它有独立页签）。
  一页 **50 条**，**滚动到底自动续拉**下一页（`--skip` 接着上一页的窗口取，按 hash 去重），
  最多渲染 **2000 行**；刷新（含自动刷新）按「已加载条数」一次拉回，滚到深处不会因为刷新弹回第一页。
  列表底部的续拉提示行**本身可点**（面板很高、50 行撑不出滚动条时的那条入口）。
  刻意**不用** `--date-order` / `--topo-order`：这两种排序要先把整段可达历史读进内存排序，
  大仓库上首屏会明显变慢，而默认的反向时间序是流式的——它才是「按需加载」成立的前提。

### 提交详情

**默认不显示**，点条目才展开；面板在 **Log 下方**（上下布局），顶边有拖拽条可改高度
（默认 300px，上拖变高，钳制 140–720px 且不超过容器 80%），右上角 `×` 关闭。

详情内含 Revert / Cherry-Pick / Reset --soft / Reset --hard、**「新分支名」→ 基于该提交建分支（不切换）**，
以及变更文件列表——**默认不展示任何文件的差异**，文件行有 hover 高亮、光标 `pointer`，
**点某个文件才按需拉取该文件的 diff**（`show/file` 端点），再点一次收起。
点提交时只取元数据与文件列表（`show` + `noPatch`），不再一次性传输整次提交的 patch；
文件差异区同样有行号 gutter、↑/↓ 改动块跳转与改动计数。

### Branches

本地 / 远程分支。当前分支用首列 `*` + 绿色加粗分支名标识（**不做"选中"背景高亮**——这里没有选中态），
行只在 hover 时变色、光标为默认箭头（操作都在行内按钮上，行本身不可点）。

远程分支列表会**过滤符号引用**——`refs/remotes/origin/HEAD` 的 `%(refname:short)` 会退化成 `origin`，
不过滤就会和真正的 `origin/main` 一起显示成两条。

每行操作：本地分支 **推送**（有 upstream 时 `git push <remote> <branch>`；没有 upstream 时按钮变成
「推送并设 upstream」，走 `git push --set-upstream <remote> <branch>`，`remote` 取自该分支的 upstream，
缺省 `origin`）、切换、合并、删除；顶部还有「新建并切换」。推送与工具栏 Push 同一道门禁（`allowPush`）。

### Remotes

`git remote -v` 的全部远程与 fetch / push 地址；顶部表单可填**名字 + URL（+ 可选 push URL）→ Add Remote**，
并且可顺手填**用户名 / 密码·Token（可选）**——填了会在加好远程之后一并存进凭据助手
（保存失败只警告，不影响远程已经加好的事实）。每个远程行有 **Remove** 危险按钮（点击走内联二次确认）。

### Stash（贮藏）

`git stash` 的入口 —— 把当前未提交的改动**整体收起来**、工作区回到干净状态，之后用
「应用（`apply`，保留记录）/ 弹出（`pop`，取回并删除记录）/ 删除（`drop`）」处理；
与 Local Changes 里的「暂存」不是一回事（那是 `git add` 放进索引）。

- 当前实现用 `git stash push [-m 说明]`，**不带 `-u`**：未跟踪的新文件不会被收走，会留在工作区。
- 列表里的引用是 **`stash@{n}` 数字选择器**（由列表下标合成，与 git 编号一致）——不能用 `%gd` 配
  `--date=iso-strict`，那会生成 `stash@{2026-09-15T…}` 时间戳选择器，而 git 对它会打印 `Dropped …`、
  退出码 0，**却什么也不删**；host 现在还会核对操作前后的贮藏条数，把这种静默失败变成明确错误。

### Console

面板发起的每条 git 命令（argv、退出码、耗时、stderr、是否截断）。

### 反馈与状态

- 所有提示（写操作结果、复制反馈、**失败与 git 报错**）统一走右下角**浮动 toast**（绝对定位、不参与流式布局），
  没有顶部错误横幅；失败的完整命令与 stderr 可在 Console 页回看。
- **底部状态栏只在忙碌时出现**，显示当前阶段（读取仓库 / 暂存中 / 提交中 / 刷新列表…）。
- 所有等待都有文案：顶部 2px 进度条 + 阶段文案 + 分区占位（读取差异… / 读取提交详情… / 读取远程仓库…）。

### 性能约定（改动前先读）

面板流畅度取决于「客户端→宿主往返次数」与「git 进程创建次数」，两者在 Windows 上都是几十到上百毫秒级：

- **一次刷新只发一次 RPC**：`repo/snapshot` 在 host 侧把 status / log / for-each-ref(本地+远程合并) /
  stash / 版本 / remote 六项并发探测后一次返回（含 Console 流水）。旧实现要 6 次往返、约 16 次串行进程创建，
  单次刷新 1.5–2.5s；现在是 1 次往返、6 次同波进程。
- **缓存**：`git` 可执行文件路径（`resolveExecutable`）、仓库根（`rev-parse --show-toplevel`，按路径）、
  `git --version`、`remote.origin.url` 各只取一次；`init` 会写回仓库根缓存。

## 推送与认证

推送不是"配好就一直能推"或"永远推不了"，而是按下面这条链路逐级处理：

1. **直接推**：仓库已配好 remote 就直接 `git push`（当前分支到它的 upstream），或按分支行推指定的
   `git push <remote> <branch>`。
2. **SSL 后端兜底**：若失败原因是 `schannel` 拿不到凭据上下文（`SEC_E_NO_CREDENTIALS` 一类），
   自动换 `-c http.sslBackend=openssl` **重试一次**（第一次失败不会改动远端，重试是安全的），
   成功后 Console 里能看到这一次用了 openssl。也可用请求参数 `sslBackend` 固定后端。
3. **缺认证信息**：失败被归类为 `git-vcs/auth-required` 时，面板弹出**认证表单**
   （分支页顶部一行：用户名 + 密码/Token + 「保存并推送」）。提交走 `credential/approve`：
   - 用 `git credential approve` 把凭据交给**你机器上的凭据助手**保存（`store` → `~/.git-credentials`，
     或 `manager` → Windows 凭据管理器），**存成主机级**（`https://user:token@github.com`），
     所以同一主机下的仓库以后都不用再填；保存后用 `git credential fill` 回读校验，
     因为 `approve` 即使没人接收也返回 0；
   - 密码只走 **stdin**，不进 argv；凭据类命令在 Console 流水里 argv 会脱敏、输出显示为"已隐藏"；
   - 若助手不可用（例如受限环境里 msys `sh` 起不来），结果里 `stored: false`，此时凭据记在**本进程内存**中，
     本次会话内的推送会用内嵌 URL 的兜底方式完成（同样脱敏）。
4. **其余失败**：网络不通、被拒（`push-rejected`）、无权限等**原样报错**（右下角 toast + Console 页可回看原文），
   插件不猜、不重试。

**添加远程时就能认证**：Remotes 页的 Add Remote 多了可选的「用户名 / 密码·Token」，
对齐 IDEA「添加新远程时进行认证，认证通过就全局存起来」，避免"先加远程、再推一次、失败了才填账号"。

**SSH 远程不做认证**：`git@host:owner/repo.git` 走密钥/agent，插件不参与；失败按第 4 条报错。

> `allowPush` 默认就是 `true`（与 IDEA 一致：配好 remote 就能直接推）。不想让插件碰远端时，
> 在 `cordis.patch.yml` 里置 `false`，Push / 推送按钮会置灰并说明原因。
> 沙箱环境里凭据助手可能起不来（`sh.exe: couldn't create signal pipe`），此时第 3 条的会话内存兜底就是主要通路。

## 配置

插件行的 `config`（见 `cordis.patch.yml`，改后触发热替换）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `allowWrite` | `true` | 关闭后所有写操作（暂存/提交/分支/贮藏…）直接报 `git-vcs/write-disabled` |
| `allowPush` | `true` | 是否允许 push；置 `false` 时按钮禁用并提示 |
| `allowDangerous` | `true` | 是否允许 reset / revert / cherry-pick / 删分支 / 回滚文件 |
| `gitPath` | `''` | git 可执行文件绝对路径，空 = 从 PATH 解析 |
| `repoRoot` | `''` | 限定可操作的仓库根；空 = 允许任意会话工作目录 |
| `diffContextLines` | `3` | 统一 diff 上下文行数（钳制 0–200） |
| `maxOutputBytes` | `2097152` | 单条命令输出内存上限（超出保留尾部并标记截断，钳制 4096–64MiB） |
| `timeoutMs` | `120000` | 单条命令超时（钳制 1s–30min） |
| `autoRefreshSeconds` | `0` | 面板自动刷新间隔，0 = 关闭（钳制 0–3600） |
| `consoleLimit` | `200` | 命令流水保留条数（钳制 10–2000） |

> 本插件刻意**零运行时依赖**：host 半区不 import 任何 `@deepseek-ai/*` 值，`subprocess` / `connection` / `webServer`
> 都通过 `inject` 声明 + `ctx.get()` 读取；因此配置没有走 Schemastery `Config` schema，
> 而是在代码内 `normalizeConfig()` 合并默认值并做范围钳制（未知键忽略、类型不符即用默认值）。

## 安全边界

- git 一律以 **argv 形式**执行（`ctx.subprocess.spawn`，不经 shell），路径统一放在 `--` 之后，无注入面。
- `cwd` 必须是绝对路径、存在且是目录；默认还要求它是 git 工作树（`rev-parse --show-toplevel`）；
  配置 `repoRoot` 后限定在其之下。
- 执行环境禁用交互提示（`GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=echo` / `SSH_ASKPASS=echo`），
  避免凭据提示挂起。
- 破坏性操作在 UI 内需二次确认（内联确认条），并有 `allowWrite` / `allowDangerous` / `allowPush` 三级开关。
- RPC 路由自带信任栅栏：复用 `ctx.connection.requestRejection(req)`（Host/Origin 校验 + 浏览器会话认证），
  未通过返回 401 / 403。

## 已知限制（v1）

- 提交树是多泳道图（每条分支一条泳道、分叉/汇合画在真正的分叉提交上），但：
  tag 暂不画标签芯片，因此「只被 tag 指向」的提交会以无标签节点出现；
  续拉出更多提交后如果又冒出别的分支，泳道区会变宽（整表重排一次列宽），已显示行的泳道位置不变。
  单次刷新最多渲染 2000 行（更早的历史靠滚到底续拉，超过上限后停止续拉）。
- 差异视图是统一 diff 文本，没有并排 diff、没有按 hunk/行勾选提交（Partial Commit）。
- `git stash push` 不带 `-u`，未跟踪文件不会被收走（面板暂无开关）。
- Remotes 页增删远程后不会自动 fetch：track 关系已写进 `.git/config`，是否抓取由用户在工具栏点 Fetch。
- 没有 changelist 分组、没有 Shelf、没有多 VCS root、没有编辑器 gutter 标记（DSH 无编辑器面板可挂）。
- 没有文件系统监听：自动刷新依赖 `autoRefreshSeconds` 或手动刷新。
- 状态只在内存：刷新页面即重置（与官方右侧栏一致）。
- 初始化只做 `git init`，不会顺带建 `.gitignore` / `README` / 首次提交（IDEA 会问是否加这些）。
- 空态下如果 `allowWrite=false`，按钮置灰并提示原因（初始化属于写操作）。

## 自检与排障

| 脚本 | 用途 |
|------|------|
| `node scripts\verify-host.mjs [仓库]` | 不需要挂 profile，直接在宿主域内跑全部 host 端点（真实 git、临时仓库）。覆盖解析结果、错误码门禁、`allowPush` 门禁、相对路径/非仓库拒绝、未跟踪文件 diff、勾选提交的 pathspec 回归、提交树覆盖所有分支 + `skip` 分页不串页、`repo/init` 全部分支（建仓库 / 幂等 / 指定分支 / 非法分支名 / 嵌套拒绝 / 未出生分支 oid 归一 / `allowWrite` 门禁）等 **63 条断言** |
| `node scripts\render-probe.mjs` | 浏览器半区的离线自检：本机没装 react，脚本自带一个迷你 React 把面板真挂起来，跑「打开仓库 → 切 Log → 滚到底续拉 → 刷新」，断言提交树渲染出其它分支独有的提交、**泳道拓扑**（tip 上方不画线、分支各有泳道、斜线画在真正的分叉提交上）、续拉按 hash 去重、刷新不缩回一页（**14 条断言**，视觉部分仍需真机目测） |
| `node scripts\render-probe.mjs --real [仓库]` | 追加**与参考实现对照**的检查：把**真实仓库**的提交喂给同一份客户端代码渲染，再与 `git log --graph` 逐提交比对泳道下标与分叉行位置（两边用同一批提交、同一顺序），不一致就报出来 |
| `node scripts\dom-probe.mjs` | 浏览器半区的**真机几何自检**：起 headless Chrome/Edge 渲染真实 `lib/client.js`（夹具数据），通过 CDP 取回**渲染后的像素几何**，断言泳道竖线与圆点同心、斜线只占行高的 32%（分叉）/ 从 68% 到行底（合并）、斜线层高度等于行高，并单独加载一份「非仓库」快照断言**空态**行为：功能内容一条都不渲染、空态块铺满且按钮居中、点击后真的调了一次 `repo/init` 且功能面板自己长回来（**15 条断言**）。先 `npm install --prefix .npm-cache/domprobe react@18.3.1 react-dom@18.3.1`；缺浏览器/React 会自动跳过。**沙箱禁止命名管道**（Chrome 的 mojo IPC 会直接 FATAL），需放宽权限或沙箱外运行 |
| `node scripts\preview-check.mjs` | 在 `node:vm` 沙箱里装载真实 host 半区，按 host-runner 的 cloneJson 规则校验每个端点的信封是否无损 JSON，并确认 RPC 通道注册成功 |
| `node scripts\status-probe.mjs [仓库]` | 用插件自己的 `status` / `diff` 读当前工作区，逐条打印 index/worktree 标记与三种 diff 长度——排查「列表说改了、差异却是空」 |
| `node scripts\web-rpc-probe.mjs` | 在**隔离的 DSH_HOME** 里用完整 web 组合（base + web-app + 本插件）起临时实例（端口 3199），抓 host 日志并对 `/git-vcs` 做免认证探测：**401 = 路由在**（与 `/api` 一致）、**405 = 路由不在**（被静态兜底接手） |

浏览器半区的**布局/视觉**由 `scripts\dom-probe.mjs` 用 headless 浏览器量像素来守（泳道几何、圆点同心、斜线跨度）；
配色与列宽拖拽的手感仍需真机目测。**数据流转**由 `scripts\render-probe.mjs` 覆盖。

**面板请求全部失败，报 `HTTP 405`**：说明 `/git-vcs` 路由没挂上——查启动日志里有没有
`subprocess=就绪 connection=就绪` 与 `RPC 通道已注册：/git-vcs`。缺失的原因是插件行的 `inject`
没声明全（少了 `webServer` 会直接抛 `cannot get property "webServer" without inject`，整棵树加载失败），
或用 `inject: []` + 一次性 `ctx.get()` 在服务就绪前就激活了。可直接用 `scripts/web-rpc-probe.mjs` 复现。

## 卸载

```powershell
dsh plugin --profile web remove dsh-git-vcs
```

## RPC 通道是怎么挂的（维护者向）

浏览器侧用 `ctx.connection.rpc.call('/git-vcs', endpoint, payload)`；host 侧**自己注册**一条
`webServer` 的 prefix 路由 `/git-vcs`，线格式与 Connection RPC 一致
（请求 `{type:"client-request",rpcId,method,payload}` → 响应 `{type:"server-response",rpcId,result}`），
并复用 `ctx.connection.requestRejection(req)` 做信任栅栏（Host/Origin + 浏览器会话认证）。

不用官方那两个入口的原因（`@deepseek-ai/dsh` 0.1.5-rc.1 实测）：

- `connection.rpc.handle(channel, handler)`：它把路由注册到 **connection 服务自己 ctx** 的 `webServer` 上，
  而 web-app 的 `connection` 行只 `inject: [webRuntime]`，任何第三方调用都会
  `cannot get property "webServer" without inject`，**整棵插件树加载失败**。
- `connection.rpc.intercept('/api', …)`：官方推荐的共享通道，但是**单占位**——
  api-gateway 已经占了，再注册会抛 `already has an interceptor`。

host 行的 `inject` 必须是真实存在的三个服务：`subprocess`（跑 git）、`connection`（信任栅栏）、
`webServer`（注册路由），模块级 `export const inject` 与插件行级 `inject` 都要写
（行级 inject 管模块级管不到的那一层）。早期用 `inject: []` + 一次性 `ctx.get()` 会在提供方就绪前激活，
日志表现为 `host 半区激活：subprocess=缺席 connection=缺席` → 通道没挂上 → 浏览器侧 405。

开发期曾用动态 Cordis 插件（`gitvcs-3`）做真机预览，但它依赖 `harness.handle` / `host.call`，
与正式版的 `webServer` 通道不是同一条路，已由本地链接安装取代。
