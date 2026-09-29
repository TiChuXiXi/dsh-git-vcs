# 项目级长期记忆

> 跨任务的通用决策、已知问题、技术债务。每次打开任何任务前可选读取。
> 保持精简，详细内容引导到对应任务文件夹或 CONTEXT.md。

## 项目架构要点

- **项目性质**：DSH（DeepSeek Harness）cordis 插件包，用于 git 仓库管理。当前目录 `D:\zxh\code\git-plugin`。
- **形态**：单包（bundle）。host 半区必选；浏览器半区（Web GUI）可选，加在同一包内。
- **清单**：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`；Web 半区另加 `dsh.client` + `exports["./client"]`。**不声明 `dsh.profile`**。
- **入口**：`index.js` 导出 `name` / `inject` / `apply(ctx, config)`；副作用只写在 `apply()` 内。
- **依赖锁版本**：`@deepseek-ai/dsh-*` → `^0.1.5-rc.1`、`@deepseek-ai/cordis` → `^4.0.2`、`@deepseek-ai/schemastery` → `^3.18.2`；禁止 `latest` / `*`。
- **当前状态**（2026-09-29）：插件已发布 **`dsh-git-vcs@0.1.2`**（npm `latest` + GitHub Release + tag `v0.1.2` = `51ebac6`）；
  本机 `~/.dsh/profiles/web` 的依赖已从 `link:D:/zxh/code/git-plugin` 切到 registry 版 `0.1.2`（重启 `dsh web` 生效）；
  要回到本地调试：`dsh plugin --profile web add link:D:/zxh/code/git-plugin`。远端 = `https://github.com/TiChuXiXi/dsh-git-vcs.git`（分支 `main`，已 push）。

## 跨任务技术决策

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-09-14 | 记忆体系采用 DSH 原生加载：只建 AGENTS.md / CONTEXT.md / LESSONS.md / .opencode 记忆区，**不建** `.opencode/opencode.json` | 会话运行在 DSH，AGENTS.md 自动注入；CONTEXT.md 与 LESSONS.md 由 AGENTS.md 的"会话启动必读"协议保证加载 |
| 2026-09-14 | `/save` 指令不下沉到项目，复用全局 `~/.dsh/commands/save.md` | 全局版本已含"步骤 0 纠错检视"，闭环完整，避免重复定义 |
| 2026-09-14 | `dsh-git-vcs` 入口采用**右侧栏 tab 类型**（`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`），与官方「工作区文件」同机制；不用左侧栏 `sidebar.panellist` + `main` 全局面板 | 用户要求入口/面板与「工作区文件」完全一致；分栏、全屏、拖出浮窗由 ui-sidebar-right + dockkit 免费提供 |
| 2026-09-14 | host↔client 走 `ctx.connection.rpc.handle('/git-vcs')` / `rpc.call`，不用生成式 Remote，也不自建 HTTP 路由 | 免 Typert 代码生成；认证与 Host/Origin 校验由 Connection 统一负责 |
| 2026-09-14 | git 用 `ctx.subprocess.spawn` 的 argv 形式（非 `ctx.shell`），路径统一置于 `--` 之后 | 无 shell 解释面；cwd/argv 精确可控；输出可 collect + spill |
| 2026-09-14 | host 半区**零运行时依赖**：不 import 任何 `@deepseek-ai/*` 值，`subprocess`/`connection` 用 `ctx.get()` 软依赖，配置不走 Schemastery `Config` | profile 侧免装依赖、隔离冒烟环境也能激活（实测 dsh-base 冒烟组合里两者都缺席）；代价是配置校验在 `normalizeConfig()` 里手写 |

## 已知全局问题

- **registry 默认 npmmirror** → 安装 `@deepseek-ai/*` 官方包、发布插件都必须加 `--registry https://registry.npmjs.org`（npmmirror 会滞后，直查具体版本端点比 `npm view` 更快看到新版本）。
- **pnpm 不在 PATH** → 先 `$env:Path = "C:\Users\zdz20\AppData\Roaming\npm;" + $env:Path`，可执行文件为 `C:\Users\zdz20\AppData\Roaming\npm\pnpm.cmd`。
- **profile 目录在 workspace 外**（`~/.dsh/profiles/<name>`）→ `dsh plugin` 写入可能被沙箱拒绝，原样重试并带 `sandbox_permissions: danger-full-access` + justification。
- **codebase-memory-mcp 已安装连通，但本项目未建索引** → 首次语义检索前需对本目录执行 `index_repository`。
- **npm 默认缓存目录 `D:\zxh\deepseek\.npm-cache-tmp` 在沙箱外**（写入 EPERM）→ npm 命令改用 `--cache D:\zxh\code\git-plugin\.npm-cache`（已 gitignore）。
- **跨盘符 `dsh plugin add` 会生成坏 junction**：插件在 `D:`、profile 在 `C:\Users\zdz20\.dsh\profiles\web`，pnpm 无法算相对路径 → 链接目标被拼成 `<profile>\D:\...`，dsh 判定 `declares no dsh.bundle`，插件不进 `dsh.profile.bundles`。修法：删链接后 `cmd /c mklink /J <profile>\node_modules\<pkg> <插件绝对路径>`，再 `dsh plugin --profile web install` 对账（详见 README「跨盘符安装坑」）。
- **写 `~/.dsh/profiles/**` 需要提权**：本会话沙箱为 workspace-write，`dsh plugin add` 首次 EPERM；一次 danger-full-access 提权被用户拒绝后不再重试，改为把命令写进 README 由用户自行执行。
- **沙箱内 git 网络操作的两个坑**（本机已实测）：①`http.sslBackend=schannel` 会 `SEC_E_NO_CREDENTIALS`，改用 `-c http.sslBackend=openssl`；②凭据助手（`credential-manager` / `store`）经 msys `sh -c` 启动，而沙箱下 `sh.exe` 建不了信号管道 → 助手与交互输入都不可用，必须绕开助手（push 到内嵌凭据的 URL）或提权执行。
- **远端仓库**：`origin` = `https://github.com/TiChuXiXi/dsh-git-vcs.git`（分支 `main`，已发布 `0.1.0` / `0.1.1` / `0.1.2`）。push 必须带 `-c http.sslBackend=openssl` + 代理（`-c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890`）+ 内嵌凭据 URL，**推完补一次 `git fetch origin`**（按 URL 推不会更新本地 remote refs，否则会误判"没推上去"）。

## 常用命令

```powershell
# 技能与脚手架（技能目录）
# C:\Users\zdz20\.dsh\skills\dsh-plugin-creator
node C:\Users\zdz20\.dsh\skills\dsh-plugin-creator\scripts\new-plugin.mjs <pkg> --kind host|tool|web-ui --dir <out>
node C:\Users\zdz20\.dsh\skills\dsh-plugin-creator\scripts\validate-plugin.mjs <dir>   # 静态校验，须零 ERROR
node C:\Users\zdz20\.dsh\skills\dsh-plugin-creator\scripts\smoke-boot.mjs <dir>        # 隔离 DSH_HOME 冒烟启动

# 挂载与验证（真实 profile：web）
$env:Path = "C:\Users\zdz20\AppData\Roaming\npm;" + $env:Path
dsh plugin --profile web add <绝对目录>
dsh --profile web --dump-config | Select-String "<包名>"     # 须出现 "# == <包名>" 层
# 改 bundle 行后必须重启 dsh web（页面刷新不够）；新工具只对新建会话生效

# 构建（仅 Web 半区需要）
pnpm install; pnpm build    # 产物 lib/client.js
```
