# 可选 AI 外部审查命令示例

为现有 `permissionReviewCommand` 提供独立示例。默认关闭，不安装 hook、不修改任何 agent 配置、不授予会话信任。只能在宿主已经准备自动 allow 的请求上附加审查；退出 0 表示不反对，其余情况回人工卡片。宿主的 capability、当前回合/会话身份与自动化门禁始终先执行。

入口接受上游真实 stdin `{tool, toolInput, agent, sessionId, cwd}`，并保留内部测试/调用使用的 `{toolName, toolInput, agentId, sessionId, cwd}` 适配。不会通过常规问答 MCP 来批准安全请求。

开发者显式配置 `CLAWD_REVIEW_CODEX` 为已安装的原生 Codex CLI 绝对路径；凭据由 Codex 自己管理，本示例不复制登录数据。需要读取 Clawd prefs：Windows 默认 `%APPDATA%/clawd-on-desk/clawd-prefs.json`，也可使用 `CLAWD_REVIEW_PREFS` 指定本机路径。只接受已启用自动化与权限气泡的 Claude Code / Codex / Copilot CLI，WorkBuddy 不在此示例范围。

在确认模型使用与请求数据传输范围后，用户可按[上游外部审查指南](../../../docs/guides/permission-external-review.md)自行配置 argv 数组，例如 `[nodeExecutable, absoluteExamplePath]`。不能使用 shell 字符串。外层超时需大于内部 45 秒预算；未设置原生 CLI、登录失效、格式无效、退出异常、超时、取消或设置改变都 hold。

请求先经过本地保守筛选；凭据、系统/配置路径、删除、外部传输与未知交互不发送第二模型。通过筛选的请求（含 cwd、工具参数及可能的文件内容）将交给 Codex 所配置的模型服务，需要用户理解该数据流。筛选属于保守示例，不能作为安全沙箱证明或代替宿主策略。

子进程不经 shell，使用独立临时 cwd、read-only 沙箱并关闭 hooks/apps/shell_tool/web；最终结果需来自完成的 turn、无工具事件且 requestHash 匹配。模型回应只增加一道 hold 机会，不升级 ask/deny，不执行拟议操作。

测试仅使用模拟后端，覆盖真实 stdin 格式、风险请求不外发、设置撤销、哈希/工具事件/超时错误。整理版本未执行真实模型评审或 Claude 会话，不应声称已完成所有宿主端到端接入。

```text
node --test examples/local-integrations/permission-review/review.test.cjs
```
