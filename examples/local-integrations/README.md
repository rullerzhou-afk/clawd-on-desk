# 桌面接入源码与验证

原先的原型现已接入应用正式源码，包含最新的 **WorkBuddy 签到**。

- 实现入口：`src/desktop-integrations/runtime.js`，由 `src/menu.js` 正常初始化。
- 使用入口：右键桌宠 → 桌面接入；Settings → Agents 也可打开。
- 设置：`prefs.js` schema + `settings-controller.js`，默认关闭，可停用；路径由本机用户选择。
- 打包：使用已有 Electron builder 源码收集规则，辅助程序从所附源码按需编译，无安装包重写。
- 使用、隐私和移除说明：[桌面接入指南](../../docs/guides/desktop-integrations.md)。
- 测试、打包和平台验收：[验证记录](VALIDATION.md)。

| 功能 | 现在的实现 |
| --- | --- |
| QQ 音乐控制、队列、歌单、模式、进度、歌词 | `src/desktop-integrations/qqmusic/` |
| WorkBuddy 当前/全部账号签到 | `src/desktop-integrations/checkin/` |
| 普通问答的窗口、取消和 MCP 传输 | `src/desktop-integrations/questions.js` + `hooks/desktop-question-mcp.cjs` |
| 应用快捷打开/状态、喵云网关开关 | `src/desktop-integrations/runtime.js` + `tools/` |
| 可选外部 AI 评审示例 | `hooks/examples/permission-ai-review.cjs`，接项目既有 downgrade-only 协议 |

这个 `examples/local-integrations/` 目录中的原型保留作历史参考，应用不会导入它们。此前四个独立分支也是原型快照；正式运行时、签到和设置接线以新的汇总分支为准。

贡献只含源码、合成测试数据和说明；没有个人账号/密钥/Token、歌单缓存、日志、安装包或编译生成的 EXE/DLL。ASAR 重写器、更新补丁 watcher 和 WorkBuddy 私有权限入口注入不在贡献中。

普通 MCP 问答等待实际选择，但不意味着所有 AI 原生对话框都会自动转发。权限仍遵循上游 capability registry，WorkBuddy 原生沙箱权限不通过普通问答审批。升级持久性依赖未来发布版本持续包含本模块，Fork 源码不会让尚未接纳它的官方安装包自动带上这些功能。

本次上传到个人 Fork 供验证与审阅，没有修改上游 main，也没有发布 Release。上游贡献前仍需按贡献指南对齐较大功能方案，并拆分审阅范围。
