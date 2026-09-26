#!/usr/bin/env bash
# Executed by the system bash from an in-memory command string, before Electron
# starts. None of this supervisor's code or libraries depend on the FUSE mount.
# Arguments: source AppDir, original AppImage, then unchanged application argv.
set -u

source_dir=$1
image=$2
shift 2
run_dir=
child=
stop_requested=0
wait_interrupted=0

stop_child() {
  stop_requested=1
  wait_interrupted=1
  if [[ -n "$child" ]]; then
    # Let Electron shut down its own children in order. Signalling its whole
    # group can kill Chromium services before the browser finishes cleanup.
    # The shell still owns this unreaped direct child, including before exec.
    kill -TERM "$child" 2>/dev/null || :
  fi
}
trap stop_child TERM INT HUP

fail() {
  printf 'Clawd: cannot prepare an AppImage runtime directory: %s\n' "$1" >&2
  if [[ -n "$run_dir" && -d "$run_dir" && ! -L "$run_dir" ]]; then
    command -p rm -rf -- "$run_dir"
  fi
  exit 1
}

for tool in cp mktemp setsid rm sleep stat; do
  command -p -v "$tool" >/dev/null || fail "missing $tool"
done
[[ "$source_dir" == /* && -d "$source_dir" && -x "$source_dir/AppRun" ]] || fail 'invalid AppDir'
[[ "$image" == /* && -f "$image" ]] || fail 'invalid AppImage'

# A unique directory per launch avoids sharing an extraction directory with a
# concurrent launch, an XWayland replacement, or a different app version.
temp_base=${TMPDIR:-/tmp}
[[ "$temp_base" == /* ]] || fail 'TMPDIR must be absolute'
run_dir=$(command -p mktemp -d -- "$temp_base/clawd-appimage.XXXXXXXX") || fail 'temporary directory creation failed'
temp_fs=$(command -p stat -f -c %T -- "$run_dir") || fail 'cannot inspect temporary filesystem'
# A FUSE-backed TMPDIR would re-enter this guard and still depend on a daemon.
[[ "$temp_fs" != fuseblk ]] || fail 'TMPDIR must not be on a FUSE filesystem'
payload="$run_dir/app"
if ! command -p cp -a --no-preserve=ownership -- "$source_dir" "$payload"; then
  fail 'copy failed (check free space and the AppImage mount)'
fi
if (( stop_requested )); then
  command -p rm -rf -- "$run_dir"
  exit 143
fi

# Keep APPIMAGE pointing at the original file for relaunches, integration
# launch paths and update detection. Do not change HOME, cwd or TMPDIR.
APPDIR="$payload" APPIMAGE="$image" command -p setsid -- "$payload/AppRun" "$@" &
child=$!
if (( stop_requested )); then stop_child; fi
status=0
while :; do
  wait_interrupted=0
  wait "$child"
  status=$?
  # A caught signal interrupts wait without necessarily reaping the child.
  # Re-wait the shell's own child record; do not probe a possibly reused PID.
  (( wait_interrupted )) || break
done
trap '' TERM INT HUP

# Electron normally reaps its children before returning. Give any remaining
# members of this launch's process group time to finish before deleting files.
# A stuck child keeps its files; the OS can reclaim the private temp directory
# after logout/reboot. Never delete an active launch to satisfy cleanup.
for (( attempt=0; attempt<50; attempt++ )); do
  if ! kill -0 -- "-$child" 2>/dev/null; then
    command -p rm -rf -- "$run_dir"
    exit "$status"
  fi
  command -p sleep 0.1
done
printf 'Clawd: retaining runtime files for a process still exiting: %s\n' "$run_dir" >&2
exit "$status"
