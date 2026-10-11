# task-002：DSH 最新版兼容与 Git 功能回归

- 分支：develop；创建日期：2026-10-12。
- 用户授权：基于官方最新版更新插件、测试与改进不足、提交并 push 到 develop。
- 上游基线：DeepSeek Harness `d743267388641bc76f17c45ce8b4c231aed1d32c`，npm `0.2.1-alpha.2`；插件 `0.2.0`。

## 核心逻辑与文件

插件仍是零依赖双半区 bundle：`index.js` 注册 `/git-vcs` 并使用 subprocess，`lib/client.js` 提供右侧栏 UI。
新版完整 Web 实测官方 `connection.rpc.handle` 仍有 webServer 注入错误，因此保留自注册通道并补齐协议检查、取消传播。
Git 功能修复包括未出生分支取消暂存、字面路径、真实路径边界、可选未跟踪贮藏与空操作识别。
`npm test`、`npm run test:dom`、`npm run test:integration` 分别覆盖默认回归、Chrome 几何及完整 DSH profile。
报告见 `docs/compatibility-0.2.1.md`；支持范围、安装和测试命令见 README。
