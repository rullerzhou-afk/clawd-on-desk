#!/bin/bash

set -u
set -o pipefail

PARENT_PID="$1"
APP_PATH="$2"
STAGED_APP="$3"
BACKUP_DIR="$4"
LOG_FILE="$5"
EXPECTED_VERSION="$6"
EXPECTED_ARCH="$7"
EXECUTABLE_NAME="$8"
EXPECTED_BUNDLE_ID="$9"
SUCCESS_MESSAGE="${10}"
ROLLBACK_MESSAGE="${11}"
QUIT_TIMEOUT_MESSAGE="${12}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

notify() {
  /usr/bin/osascript - "$1" <<'OSA' >/dev/null 2>&1 || true
on run argv
  display notification (item 1 of argv) with title "Clawd on Desk"
end run
OSA
}

plist_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null
}

rollback() {
  local reason="$1"
  local staging_root
  log "ERROR: $reason"
  if [[ -d "$OLD_APP" ]]; then
    /bin/rm -rf "$APP_PATH"
    /bin/mv "$OLD_APP" "$APP_PATH" >/dev/null 2>&1 || true
    /usr/bin/open "$APP_PATH" >/dev/null 2>&1 || true
  fi
  staging_root=$(dirname "$STAGED_APP")
  if [[ "$(basename "$staging_root")" == .clawd-update-* ]]; then
    /bin/rm -rf "$staging_root"
  fi
  notify "$ROLLBACK_MESSAGE"
  exit 1
}

mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"
OLD_APP="${APP_PATH}.old.$$"

for _ in {1..60}; do
  /bin/kill -0 "$PARENT_PID" >/dev/null 2>&1 || break
  /bin/sleep 1
done
if /bin/kill -0 "$PARENT_PID" >/dev/null 2>&1; then
  log "ERROR: Timed out waiting for Clawd to quit"
  if [[ "$(basename "$(dirname "$STAGED_APP")")" == .clawd-update-* ]]; then
    /bin/rm -rf "$(dirname "$STAGED_APP")"
  fi
  notify "$QUIT_TIMEOUT_MESSAGE"
  exit 1
fi

[[ -d "$APP_PATH" ]] || rollback "Installed app is missing"
[[ -d "$STAGED_APP" ]] || rollback "Staged update is missing"

STAGED_ID=$(plist_value "$STAGED_APP" CFBundleIdentifier)
STAGED_VERSION=$(plist_value "$STAGED_APP" CFBundleShortVersionString)
[[ "$STAGED_ID" == "$EXPECTED_BUNDLE_ID" ]] || rollback "Unexpected staged bundle id: $STAGED_ID"
[[ "$STAGED_VERSION" == "$EXPECTED_VERSION" ]] || rollback "Unexpected staged version: $STAGED_VERSION"
/usr/bin/codesign --verify --deep --strict "$STAGED_APP" >/dev/null 2>&1 || rollback "Staged code signature is invalid"
/usr/bin/lipo -archs "$STAGED_APP/Contents/MacOS/$EXECUTABLE_NAME" 2>/dev/null | /usr/bin/grep -qw "$EXPECTED_ARCH" || rollback "Staged architecture is invalid"

CURRENT_ID=$(plist_value "$APP_PATH" CFBundleIdentifier)
CURRENT_VERSION=$(plist_value "$APP_PATH" CFBundleShortVersionString)
[[ "$CURRENT_ID" == "$EXPECTED_BUNDLE_ID" ]] || rollback "Unexpected installed bundle id: $CURRENT_ID"
[[ -n "$CURRENT_VERSION" ]] || rollback "Installed app version is missing"
BACKUP_APP="$BACKUP_DIR/Clawd on Desk-v${CURRENT_VERSION}-$(date '+%Y%m%d-%H%M%S').app"
log "Backing up $APP_PATH to $BACKUP_APP"
/usr/bin/ditto "$APP_PATH" "$BACKUP_APP" || rollback "Could not create backup"

/bin/rm -rf "$OLD_APP"
/bin/mv "$APP_PATH" "$OLD_APP" || rollback "Could not move installed app"
if ! /bin/mv "$STAGED_APP" "$APP_PATH"; then
  rollback "Could not move staged update into place"
fi

INSTALLED_ID=$(plist_value "$APP_PATH" CFBundleIdentifier)
INSTALLED_VERSION=$(plist_value "$APP_PATH" CFBundleShortVersionString)
[[ "$INSTALLED_ID" == "$EXPECTED_BUNDLE_ID" ]] || rollback "Installed bundle id verification failed"
[[ "$INSTALLED_VERSION" == "$EXPECTED_VERSION" ]] || rollback "Installed version verification failed"

if ! /usr/bin/open "$APP_PATH"; then
  rollback "Updated app could not be launched"
fi
/bin/sleep 8
if ! /usr/bin/pgrep -f "$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME" >/dev/null 2>&1; then
  rollback "Updated app did not remain running"
fi

/bin/rm -rf "$OLD_APP"
/bin/rm -rf "$(dirname "$STAGED_APP")"

shopt -s nullglob
BACKUPS=("$BACKUP_DIR"/Clawd\ on\ Desk-v*.app)
shopt -u nullglob
if (( ${#BACKUPS[@]} > 3 )); then
  while IFS= read -r old_backup; do
    /bin/rm -rf "$old_backup"
  done < <(/bin/ls -dt "${BACKUPS[@]}" | /usr/bin/tail -n +4)
fi

log "Update completed successfully: $CURRENT_VERSION -> $EXPECTED_VERSION"
notify "$SUCCESS_MESSAGE"
