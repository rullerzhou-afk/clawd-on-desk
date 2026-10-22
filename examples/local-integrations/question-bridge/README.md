# 普通问答 MCP 桥接原型

`mcp-server.cjs` 提供 stdio `ask_user`，把来源 ID、问题、所有选项及 `multiSelect` 转发给桌宠并等待实际答案。支持自定义输入和显式取消标记；断连、缺失答案、超时都返回未获得答案，不能当作同意。

仅用于普通澄清问题。安全审批、沙箱升级、登录、密码、账号授权继续留在原可信界面；该工具不能授予权限或自动生成答案。MCP 来源参数是调用方声明，**不是经认证的 agent 身份**。

```text
node examples/local-integrations/question-bridge/mcp-server.cjs --agent codex
```

这里只保存传输及候选服务端 adapter，没有自动写入各 AI 配置，也没有启用任何能力。`client.cjs` 复用源码 `hooks/server-config.js` 的本机端口发现；原版上游尚未接受此原型协议，桥接不可用时需要回退原生提问。

`server-question-bridge.js` 供接口设计评审，未注册到路由。正式接入需统一 capability registry、安装/启用/权限气泡 gate、本机来源验证、DND、请求预算、取消/过期协议及多选答案结构，不得仅凭 payload 声明授予额外权限。`question-sources.cjs` 只是候选来源标识，不是权限白名单，也不代表各 AI/VS Code 插件已接入。

WorkBuddy 内部注入器、Claude hook payload 替换和 ASAR 补丁不包含在此。真实 Claude/各宿主验证仍待接口确定。

```text
node --test examples/local-integrations/question-bridge/transport.test.cjs
```
