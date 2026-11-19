# Linux APT 安装与迁移

官方软件源支持 **Debian 12/13、Ubuntu 22.04/24.04 的 amd64 系统**，是否添加由用户选择。AppImage 保留应用内下载和重启更新；Homebrew 管理的安装请使用 `brew upgrade --cask clawd-on-desk`。

[APT 接入页面](https://apt.clawdondesk.com/#chinese)提供当前软件源接入包、SHA-256 和公钥指纹。若软件源尚未启用或暂时不可用，可继续从 [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest) 下载官方 `.deb` 手动安装。

## 已安装 `.deb` 的用户，包括 1.3、1.4

可以直接接入 APT，**不需要先让旧版应用内更新成功**。原有用户配置会保留。

1. 运行 `dpkg --print-architecture`，确认结果是 `amd64`。
2. 退出 Clawd。旧版可能在退出时请求安装已下载的更新；取消该授权提示即可。
3. 打开 [APT 接入页面](https://apt.clawdondesk.com/#chinese)，下载 `clawd-apt-source_<version>_all.deb`，按页面显示的完整 SHA-256 校验。首次安装也可将公钥完整指纹与[维护者启用记录](apt-maintenance.md#activation-record)核对。
4. 在下载目录执行，第一行需替换成实际下载的文件名：

```sh
sudo apt install ./clawd-apt-source_<version>_all.deb
sudo apt update
sudo apt install clawd-on-desk
```

5. 重新打开 Clawd。新机器也使用相同步骤。

接入包没有安装脚本，只管理 `/etc/apt` 下自己的公钥、软件源和包范围限制，不开启无人值守升级。首次信任来自 HTTPS 接入页面；同站校验值不能独立防范整个网站被攻破。

## 后续更新

先退出 Clawd，更新完成后再打开：

```sh
sudo apt update
sudo apt install --only-upgrade clawd-on-desk clawd-apt-source
```

`.deb` 应用会提示新版并打开指南，不自行运行提权安装器，也不在退出时安装更新。应用通知可能早于软件源发布，可运行 `apt-cache policy clawd-on-desk` 查看候选版本，稍后重试 `apt update`。APT 会直接替换磁盘文件，因此请先退出正在运行的 Clawd。

## 停用或移除

若只想暂停，在 `/etc/apt/sources.list.d/clawd-on-desk.sources` 中添加 `Enabled: no`。软件源包升级会保留管理员修改，也会保留主动删除配置文件的选择。

移除软件源和公钥、保留 Clawd 本体：

```sh
sudo apt purge clawd-apt-source
sudo apt update
```

必须使用 **purge**。普通 `apt remove` 会保留配置、公钥和限制文件：软件源仍然启用，但接入包已移除，不能再收到公钥更新。三类文件都采用 dpkg conffile 管理，避免留下“源还在、公钥却没了”的状态。

限制文件只允许从 `apt.clawdondesk.com` 安装 `clawd-on-desk` 和 `clawd-apt-source`；它覆盖整个主机名，包括其下其他路径。公钥通过 `Signed-By` 仅用于此源，不进入全局信任。

## 故障处理

- **索引过旧、旧包地址返回 404：**先执行 `sudo apt update`。软件源保留最近三个版本，不是完整历史归档。
- **签名错误或密钥过期：**停止安装，检查官方接入页面与仓库。到期前可通过正常升级接入包获得交叠的新公钥；已过期时，从 HTTPS 页面重新下载、核验并安装新版本接入包。不要关闭认证或使用 `trusted=yes`。
- **软件源不可用：**可保留当前版本或暂时停用源。也可退出 Clawd 后，使用官方文件执行 `sudo apt install ./Clawd-on-Desk-VERSION-amd64.deb` 手动升级。

[English](apt-setup.md) · [维护与发布流程](apt-maintenance.md)
