# Windows QQ 音乐控制原型

保留的能力：播放/暂停、上下首、QQ 音乐专属音量、可缩放面板、自己的歌单、完整歌单分页、播放队列、随机/顺序/单曲/列表循环、立即发送进度调整及桌面歌词显示/隐藏。菜单快捷控制直接发送命令，不自动打开控制面板；切换已有队列歌曲只发送目标歌曲，不重发整张歌单。

这是隔离的 Electron 模块，未接入上游菜单或设置。供开发者显式加载和评审，不是安装器。中文界面尚待项目 i18n 迁移，macOS/Linux 不支持。

## 开发接线

要求 Windows、QQ 音乐桌面版、Windows PowerShell 5.1 与 .NET Framework 4.x。先从源码编译自有辅助程序：

```powershell
powershell.exe -NoProfile -File examples/local-integrations/qqmusic-windows/build-native.ps1
```

在 Electron main ready 后显式初始化一次，传入真实绝对路径；`ctx.win` 可选，用于将面板放到桌宠附近：

```js
const music = require('./examples/local-integrations/qqmusic-windows/qqmusic-main')(
  ctx, { executable: configuredQQMusicPath }
);
// 开发宿主自行把 music.menuItems() 加入菜单，或调用 music.show()。
```

也支持 `CLAWD_QQMUSIC_EXECUTABLE`。默认没有硬编码安装路径，不读取个人 `location.json`。源码内 `.native/` 必须可写；正式打包前需将辅助程序与写入目录分开并纳入目标架构审计，不能原样放进 ASAR。

## 行为及数据

SMTC 负责媒体控制，Core Audio 负责当前 QQ 音乐进程的音量；进度、队列、模式与账号编号来自 QQ 音乐的可访问性信息。C# 辅助程序只定位配置的准确 QQMusic.exe 路径所拥有的窗口；后台切歌保护只隐藏其确切的“已开始播放提示”窗口。

歌词开关只操作已确认属于 QQ 音乐的歌词窗口；若播放器尚未创建该窗口，需要先在 QQ 音乐启用一次。源码不含 QQ 音乐程序或其 DLL。

歌单读取会向 `u.y.qq.com` 发送本机播放器显示的账号编号和歌单编号，不读取浏览器 Cookie、登录令牌或密码。播放器必须已登录且相关歌单能通过该服务访问；这些非公开稳定接口可能随 QQ 音乐版本变化。

缓存的账号编号、队列和歌曲元数据保存在 Electron `userData/qqmusic/`，面板大小与控制日志也在本机 userData。不会加入仓库。只加载这些文件不会发出歌单请求，须显式初始化并执行操作。

原生队列可能只暴露可见行；无法确认歌曲编号的行标记为只读。最小化时播放器时间可能过期，界面明确区分估算/原生时间；发送 seek 成功不等于 SMTC 已确认新位置。

## 验证

```powershell
node --test examples/local-integrations/qqmusic-windows/*.test.cjs
```

测试覆盖命令白名单、窗口 IPC 来源、超时不重试切歌、完整分页、静默单曲协议、立即 seek、快速拖动取最后目标、并行队列操作。合成测试不调用正在播放的 QQ 音乐。新框架 UIA 版本仅完成编译验证；当前整理版本仍需真实播放器端到端验证后才能提出正式实现 PR。
