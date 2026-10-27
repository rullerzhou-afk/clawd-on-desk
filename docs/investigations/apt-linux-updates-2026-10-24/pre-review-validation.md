# APT 方案预验证（2026-10-24）

对象：应用代码基线 `6573eab7`；计划初版 SHA-256 `5459e4acbc9b631859103b6512321a0542479aac7223f33dfe9e482524f6e296`。

## 已有发布条件

- GitHub Pages 配置查询返回 404，主仓库未部署 Pages。
- 已配置的 Actions secrets 只有 Apple 签名相关项；未发现 APT secret。没有读取私钥值。
- v1.4.0 为正式非草稿发布；`Clawd-on-Desk-1.4.0-amd64.deb` 为 112,008,612 字节。
- 独立工作树复用现有依赖，更新器和 metadata 基线测试 74/74 通过。

## 已发布真实 deb 的只读检查

在专属临时目录下载 v1.4.0 原包，用 `dpkg-deb --field` 和 `--control` 检查后清除临时目录，未安装、未执行脚本。

- SHA-256：`5cb3d2275a4112efb872a8fb9a02dd52ab19f757f194c1f6430f7c0def76787e`，与 GitHub API asset `656183875` 的 digest 完全一致。
- Package / Version / Architecture：`clawd-on-desk` / `1.4.0` / `amd64`。
- Depends：`libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0`。
- control archive 包含 control、md5sums、postinst、postrm。脚本维护命令入口、Chrome sandbox 权限和可选 AppArmor profile；未发现配置官方 APT 源的逻辑。
- 真实包的维护脚本使用绝对系统路径，不能在普通用户目录配合 script-chrootless 执行；真实安装/升级验收应在隔离 amd64 CI 环境进行。

## Linux 无特权原生行为探测

环境：已配置的 `pi` 主机，aarch64、普通用户 UID 1000；具备 apt-get/dpkg/dpkg-deb/GPG/Python。Docker 存在，但用户不能访问 socket，`sudo -n` 需要密码。因此未使用 Docker，未修改用户组、权限、网络代理或主机软件源。

以下探测分别使用独立的 `/tmp/clawd-apt-*-probe-*` 目录，结束后只清除了本次创建的目录。没有运行应用安装包的维护脚本，没有操作系统实际的 dpkg 状态库。

### 配置文件生命周期

用无 maintainer script 的微型测试包，把 `.sources` 和 `.asc` 公钥均登记为 conffile；dpkg 使用 `--root=<test-root> --force-not-root`。

| 操作 | exit | 源文件 | 公钥 |
|---|---:|---|---|
| install | 0 | 存在 | 存在 |
| remove | 0 | 保留 | 保留 |
| purge | 0 | 删除 | 删除 |

首次探测因非 root PATH 缺少 `/usr/sbin:/sbin` 被 dpkg 拒绝，未发生安装；仅给后续测试子进程补齐标准命令路径后通过。

### 配置包升级

安装 1.0 后把源改为 `Enabled: no`；1.1 更新测试公钥但保持原源模板；1.2 前手动删除源。所有升级使用 `--force-confdef --force-confold`，结果：

- 已禁用源仍为 `Enabled: no`：通过。
- 未经用户修改的公钥更新到新内容：通过。
- 用户删除的源未被重建：通过。

这支持使用标准 dpkg 配置语义，无需自制重写源文件的维护脚本。用户指南应以 `apt purge clawd-apt-source` 表示彻底移除源；普通 remove 保留配置，不能承诺已经禁用。

### 签名和篡改

在专属 GNUPGHOME 生成 1 天有效的 RSA2048 测试签名密钥，为含 SHA256 的 Release 生成 InRelease。APT 的配置、source、state/status、lists、cache、log、架构与 sandbox user 全部指向测试环境，关闭系统配置片段加载，只读本次 file: 源。

- 原签名源 `apt-get update` exit 0。
- 改动 InRelease 的 Origin 而不重新签名，`apt-get update --error-on=any` exit 100，验证器报告 `Message has been manipulated`，并保留旧索引。
- 测试结束仅关闭专属 GNUPGHOME 的 GPG agent 并清除本次目录。

## 证明范围

这些结果仅证明原生 APT/dpkg 的方案基础。尚未验证产品实现、正式签名密钥、线上 Pages 发布、真实 amd64 Clawd 安装/升级、GUI 或 AppImage 更新。这些仍需实现后验收。
