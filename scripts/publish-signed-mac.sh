#!/usr/bin/env bash
# =============================================================================
# publish-signed-mac.sh
#
# 用本机 Developer ID 证书对 Clawd 进行「签名 + 公证 + staple」，产出可分发、
# 其他用户下载后可直接打开（Gatekeeper 不再拦截）的 macOS DMG。
#
# 设计原则：
#   - 不修改 package.json（上游写死的 `mac.identity: "-"` 只做命令行覆盖）
#   - 每发一版跑一次，产物始终带同一把 Developer ID 签名 + Apple 公证
#   - 凭据只来自环境变量 / keychain profile，脚本不持有任何秘密
#
# 用法：
#   bash scripts/publish-signed-mac.sh [x64|arm64|all] [--skip-build]
#
# 公证凭据（二选一，优先级从高到低）：
#   1) NOTARYTOOL_PROFILE  -> 已用 `xcrun notarytool store-credentials` 存的 keychain profile
#   2) APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID
#
# 前置条件：
#   1. 钥匙串里有 Developer ID Application 证书
#   2. Xcode Command Line Tools（codesign / hdiutil / stapler / notarytool）
# =============================================================================
set -euo pipefail

ARCH="${1:-arm64}"
SKIP_BUILD="${2:-}"

# ---- 用系统钥匙串里的 Developer ID Application 证书（通用名） ----
IDENTITY_NAME="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -oE 'Developer ID Application: [^(]+ \(' | head -1 | sed 's/Developer ID Application: //; s/ ($//' || true)"
if [[ -z "$IDENTITY_NAME" ]]; then
  echo "❌ 钥匙串中未找到 Developer ID Application 证书" >&2
  exit 1
fi
echo "🔑 使用签名身份: Developer ID Application: $IDENTITY_NAME"

# ---- 公证凭据解析 ----
NOTARY_ARGS=()
if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
  NOTARY_ARGS+=(--keychain-profile "$NOTARYTOOL_PROFILE")
  echo "🔐 公证凭据: keychain profile '$NOTARYTOOL_PROFILE'"
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARY_ARGS+=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
  echo "🔐 公证凭据: Apple ID ($APPLE_ID) / team $APPLE_TEAM_ID"
else
  echo "❌ 未找到公证凭据。设置 NOTARYTOOL_PROFILE 或 APPLE_ID+APPLE_APP_PASSWORD+APPLE_TEAM_ID" >&2
  echo "   生成专用密码: https://appleid.apple.com -> 登录与安全 -> App 专用密码" >&2
  echo "   存入 keychain profile: xcrun notarytool store-credentials 'clawd-notary' --apple-id <id> --team-id <team>" >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="Clawd on Desk"

declare -a TARGET_ARCHS
case "$ARCH" in
  x64)   TARGET_ARCHS=(x64) ;;
  arm64) TARGET_ARCHS=(arm64) ;;
  all)   TARGET_ARCHS=(x64 arm64) ;;
  *)     echo "❌ 未知架构: $ARCH (可选 x64|arm64|all)" >&2; exit 1 ;;
esac

# =============================================================================
# 1. 构建（覆盖 identity 为本地证书；禁止 publish，防止误传上游仓库）
# =============================================================================
if [[ "$SKIP_BUILD" != "--skip-build" ]]; then
  echo ""
  echo "🏗️  开始构建 (v$VERSION, arch: ${TARGET_ARCHS[*]})..."
  for a in "${TARGET_ARCHS[@]}"; do
    echo "   → electron-builder --mac dmg:$a"
    npx electron-builder --mac "dmg:$a" --publish never \
      -c.mac.identity="$IDENTITY_NAME"
  done
fi

for a in "${TARGET_ARCHS[@]}"; do
  APP_PATH="dist/mac-$a/$APP_NAME.app"
  echo ""
  echo "================================================================"
  echo "  处理 $a 架构"
  echo "================================================================"

  # =============================================================================
  # 2. 签名验证（必须：Authority 链 + hardened runtime + 时间戳）
  # =============================================================================
  echo ""
  echo "🔍 验证签名..."
  codesign -dvvv "$APP_PATH" 2>&1 | grep -E "Authority|flags|Timestamp" \
    || { echo "❌ 签名缺失或异常" >&2; exit 1; }

  # =============================================================================
  # 3. 公证（Notarization）—— xcrun notarytool
  # =============================================================================
  ZIP="/tmp/clawd-$a-${VERSION}.zip"
  echo ""
  echo "📦 打包 zip 并提交公证..."
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP_PATH" "$ZIP"

  echo "   xcrun notarytool submit --wait ..."
  if ! xcrun notarytool submit "$ZIP" "${NOTARY_ARGS[@]}" --wait --output-format json 2>&1 \
      | tee /tmp/clawd-$a-notary-result.json; then
    echo "❌ 公证失败，查看上方日志。" >&2
    exit 1
  fi

  # =============================================================================
  # 4. staple（把票据钉进 .app，离线也能通过 Gatekeeper）
  # =============================================================================
  echo ""
  echo "📌 staple .app ..."
  xcrun stapler staple "$APP_PATH"

  # =============================================================================
  # 5. 用已公证的 .app 重新生成 DMG，再 staple DMG
  # =============================================================================
  DMG_OUT="dist/Clawd-on-Desk-${VERSION}-${a}-notarized.dmg"
  echo ""
  echo "💿 重新生成 DMG (从已公证 app) → $DMG_OUT"
  rm -f "$DMG_OUT"
  hdiutil create -volname "$APP_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_OUT"
  xcrun stapler staple "$DMG_OUT"

  # =============================================================================
  # 6. 最终验证
  # =============================================================================
  echo ""
  echo "✅ 验证:"
  xcrun stapler validate "$APP_PATH" && echo "   stapler(app)   OK"
  xcrun stapler validate "$DMG_OUT"  && echo "   stapler(dmg)   OK"
  spctl --assess --type execute --verbose=4 "$APP_PATH" 2>&1 | tail -1
  echo "   产物: $DMG_OUT ($(du -h "$DMG_OUT" | cut -f1))"
done

echo ""
echo "🎉 全部完成。将上述 dist/Clawd-on-Desk-*-notarized.dmg 上传到你的 GitHub Releases 即可。"
