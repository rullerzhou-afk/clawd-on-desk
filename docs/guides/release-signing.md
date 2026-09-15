# macOS Developer ID 签名与公证

Clawd on Desk 通过 GitHub Releases 直接分发，不走 Mac App Store。正式
macOS 版本需要用 `Developer ID Application` 证书签名，并由 Apple 公证。

Apple Developer Program 会员生效只是前提，不代表证书或 CI 凭据已经生成。
下面的一次性准备完成后，本机和 GitHub Actions 才能产出 Gatekeeper 可直接
放行的安装包。

## 安全边界

- `.p12` 同时包含证书和私钥；`.p8` 是 App Store Connect API 私钥。
- 不要把这些文件、Base64 内容或密码提交到仓库、Issue、PR、日志或聊天。
- `.p8` 只能下载一次。若怀疑泄露，立即在 Apple 后台吊销对应 API Key。
- 正式版本始终使用同一团队的 Developer ID 证书；不要使用第三方证书签名。

## 1. 生成 Developer ID Application 证书

### 创建 CSR

在用于保存私钥的 Mac 上操作：

1. 打开“钥匙串访问”（`/Applications/Utilities/Keychain Access.app`）。
2. 菜单选择“钥匙串访问 → 证书助理 → 从证书颁发机构请求证书”。
3. “用户电子邮件地址”填写 Apple Developer 账号邮箱。
4. “常用名称”填写便于识别的名字，例如 `Clawd Release Key`。
5. “CA 电子邮件地址”留空，选择“存储到磁盘”。
6. 保存生成的 `.certSigningRequest` 文件。

### 创建并安装证书

1. 打开 <https://developer.apple.com/account/resources/certificates/list>。
2. 点击 `+`，在 Software 下选择 **Developer ID**。
3. 选择 **Developer ID Application**，不要选择 Developer ID Installer、
   Apple Development 或 Apple Distribution。
4. 上传刚生成的 CSR，下载 `.cer`。
5. 双击 `.cer` 导入钥匙串。

导入后运行：

```bash
security find-identity -v -p codesigning
```

必须看到一项类似：

```text
Developer ID Application: <姓名> (<TEAM_ID>)
```

### 导出给 GitHub Actions 使用的 `.p12`

1. 在“钥匙串访问 → 登录 → 我的证书”中展开 Developer ID Application。
2. 确认它下面带有对应私钥。
3. 右键证书，选择“导出”，格式选 `.p12`。
4. 设置一个新的高强度导出密码；该密码只用于 CI 导入这份 `.p12`。

如果证书下面没有私钥，说明 CSR 不是在这台 Mac 上生成，不能用该证书签名。

## 2. 创建公证用 Team API Key

使用 **Team API Key**，不要使用 Individual API Key；Individual Key 不能用于
`notarytool`。当前锁定的 `@electron/notarize` 要求 Team Key 具有
**App Manager** 权限。

1. 打开 <https://appstoreconnect.apple.com/access/integrations/api>。
2. 如果尚未启用 API，先由 Account Holder 在 Users and Access → Integrations
   请求 App Store Connect API 访问。
3. 进入 Team Keys，点击 Generate API Key（或 `+`）。
4. 名称可填 `Clawd GitHub Release`，Access 选择 **App Manager**。
5. 生成后记录 **Issuer ID** 和 **Key ID**。
6. 下载 `AuthKey_<KEY_ID>.p8`；Apple 只允许下载一次。

Developer Team ID、Issuer ID 和 Key ID 是三个不同的值，不能混用。

## 3. 先在本机验证一次

把 Team API Key 存进本机钥匙串；命令会在线校验凭据：

```bash
xcrun notarytool store-credentials "clawd-notary" \
  --key "/绝对路径/AuthKey_<KEY_ID>.p8" \
  --key-id "<KEY_ID>" \
  --issuer "<ISSUER_ID>"
```

只构建当前常用的 Apple Silicon 版本进行首次验证：

```bash
APPLE_KEYCHAIN_PROFILE=clawd-notary \
  npx electron-builder --mac dmg:arm64 zip:arm64 --publish never \
  -c.mac.identity="Developer ID Application"
```

构建结束后验证未打包 app；DMG 和 ZIP 内实际分发的 app 也必须执行同一组
签名、Gatekeeper、stapler、entitlements 与 native payload 检查：

```bash
codesign --verify --deep --strict --verbose=2 \
  "dist/mac-arm64/Clawd on Desk.app"
spctl --assess --type execute --verbose=4 \
  "dist/mac-arm64/Clawd on Desk.app"
xcrun stapler validate "dist/mac-arm64/Clawd on Desk.app"
```

