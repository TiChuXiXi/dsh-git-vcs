# 任务注册索引

> Agent 新会话第一件事：读本文件，通过"当前任务ID"快速定位到对应任务文件夹，只加载该任务的 context.md 和 progress.md。
> 不要遍历所有任务文件夹。不要读本文件以外的记忆。

## 任务索引

| 任务ID | 模块 | 状态 | 关联分支 | 最后更新 | 上下文入口 |
|--------|------|------|---------|---------|-----------|
| task-002 | DSH 最新版兼容与 Git 功能回归 | develop 已合入 main；v0.2.0 GitHub Release 已发布（`13a06d5`）；npm 发布被 2FA 策略拒绝，等待用户处理授权 | main / develop | 2026-10-12 | `.opencode/tasks/task-002/context.md` |
| task-001 | Git 版本管理插件（右侧栏 tab + host RPC + IDEA 式 UI） | **已发布 `dsh-git-vcs@0.1.2`**（npm `latest` + GitHub Release + tag `v0.1.2` = `51ebac6`；本机 `~/.dsh/profiles/web` 已从 `link:` 切到 registry 版，重启 `dsh web` 生效）。0.1.2 内容：**适配 DSH 0.1.7** —— 客户端会话 cwd 改走 session 作用域标准 prop `sessionId`，修掉面板一直显示「（未加载）」；`dsh.engines.dsh` 提到 `>=0.1.7-rc.2`；两个探针夹具同步 0.1.7 真机 props 形态 + 反向对照 12 条红；新增诊断用 `scripts/live-probe.mjs`。用户真机确认：面板正常加载、能打开目录所在 git 仓库。此前：[**已发布 `dsh-git-vcs@0.1.1`**（npm `latest` + GitHub Release + tag `v0.1.1`，仓库 `main` = `c7e5ca0`）。**已提交 main、未发版的本地改动（2026-09-20）**：`17ccf20` 提交树三处真机问题（①合并的非第一父提交改为**并入已有泳道**，消除"向右突出又折返的假尖角"与"全程无节点的悬浮泳道"，certbase-offline 355 提交实测旧 4 泳道/6 尖角 → 新 3 泳道/0 尖角；②提交树列**标签限长** 96px + 一行最多 3 个 + `+N`、列宽上限 240px 且**可拖/双击恢复自适应**；③提交详情新增「分支 · N」一行）→ `8777fe4` 探针与 `graph-sim.mjs` → `a52c64c` 记忆归档 → `34e3351` **线端统一到「圆心 ±4px」**（斜线改画在两张 px 精确横带里）→ `592cacf` **合并的岔出斜线跨行画到目标节点**（同一个节点上的汇入线落在同一点；用户截图 fc39963/b41e6ab 那两行实测三条线都收在 2620.8）。自检：dom-probe **33/33** + `--repo` **38/38**、render-probe **15/15** + `--real` **18/18**、verify-host **64/64**、preview-check 全过；反向对照旧版分别 12 条 / 5 条 / 2 条全红。另：awesome PR #5154 等 09-16 12:19 UTC 的 regate 重跑 | main | 2026-09-29 | `.opencode/tasks/task-001/context.md` |

## 快速查找规则

1. **用户提到模块名** → 查"模块"列定位任务
2. **用户提到分支名** → 查"关联分支"列定位任务
3. **用户描述新需求** → 先从本索引判断是否属于已有任务范围，是→进入对应文件夹，否→创建新任务

## 模块 → 任务映射

> 项目为空目录，以下为**规划模块**（骨架生成后按实际产出修正目录路径）。仓库已初始化（分支 `main`），尚无特性分支，故"已有分支"为空。

| 业务模块 | 源码目录 | 已有分支 |
|---------|---------|---------|
| 插件包清单（package.json / cordis.patch.yml） | `./` | - |
| host 半区入口与工具注册 | `index.js` | - |
| 插件配置 schema | `index.js`（Schemastery Config） | - |
| 浏览器半区 UI（可选） | `lib/client.js` | - |

