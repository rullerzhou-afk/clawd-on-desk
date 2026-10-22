# 本机接入的源码整理 / Local integration prototypes

这组源码来自 Windows 桌宠的个人定制版本，按 AGPL-3.0-only 贡献。这里保存可审阅、可继续移植的实现，**尚未接入上游启动、设置、打包或安装流程**，从本分支正常启动 Clawd 不会启用这些功能。

本次贡献以源码开发分支公开，未发应用 Release，也未改动上游 `main`。较大功能需按项目贡献指南先对齐方案，再分别提出实现 PR。

| 功能 | 独立分支 | 源码目录 |
| --- | --- | --- |
| QQ 音乐控制、歌单、队列、播放模式、进度、歌词 | `contrib/windows-qqmusic` | `qqmusic-windows/` |
| 普通问答 MCP 桥接 | `contrib/question-bridge` | `question-bridge/` |
| 应用快捷打开、Cockpit Tools / CC Switch 状态、网关开关 | `contrib/desktop-tools` | `desktop-tools/` |
| 可选 AI 外部审查命令示例 | `contrib/permission-review-example` | `permission-review/` |

`contrib/local-desktop-integrations` 汇总上述源码，便于查看全部修改。每项各自有说明和验证范围；验证记录见 `VALIDATION.md`。

## 公开内容的边界

- 只提交作者编写的源文件、合成测试数据及说明。个人账号、歌单缓存、配置、日志、截图、Token、安装包、备份、DLL 和 EXE 均不提交。
- 安装目录 ASAR 重写、更新后自动重打补丁的 watcher、开机恢复任务不作为上游功能分发；正式集成应进入项目正常的源码和构建流程。
- WorkBuddy 内部入口注入及其提问/权限适配未在这些分支中分发。上游当前只支持 WorkBuddy 状态与通知，权限归 WorkBuddy 原生沙箱/GUI；扩展权限必须先确定受支持接口和生命周期。
- Claude/Codex/Copilot 的本机 hook 重写器不分发。外部评审示例只走现有 downgrade-only 接口，不授予会话信任、不替换原生安全审批，也不回答用户问题。
- 上游已支持 `.workbuddy-ai` 与旧 `.workbuddy` 的安装与迁移，本机旧目录修复不重复提交。

## 后续上游适配

正式集成需要通过 `settings-controller.js` 管理设置，按 capability registry 路由，提供显式启用/卸载、翻译、打包及真实 Windows GUI 验证。普通问答需有版本化接口、真实来源绑定与取消协议；Claude hook payload 变化还需真实 Claude 会话验证。不能把这里的隔离模块测试当作这些集成条件已完成。
