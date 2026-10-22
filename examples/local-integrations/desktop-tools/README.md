# Windows 应用入口与网关原型

保留桌宠菜单中的应用快捷打开、Cockpit Tools / CC Switch 运行状态与喵云网关开关。模块没有注册到上游菜单，不读取个人路径配置；开发者需在 Electron ready 后显式初始化一次并传入配置。

```js
const config = {
  apps: { qqmusic: '', notion: '', doubao: '', codex: '', workbuddy: '', cockpit: '', ccswitch: '' },
  gatewayExecutable: '', // 用户选择的 wb2api.exe 绝对路径
  gatewayPort: 7863,
  powershell: 'powershell.exe'
};
const launchers = require('./app-launchers-main.cjs')(config);
const managers = require('./ai-managers-main.cjs')(config);
const gateway = require('./gateway-main.cjs')(ctx, config);
// 由开发宿主接入各对象的 menuItems()，不要自动改写上游设置文件。
```

应用路径由用户配置；Codex 未配置时会在当前用户的常规 Codex 安装目录按版本查找。Cockpit / CC Switch 状态只读取与配置路径完全一致的进程，不修改管理软件的账号或模型配置。

网关 start/stop 必须由用户显式触发，只启动配置的 `wb2api.exe`，停止前重新核对进程的准确可执行文件路径，不按名称批量停止。health 检查仅请求配置的本机端口 `/healthz`，打开管理页为该端口 `/panel/`。启动采用隐藏窗口；不会读取网关登录配置。用户配置仍需由正式 Settings UI 校验和持久化。

界面暂为中文，Windows 专属；尚需 controller 设置接线、i18n、生命周期卸载、Electron 界面与真实应用验证。这些文件不替代原软件管理界面，也不分发第三方程序。
