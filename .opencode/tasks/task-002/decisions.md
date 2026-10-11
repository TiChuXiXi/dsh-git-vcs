# task-002 决策与验证经验

- 2026-10-12：官方 master 对应 `0.2.1-alpha.2`，npm latest 仍为 `0.2.0-rc.2`；以用户指定的官方仓库最新代码为基线，固定版本实测。
- 不能仅从上游 RPC 的 caller-owner 实现推断可用。完整 profile 中 `rpc.handle` 经 ctx.get 与注入属性两种访问都触发 webServer 注入错误；保留自注册路由。
- 最新客户端资源采用带 revision 的 combo URL，集成测试必须读取 `__DSH_BOOT__`，不能写死旧文件 URL。
- `GIT_LITERAL_PATHSPECS=1` 不能施加给 stash：会干扰内部路径魔法；仅对直接使用文件参数的命令启用。
- JSON 探针必须断言成功数据，不能把合法错误信封当成业务验证通过；Git 夹具必须实际传 stdin 才能测试 credential-store。
- 新增测试使用 Node 内置测试框架，无运行时依赖，真实 Git 写操作只在临时仓库和本地 bare remote 中进行。