预期 `spctl` 显示 `accepted`，来源为 `Notarized Developer ID`，`stapler`
显示 validation succeeded。构建目录还应同时存在 arm64 DMG、ZIP、
`ZIP.blockmap` 与 `latest-mac.yml`；DMG 用于首次/手动安装，Squirrel.Mac
应用内更新使用 ZIP。首次正式发布前，还必须从 GitHub draft Release 通过浏览器
重新下载 DMG，再做一次 Gatekeeper 双击启动验证。

## 4. 配置 GitHub Actions Secrets 与 Variable

进入仓库 Settings → Secrets and variables → Actions → New repository secret，
配置以下五项：

| Secret | 内容 |
|---|---|
| `CSC_LINK` | `.p12` 文件的 Base64 内容 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY` | `.p8` 文件的 Base64 内容 |
| `APPLE_API_KEY_ID` | App Store Connect Team Key 的 Key ID |
| `APPLE_API_ISSUER` | App Store Connect 的 Issuer ID |

另外在 **Variables → Actions → New repository variable** 配置
`APPLE_TEAM_ID`，值为证书括号中的 10 位 Developer Team ID。它不是秘密，
但发布门会用它精确核对最终 app 的 `Authority` 与 `TeamIdentifier`；缺失或
签名团队不一致时，正式构建必须失败。

在 Mac 上可把文件编码后直接送进剪贴板，避免打印在终端：

```bash
base64 -i "/绝对路径/DeveloperIDApplication.p12" | pbcopy
base64 -i "/绝对路径/AuthKey_<KEY_ID>.p8" | pbcopy
```

每执行一条命令，立刻把剪贴板粘贴到对应 Secret。不要把编码结果保存进仓库。

工作流规则：

- 五项全部存在：构建 Developer ID 签名、公证并 stapled 的 app；CI 会分别解包
  x64 和 arm64 的最终 DMG 与 ZIP，验证里面实际分发的 app。
- 五项全部不存在：只有手动 `workflow_dispatch` 可以走 ad-hoc 验证。
- 只配置一部分：立即失败并列出缺少的 Secret 名称，不打印 Secret 内容。
- 推送 `v*` tag：五项缺任何一项都失败，绝不生成 ad-hoc 官方版本。

当前锁定的 `app-builder-lib@26.15.7` 把证书导出密码误传给
`security set-key-partition-list -k`，该参数实际需要临时钥匙串密码，
会导致 `SecKeychainUnlock`。Developer ID 构建前会运行
`node scripts/prepare-macos-signing.js`，仅修正 CI 安装的 macOS 签名模块，
不更改共享依赖版本、Windows 构建或应用运行时代码。脚本核对版本及修改前后
完整文件 SHA256；遇到未知版本/内容会停止，升级该依赖时必须重新审查并移除
或更新此临时兼容处理。这个错误不要求改动现有 Secrets；修复仍须通过后续
真实签名、公证和分发包验证。

## 5. 首次发布验证

1. 在 Actions 手动运行 `Build & Release`，不要先推正式 tag。
2. 确认 macOS job 的签名、公证、DMG / ZIP 解包验证和 updater metadata 全部通过。
3. 下载 `mac-installer` artifact，确认恰好包含两个 DMG、两个 ZIP、两个
   `ZIP.blockmap` 和 `latest-mac.yml`；metadata 必须列出 x64/arm64 的 ZIP 与
   DMG，top-level `path` 必须指向 x64 ZIP。
4. 在另一台 Mac 或干净浏览器下载 DMG，双击打开并拖入 Applications。
5. 确认无需在“隐私与安全”中手动放行，再执行：

```bash
spctl --assess --type execute --verbose=4 "/Applications/Clawd on Desk.app"
xcrun stapler validate "/Applications/Clawd on Desk.app"
```

6. 旧版 DMG 没有 ZIP 更新载荷，不能自动升级到第一个 updater-capable 版本；
   首个桥接版的 release note 必须明确要求现有 macOS 用户手动安装这一次。
7. 合并前使用不会公开发布的隔离更新源，完成同一 Developer ID 的签名 A→B
   真机升级：至少覆盖 Apple Silicon 的 Restart Now 与 Later → 正常退出 → 再次启动；
   Intel 未覆盖时必须明确标为 pending，不能用静态包审计代替。
8. 首次验证全部通过后，才按发布流程创建并推送正式 `v*` tag；桥接版安装后，
   后续正式版本才可以宣称支持应用内下载与安装。

## 参考

- [Apple：创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple：创建 CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [Apple：公证 macOS 软件](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple：App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [Electron：代码签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)
