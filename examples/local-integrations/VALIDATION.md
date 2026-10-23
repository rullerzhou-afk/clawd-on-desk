# 验证记录

日期：2026-10-22，Windows，Node.js 24.11.1。基于上游 `main` 提交 `a114fd00970346a83cb441dc003e87c247dfb021` 整理。此次仅新增 `examples/local-integrations/`，未修改上游运行时、测试、配置或打包规则。

## 整理源码的检查

- QQ 音乐隔离测试：19 项通过。
- 普通问答 MCP/传输测试：4 项通过。
- 外部评审示例测试：4 项通过，使用上游 `buildReviewPayload()` 的真实序列化字段验证适配；模型后端为模拟。
- 两个 C# 原生辅助程序从源码编译通过，改用 Windows .NET Framework UIAutomation assemblies，不包含第三方 COM DLL。
- 全部新增 JavaScript/CJS 语法检查通过；PowerShell parser 检查通过。
- Cockpit / CC Switch 的未配置路径状态检查返回 `installed=false, running=false`，未打开程序。

以上检查没有切换歌曲、操控 QQ 音乐界面、批准权限或执行真实模型评审。个人安装版本过去的实际使用不能代替本次整理版本的端到端验证。

## 上游完整测试

已运行 `npm test`：12,852 项，12,679 通过、44 失败、129 跳过。初次使用 `npm ci --ignore-scripts` 安装依赖，部分失败明确由未下载 Electron 开发二进制引起；另有 DSH inspection/ownership 断言和浏览器 permission 边界失败。完整测试当前未通过，不能将此分支标记为可合并实现。

日志保留在本地贡献目录，未上传可能包含本机路径的原始日志。若补齐运行时后重跑，结果在后续提交中更新。

## 待真实环境验证

QQ 音乐新 UIA 版本、不同 QQ 音乐版本/账号权限、全屏与多屏、歌词首次创建、真实 Claude/Codex/Copilot 交互、安装/禁用/卸载、DND/断连/过期、设置与 i18n 接线、打包和目标架构审计。

当前上传为开发源码，尚未提交上游实现 PR 或应用 Release。

补充记录（2026-10-23）：已补齐 Electron 开发运行时并再次启动完整测试，但该次运行未获得完整结束汇总，不能视为通过。QQ 音乐路径规范化收尾修改另经 5 项控制器测试验证通过，已同步汇总分支和 QQ 音乐独立分支。后续新增的本机 WorkBuddy 签到功能未包含在本次源码整理中。
