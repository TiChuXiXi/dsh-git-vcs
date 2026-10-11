# DSH 最新版适配与功能检查（2026-10-12）

## 基线

- 官方仓库：[`deepseek-ai/deepseek-harness` 的 `d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)，提交日期 2026-10-09。
- CLI、web-app、connection、subprocess、侧栏包版本：`0.2.1-alpha.2`，从 npm 固定版本安装到独立测试目录。
- 查询时 npm `latest` 为 `0.2.0-rc.2`；用户指定官方仓库最新版，因此选择 `alpha` 的上述版本。
- 插件原始提交：`73ccca3`；更新版本 `0.2.0`；目标分支 `develop`。
- 环境：macOS、Node `24.18.0`、真实 Git、本机无头 Chrome。

## 接口核对与实机结论

| 接口 | 最新源码依据 | 结论 |
|---|---|---|
| 侧栏注册 | `packages/client/ui-sidebar-files/src/client/index.ts`、`definition.tsx` | `sidebarRightTabs.register` 与两个 keyed slot 保持兼容 |
| 会话目录 | `packages/client/ui-sidebar-files/src/client/FilesBody.tsx` | 保持 `sessionId` + `useSessions(s => s.byId[sessionId]?.cwd)` |
| 子进程 | `packages/subprocess/subprocess/src/index.ts`、`types.ts` | `resolveExecutable`、`spawn`、`done`、`collected.readFrom` 保持兼容 |
| RPC | `packages/client/connection/src/rpc-host.ts` | 官方注册代码声明 caller ownership，但完整 profile 实测 `rpc.handle` 仍触发 `cannot get property webServer without inject`；保留插件自己的前缀路由及官方 `requestRejection` 信任栅栏 |
| 客户端资源 | `packages/client/modules/src/index.ts`、`client/manifest.ts` | 从 `__DSH_BOOT__.entries` 读取带 revision 的 combo URL；不能硬编码旧 `/plugins/dsh-git-vcs/client.js` |

测试不修改用户的 DSH profile、不调用模型、不使用真实远端做功能测试。测试时单独禁用 HMR 文件监听，避免 macOS watcher 配额影响结果。

## 已修复的不足

1. 首次提交前 `git restore --staged` 因缺少 HEAD 失败：改为从索引移除，保留工作文件。
2. 文件选择中的 `[]`、通配符可能匹配其它文件：直接接收路径的 Git 命令按字面路径执行。该开关不传给 stash，避免影响 Git 内部 pathspec。
3. `repoRoot` 只检查字符串，符号链接可越界，子目录还可向上定位到限制外仓库：检查真实路径及最终仓库根；未跟踪 diff 也检查目标文件。
4. 贮藏不能收起未跟踪文件：增加 UI 复选框和 `includeUntracked` 参数。通过前后 stash hash 判断是否创建记录，空操作返回 `created: false`。
5. RPC 接受不完整请求、URL 与 method 不一致、继承属性名作为端点：增加 HTTP 方法、媒体类型、JSON 信封、载荷和端点白名单检查。
6. 浏览器断开连接后 Git 仍运行：将响应关闭事件传播到 subprocess 的取消信号，区分取消和超时。
7. Console 输出可能包含远程 URL 内嵌凭据：stdout/stderr 与 argv 一并脱敏。
8. 测试把当前分支写死成 main，Windows 路径夹具在 macOS 只测错误响应却报全绿，凭据测试不传 stdin：修复这些假通过／假失败，并新增可重复的默认测试入口。

## 验证范围

| 检查 | 结果 |
|---|---|
| `node --test tests/*.test.mjs` | 10 组真实 Git／RPC 回归；本地 bare remote 覆盖 push、pull、fetch；覆盖 merge、revert、cherry-pick、reset、discard 和危险操作门禁 |
| `node scripts/verify-host.mjs` | 64 项通过；凭据确实写入隔离 credential-store 文件 |
| `node scripts/render-probe.mjs` | 17 项提交树、分页、刷新及贮藏选项转发回归通过 |
| `node scripts/preview-check.mjs` | 6 个端点返回成功结果并无损 JSON 序列化 |
| `node scripts/dom-probe.mjs` | 33 项真实 Chrome 几何、空态、初始化交互检查通过 |
| `npm run test:integration` | 完整 `0.2.1-alpha.2` 实例：未认证 401、错误 Origin 403、已认证快照、真实 stage/unstage、协议校验、插件进入客户端启动图及 combo 资源分发通过 |

复现命令参见 README 的「自检与排障」。运行集成测试前需固定安装上述 DSH 版本；DOM 探针需要浏览器和 React UMD 文件。

## 仍存在的限制

- 未实现逐行／逐 hunk 提交、并排 diff、三方冲突编辑器、多仓库工作区与文件系统监听；这些属于独立功能扩展。
- 本次实际执行环境是 macOS；未声称 Windows、Linux、远程 subprocess 或桌面端已完成端到端验证。
- 真浏览器几何检查使用插件夹具；完整 DSH 测试覆盖 host/RPC、启动图和资源分发，不等同于人工遍历真实 DSH 内的每个菜单。
- HTTPS／SSH 的真实公网凭据推送未作为自动化用例；实际 GitHub develop 推送属于交付步骤。
- 本次没有发布 npm 包、打 tag 或创建 GitHub Release。
