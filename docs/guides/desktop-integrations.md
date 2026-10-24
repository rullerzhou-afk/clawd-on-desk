# 桌面接入 / Desktop integrations

本分支把本机定制功能接入 Clawd 的正常启动、菜单、设置和打包流程。右键桌宠 → **桌面接入 → 设置桌面接入**，或 Settings → Agents → Desktop integrations。功能默认关闭；选择本机路径并保存后，按菜单请求执行。没有后台签到计划。

This branch integrates optional desktop tools into the normal application lifecycle. Open **Desktop integrations → Configure desktop integrations** from the pet menu, or the matching button in Settings → Agents. Features start disabled. Paths are selected locally, never supplied by a downloaded example. New configuration/question/check-in windows support Chinese and English fallback; the QQ Music panel currently uses Chinese. The existing seven-language main settings/menu entry is translated.

## QQ 音乐

目前支持 Windows x64。选择安装好的 `QQMusic.exe` 并启用。可打开可自由缩放的控制面板，读取自己的歌单、查看队列、切歌、调整进度/独立音量、选择随机/顺序/单曲/列表循环，以及显示或隐藏桌面歌词。面板尺寸通过统一设置控制器保存。

右键菜单中的播放/暂停、上下首、音量、模式和歌词快捷命令直接执行，不打开桌宠控制面板。选择队列中已有编号的歌曲使用后台切歌协议，不重发整个列表；拖动进度先显示预期位置，后台同步实际状态。版权、会员和 QQ 音乐原生确认仍由 QQ 音乐处理。

首次控制会用系统 Windows PowerShell 5.1 和 .NET Framework 4.x 从本项目 C# 源码编译两个辅助程序到 Clawd 用户数据目录。编译超时/失败会报错，不下载第三方 EXE/DLL。每代缓存记录源文件及输出哈希，发现变化会拒绝执行。安装包包含源代码，Electron builder 正常生成 ASAR；不会修改运行中的 ASAR。关闭接入会销毁面板、停止媒体 worker，并结束本模块的歌词/防弹窗辅助进程。

歌单从 QQ 音乐官方服务读取，不复制登录 Cookie。首次识别账号、模式、时长或原生队列可能需要用户自行展开 QQ 音乐对应窗口；读取到的部分队列和过期内容有提示。无法对应歌曲编号的原生队列条目只读，可从“我的歌单”播放后再切换。不同 QQ 音乐版本可能改变 UIA 名称或后台协议；不能把模拟测试当作所有版本的兼容承诺。

## WorkBuddy 签到

启用 **WorkBuddy 签到（使用 Cockpit 现有账号）**。默认读取用户目录下 `.antigravity_cockpit`；自定义位置可通过文件夹选择器设置。需要先在 Cockpit Tools 添加并登录 WorkBuddy 账号。

- **当前账号签到**：打开结果面板，只处理 Cockpit 当前选定的账号。
- **签到面板 / 全部账号**：查询状态、选择单个账号，或明确点击“全部账号签到”。没有自动批量签到。
- 已签到先跳过；活动关闭先跳过；未知网络结果不自动重试写请求。登录过期时回 Cockpit 更新登录，Clawd 不刷新或修改账号。

兼容 Cockpit Tools v1.3.62 的账号索引和 AES-256-GCM 存储格式。密钥、令牌仅在主进程内存中用于请求固定的 `https://www.codebuddy.cn` 官方签到接口；不写入 Clawd 设置、日志、渲染器或 Git。面板仅收到账号 ID、遮掩标签和结果。停用会取消在途请求并关闭面板；已经发送的签到请求可能已经生效，应查询状态后再操作。格式变化会明确失败，不猜测或解密其他账号类型。

## 应用入口与网关

可添加最多 20 个应用的名称和绝对路径，例如 Cockpit Tools、CC Switch、QQ 音乐、Notion、豆包、Codex、WorkBuddy。菜单提供“打开”和“查看运行状态”。Windows 按可执行文件的精确路径检测进程；其他平台仅检查路径是否存在。不会因为进程名称相同就当作目标应用。

