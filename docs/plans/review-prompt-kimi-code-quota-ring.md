# Claude review prompt — Kimi Code quota ring plan

请在 `D:\animation` 仓库中，对下面这份设计计划做一次**独立、对抗式、只读** review：

`docs/plans/plan-kimi-code-quota-ring.md`

先完整阅读根目录 `AGENTS.md` 和计划文件，再按需检查当前生产代码、测试与项目架构文档。不要修改任何文件，不要实现功能，不要提交 commit/PR，也不要读取或输出本机 `~/.kimi-code/credentials`、API Key、OAuth token、browser cookie 或其他 secret。

这不是文案润色任务。请把计划当作准备进入实现的安全敏感设计，主动寻找能导致错误额度、secret 泄漏、后台违规请求、跨账户混淆、崩溃后状态漂移或 UI 不刷新的问题。不要因为计划写着“已由子代理 review”就接受其结论；必须独立验证。

## 必须独立核对的上游事实

只使用 Kimi/Moonshot 官方文档、官方源码、官方论坛回复等一手资料；如果需要联网，请优先官方来源并给出直接链接。至少核对：

1. Kimi Code `0.36.0` / pinned commit 中 `/coding/v1/usages` 的第一方 OAuth 调用链；
2. Kimi Code API Key 调 usage endpoint 的证据等级，是否只是 legacy/experimental 论坛示例；
3. OAuth client 的 `used/limit` 与论坛 API-key 示例的 `remaining/limit` 差异；
4. 5 小时、weekly、resetTime、Extra Usage、月度共享池各自的真实语义；
5. Kimi Web `/api/v1/oauth/usage`、`server.token` 权限和普通 TUI 覆盖边界；
6. Community Guidelines 对 interactive use / background polling 的限制；
7. 401/402/403/404/429 的歧义；
8. 是否存在今天可用、比 API-key candidate 更安全且同样覆盖普通 TUI 的结构化方案。

如果官方事实不足，请明确写“未证实”，不要用社区实现替代官方 contract。Phase 0 尚未执行是计划刻意保留的外部 gate；请审查 gate 是否充分，而不是假装已经拿到了真实响应。

## 必须审查的 Clawd 契约

请逐项对照实际代码，而不是只复述计划：

1. `settings-controller` 是否仍是唯一 prefs 写入者；command-only、post-commit effect 和 `agentIntegration` lock 是否足够；
2. save credential、enable/disable collection、forget local copy 的拆分，是否真的消除了跨 prefs/secret 文件的假原子事务；
3. Replace Key 的 generation bump、abort、atomic replace、失败 re-arm、旧 quota clear、新 refresh 顺序，以及随机 credentialId / flush-before-binding 在每个 crash 点是否会跨账户错标；
4. effect-router 丢通知/抛错时，runtime admission/response-commit gate 能否守住 durable opt-out；
5. `integrationInstalled` 与 canonical `isAgentEnabled()` gate 是否使用正确；agent disable/uninstall/About cleanup 是否会竞态或制造 orphan remote key；
6. trusted Settings IPC、preload 最小能力、generic command 绕过、subframe/旧窗口/输入长度与 CRLF injection；
7. safeStorage 在 Windows/macOS/Linux 的实际安全边界，尤其 Linux `basic_text`；
8. normalizer 对 used/remaining、一致性容差、candidate presence、malformed/absent、未知窗口的 fail-closed 行为；
9. Kimi presence-aware merge、per-bucket seenAt/resetAt/stale/retention、capturedAt 乱序，以及 Codex/Spark/Claude/Antigravity 回归；
10. snapshot signature、quota icon map、Orbit geometry/renderer/CSS、Dashboard、Settings i18n、六语言和所有消费者；
11. manual-only 与 periodic-approved policy gate、jitter、两份 browser renderer 的 per-provider stale policy、Retry-After、schema mismatch terminal、持久化 rolling budget、clock rollback、restart 和 late response；
12. 分期是否保证任何可合并阶段都不会暴露半成品或违反自身安全契约。

## 输出格式

先给 findings，按严重度排序：

- `P0`：实施/发布阻断；
- `P1`：高风险，进入实现前应修；
- `P2`：中低风险或清晰度问题。

每条 finding 必须包含：

1. 具体计划章节/行或仓库文件/行；
2. 可复现的失败场景或错误状态序列；
3. 为什么现有 gate/test 不能拦住；
4. 最小、明确的计划修订建议；
5. 如果基于上游事实，附一手来源链接并区分事实与推断。

findings 后再给：

1. **方案结论**：可实施 / 修改后可实施 / 不应实施；
2. **transport 排序**：公开 JSON/scoped API、Kimi Web local REST、独立 API Key、sidecar、OAuth read/refresh、status line/hook/PTY/cookie 等；
3. **严格回答**：今天是否存在一个对普通 TUI 覆盖不下降、同时在契约稳定性、secret 风险和 UX 上严格优于本计划 API-key candidate 的方案；
4. **Phase 0 最终 checklist**：还必须真实验证什么；
5. **残余风险**：即使所有计划项完成，仍无法消除什么。

不要输出泛泛的“建议加强测试/安全”。如果没有新的 P0/P1，也请明确写“未发现新的 P0/P1”，并说明你实际核对了哪些关键文件和上游来源。
