# macOS 发布签名 + 公证指南（Release Signing & Notarization）

> 目标：让用户从 GitHub Releases 下载 DMG 后**直接双击打开**，不再出现
> `"Clawd on Desk" 已损坏 / 无法验证开发者` 的 Gatekeeper 拦截，
> 也不再要求每次更新都去「隐私与安全」手动放行。
>
> 关联 issue: [#872 希望 macOS 打包版支持应用内更新，并解决每次更新都要去「隐私与安全」放行的问题](https://github.com/rullerzhou-afk/clawd-on-desk/issues/872)

## 为什么需要签名 + 公证

- **代码签名（Code Signing）**：用你的 **Developer ID Application** 证书给 `.app` 签名，
  macOS 据此识别"这个 app 来自可信开发者"。
- **公证（Notarization）**：把签名后的 app 提交 Apple 后台审核，审核通过后 Apple 发一张
  票据（ticket），Gatekeeper 对已公证的 app 直接放行。
- 两者缺一不可：只签名不公证，从互联网下载后仍会被拦（Gatekeeper 会查询公证记录）；
  只公证不签名，Apple 直接拒绝提交。

> 当前仓库 `package.json` 的 `build.mac.identity` 是 `"-"`（ad-hoc 无签名），
> 这是无证书 CI 环境的默认值。**发布带签名产物时，绝不要依赖这个默认值**，
> 必须按下面的方式显式覆盖成真实证书。
> 若维护者没有 Developer ID 证书，CI 的 `Verify macOS ad-hoc hardened signatures`
> 步骤会继续用 ad-hoc 模式，不影响现状；有证书后启用签名即可。

## 前置条件

| 条件 | 说明 |
|------|------|
| Apple Developer Program 付费账号 | 个人 / 组织均可，必须含 Developer ID 能力 |
| Developer ID Application 证书 | 已导入本机钥匙串（`security find-identity -v -p codesigning` 可见） |
| Xcode + Command Line Tools | `xcrun notarytool`、`codesign`、`stapler`、`hdiutil` 依赖 |

## 一、一次性准备（本机）

### 1. 确认签名身份

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# 输出示例: "Developer ID Application: Your Name (TEAMID)"
```

没有的话去 https://developer.apple.com/account/resources/certificates/add 生成
**Developer ID Application** 证书（不在 App Store Connect API 能力范围内，只能网页生成）。

### 2. 配置公证凭据（推荐 notarytool + keychain profile）

公证优先用 Xcode 自带的 `xcrun notarytool`，凭据存进钥匙串（避免每次输入密码）：

1. 在 https://appleid.apple.com 的「登录与安全 → App 专用密码」生成一个专用密码
   （如命名 `clawd-notary`）。
2. 把它存为 notarytool 的 keychain profile（只需要做一次）：

```bash
xcrun notarytool store-credentials "clawd-notary" \
  --apple-id "you@example.com" \
  --team-id "TEAMID" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

之后脚本通过 `NOTARYTOOL_PROFILE=clawd-notary` 引用，无需再暴露密码。

> 备选：也可以走 App Store Connect API Key（`asc` CLI），但需确认 key 具备
> Developer ID 公证权限，且 key 与签名证书属于同一团队。

## 二、每次发版（可重复执行）

直接跑仓库里的脚本（不修改 package.json，全部命令行覆盖）：

```bash
# arm64（Apple Silicon）
NOTARYTOOL_PROFILE=clawd-notary bash scripts/publish-signed-mac.sh arm64

# x64（Intel）
NOTARYTOOL_PROFILE=clawd-notary bash scripts/publish-signed-mac.sh x64

# 两个架构都打
NOTARYTOOL_PROFILE=clawd-notary bash scripts/publish-signed-mac.sh all
```

脚本会按顺序完成：签名构建（覆盖 `identity`）→ 验证签名 → 打包 zip → 提交公证 →
`stapler staple` 钉票据进 `.app` → 从已公证的 app 重新生成 DMG → staple DMG →
最终验证（`spctl`）。产物在 `dist/Clawd-on-Desk-<version>-<arch>-notarized.dmg`。

> ⚠️ **必须加 `--publish never`**：package.json 的 `publish` 指向
> `rullerzhou-afk/clawd-on-desk` 上游仓库，误 publish 会把产物传到别人的仓库。

## 三、上传 Releases

1. 在 GitHub 上为 tag 创建 Release（`v<version>`）。
2. 上传 `dist/Clawd-on-Desk-<version>-<arch>-notarized.dmg` 和对应 `.blockmap`。
3. 发布后**在干净机器/浏览器隐身下载并双击**验证：不再弹"无法验证开发者"。
4. 若要启用自动更新，需同时把 `latest-mac.yml`（electron-updater 元数据）一并上传，
   并确保后续每个版本都用**同一把** Developer ID 证书签名（换证书会破坏信任链）。

## 四、GitHub Actions 可选（维护者启用签名发布）

如果维护者决定在 CI 里自动签名，在仓库 Secrets 配置（不要写进仓库）：

```
CSC_LINK                 # 证书 .p12 base64
CSC_KEY_PASSWORD         # p12 密码
APPLE_API_KEY_ID         # Key ID（App Store Connect）
APPLE_API_ISSUER         # Issuer ID
APPLE_API_KEY            # .p8 base64（Developer ID 权限）
```

CI 里构建时传 `-c.mac.identity=...`（或让 electron-builder 自动发现 `CSC_LINK`），
并配置 `mac.notarize: true`（electron-builder 原生支持用 APPLE_API_* 自动公证）。
注意：CI 里同样要 `--publish never`，发布交给 workflow 显式步骤，避免污染上游。
无证书时保持 `identity: "-"`（ad-hoc），维持现状。

## 五、常见问题

| 现象 | 原因 / 处理 |
|------|------------|
| 公证返回 `UnauthenticatedRequest` | API Key 没选 Developer ID 权限，或 issuer 缺失；改用 notarytool + keychain profile 更省事 |
| 签名后 `Authority` 链不对 | 用错了证书类型（必须是 Developer ID Application，不是 Apple Development） |
| `codesign` 报 `errSecInternalComponent` | 证书 trust settings 被改过，见 `security dump-trust-settings` 排查 |
| 用户拖出 app 后仍被拦 | 只公证了 DMG 没 staple `.app`；必须先从已 staple 的 app 重新打 DMG |
| 自动更新失败 | `latest-mac.yml` 缺失或换过签名证书 |
| 未签名直接公证 | 公证会拒绝；先 `codesign` 再公证 |

## 参考

- Apple: [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- `xcrun notarytool --help` / `xcrun stapler --help`