喵云网关仅支持 Windows，显式选择 `wb2api.exe` 和本机端口。菜单支持启动、停止、状态/管理页。健康检查和管理链接仅指向 `127.0.0.1`；停止前核对目标进程路径及固定的进程句柄。Clawd 退出或关闭接入不会擅自结束用户独立运行的网关；要停止网关需点菜单“停止”。

## MCP 普通问答

启用 MCP 普通问答，然后点击“复制 MCP 配置”，将配置合并到支持 stdio MCP 的 AI 客户端。复制不会自动写入 Claude、Codex、Copilot 或 WorkBuddy 的配置。需要可执行的 `node`；若客户端 PATH 找不到 Node，把配置的 `command` 改为本机 Node 可执行文件的绝对路径。

`hooks/desktop-question-mcp.cjs` 提供 `ask_user`。支持 1–3 个问题、每题最多 20 个选项、选项说明、单选/多选和自定义文本。界面不预选答案，等待真实提交；关闭、取消、超时、断连、勿扰、隐藏气泡或停用均返回取消。AI 客户端必须回退到原生提问界面，不能将取消解释为同意。

服务器独立绑定 `127.0.0.1` 随机端口；私有发现文件包含短期鉴权信息，不能发布。拒绝浏览器来源请求，并限制请求大小和并发。退出仅删除仍属于本实例的发现记录。来源文字是 MCP 客户端声明，不是认证过的 agent 身份，因此接口**不接受权限申请、不连接 `/permission`、不授予会话信任**。原生 Claude/Codex/Copilot 权限仍走项目 capability registry；WorkBuddy 的权限仍归原生沙箱。原生提问框不会因安装 MCP 就自动全部转发，需要客户端实际调用 `ask_user`。

## 外部 AI 评审示例

`hooks/examples/permission-ai-review.cjs` 可选接入已有 `permissionReviewCommand`。配置及 stdin/退出码协议见 [外部评审指南](permission-external-review.md)。例如先退出 Clawd，在偏好设置中使用本机 Node 和脚本的绝对路径作为 argv，设置合理的 `permissionReviewTimeoutMs`，并在启动 Clawd 的环境中显式提供 `CLAWD_REVIEW_CODEX`（真实可执行程序，不是 `.cmd` shim）及 `CLAWD_REVIEW_PREFS`（该实例实际偏好设置路径）。示例自己的后端上限为 45 秒，宿主总超时上限为 60 秒。

默认关闭。模型可能接收经过本地过滤的工具输入和工作目录，仅应在了解所用 Codex 后端的数据处理及费用后启用。凭据、配置/系统目录、删除、外部写操作、提问与计划确认会保留人工流程。宿主先完成身份和自动许可资格检查，示例只能把原本可自动许可的请求降级为人工确认；不能把原本需要确认的权限升级为许可。超时、停用、异常、未匹配结果均不自动许可。本次测试使用模拟评审后端，没有代替用户批准真实操作。

## 设置、更新和移除

`desktopIntegrations` 属于 `prefs.js` schema，由 `settings-controller.js` 独占写入；运行时订阅键更新并清理对应资源。应用路径和面板尺寸随普通用户设置保存，升级含有本模块的版本会保留。MCP 复制出的脚本路径与安装位置相关，移动安装目录后需要重新复制。

关闭各开关并保存即可停用；应用入口点击删除后保存。MCP 客户端配置由用户管理，停用后可删除其中 `clawd_questions` 条目。普通问答的发现文件会在停用时清理。可在退出 Clawd 后删除用户数据目录下本模块的 `desktop-integrations` 和 `qqmusic` 缓存；不要删除 Cockpit 的账号或密钥文件。

代码在 Fork 分支中，尚未成为上游正式发布的一部分。安装不含本模块的官方版本会使入口消失；只有上游接受并发布这些源码后，才能由官方更新持续携带。分支源码和普通设置不依赖给旧安装包反复打补丁。验证结果和待验项目见 [验证记录](../../examples/local-integrations/VALIDATION.md)。
