#!/usr/bin/env bash
# ci/install-wayland-deps.sh — cache-aware apt install for the Wayland smoke jobs.
#
# Usage:
#   install-wayland-deps.sh install <cache-dir>
#   install-wayland-deps.sh publish <cache-dir>
#
# `install` prefers the .deb files in <cache-dir>. When the cache is missing or
# the offline install fails, it downloads from the Ubuntu archive into a root
# owned temporary directory and installs from there. `publish` always downloads,
# validates the result with a real offline install, and only then fills
# <cache-dir> with the verified .deb files.
#
# The package list lives in ci/wayland-apt-packages.txt. Tests may override the
# apt root, the temporary work root, the package list and the primary mirror
# through the WAYLAND_APT_* environment variables below.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'usage: install-wayland-deps.sh <install|publish> <cache-dir>\n' >&2
  exit 2
fi

MODE="$1"
CACHE_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APT_ETC="${WAYLAND_APT_ETC:-/etc/apt}"
WORK_ROOT="${WAYLAND_APT_WORK_ROOT:-/var/tmp}"
PACKAGES_FILE="${WAYLAND_APT_PACKAGES_FILE:-$SCRIPT_DIR/wayland-apt-packages.txt}"
PRIMARY_MIRROR="${WAYLAND_APT_PRIMARY_MIRROR:-azure.archive.ubuntu.com}"
FALLBACK_MIRROR="archive.ubuntu.com"
TOTAL_BUDGET="${WAYLAND_APT_TOTAL_BUDGET:-540}"

WORK="$WORK_ROOT/wayland-apt-$$"
TOTAL_STARTED=0
GROUP_STARTED=0
GROUP_NAME=""
GROUP_OPEN=0
CURRENT_MIRROR="$PRIMARY_MIRROR"
PACKAGES=()
APT_ARGS=()

epoch_now() { date +%s; }

start_group() {
  GROUP_NAME="$*"
  GROUP_STARTED="$(epoch_now)"
  GROUP_OPEN=1
  printf '::group::%s\n' "$GROUP_NAME"
}

end_group() {
  if [ "$GROUP_OPEN" -eq 1 ]; then
    local finished elapsed
    finished="$(epoch_now)"
    elapsed=$((finished - GROUP_STARTED))
    printf '::endgroup::\n'
    printf '%s finished in %ss\n' "$GROUP_NAME" "$elapsed"
    GROUP_OPEN=0
  fi
}

close_open_group() {
  if [ "${GROUP_OPEN:-0}" -eq 1 ]; then
    printf '::endgroup::\n'
    GROUP_OPEN=0
  fi
}
trap close_open_group EXIT

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

remaining_budget() {
  local now
  now="$(epoch_now)"
  printf '%s\n' $((TOTAL_BUDGET - (now - TOTAL_STARTED)))
}

# run_with_budget <step-limit> <description> <command...>
# Runs a network command under the smaller of the step limit and the remaining
# total budget. The whole script is meant to finish inside wayland-smoke's
# timeout-minutes, so a nearly exhausted budget fails before starting work.
run_with_budget() {
  local step_limit="$1"
  local description="$2"
  local remaining limit
  shift 2

  remaining="$(remaining_budget)"
  if [ "$remaining" -lt 20 ]; then
    printf '::error::time budget exhausted before %s (%ss left)\n' "$description" "$remaining" >&2
    return 1
  fi

  limit="$step_limit"
  if [ "$remaining" -lt "$limit" ]; then
    limit="$remaining"
  fi
  printf '%s (timeout %ss, %ss budget left)\n' "$description" "$limit" "$remaining"
  timeout -k 10 "$limit" "$@"
}

load_packages() {
  local line
  PACKAGES=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    PACKAGES+=("$line")
  done <"$PACKAGES_FILE"
  if [ "${#PACKAGES[@]}" -eq 0 ]; then
    fail "package list $PACKAGES_FILE is empty"
  fi
}

prepare_work_tree() {
  start_group "prepare isolated apt workspace"
  # root owns the work tree so the apt sandbox user can read package lists and
  # archives under a HOME that _apt cannot enter.
  sudo mkdir -p "$WORK/lists/partial" "$WORK/archives/partial" "$WORK/sources.list.d"
  sudo chmod 755 "$WORK" "$WORK/lists" "$WORK/lists/partial" \
    "$WORK/archives" "$WORK/archives/partial" "$WORK/sources.list.d"
  printf 'work directory: %s\n' "$WORK"
  end_group
}

prepare_apt_sources() {
  local found file base dest
  start_group "copy Ubuntu apt sources"

  found="$(grep -rln -- 'archive.ubuntu.com' \
    "$APT_ETC/sources.list" "$APT_ETC/sources.list.d" 2>/dev/null || true)"
  if [ -z "$found" ]; then
    fail "no Ubuntu apt source files found under $APT_ETC"
  fi

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf 'using Ubuntu source: %s\n' "$file"
    base="$(basename "$file")"
    case "$base" in
      *.sources) dest="$base" ;;
      *)
        if [ "$file" = "$APT_ETC/sources.list" ]; then
          dest="ubuntu.list"
        else
          dest="$base"
        fi
        ;;
    esac
    sudo cp -f -- "$file" "$WORK/sources.list.d/$dest"
  done <<<"$found"

  end_group
}

prepare_apt_args() {
  # Every apt call gets the same restricted source set and retry policy so the
  # runner's third-party repositories and PPA entries never contribute packages.
  APT_ARGS=(
    -o Dir::Etc::sourcelist=/dev/null
    -o "Dir::Etc::sourceparts=$WORK/sources.list.d"
    -o "Dir::State::Lists=$WORK/lists"
    -o Acquire::Retries=2
  )
}

has_debs() {
  find "$1" -maxdepth 1 -type f -name '*.deb' -print -quit 2>/dev/null | grep -q .
}

download_round() {
  local round="$1"
  local update_limit="$2"
  local download_limit="$3"

  start_group "download round $round from $CURRENT_MIRROR"
  # apt-get update can exit 0 after individual sources fail, so its result is
  # informational; the download-only step is the real success signal.
  if ! run_with_budget "$update_limit" "apt-get update (round $round)" \
    sudo apt-get update "${APT_ARGS[@]}"; then
    printf '::warning::apt-get update in round %s did not complete; the download step decides\n' \
      "$round" >&2
  fi

  if run_with_budget "$download_limit" "apt-get download-only (round $round)" \
    sudo apt-get install -y --no-install-recommends --download-only \
    -o "Dir::Cache::archives=$WORK/archives" "${APT_ARGS[@]}" "${PACKAGES[@]}"; then
    end_group
    return 0
  fi

  end_group
  return 1
}

rewrite_primary_mirror() {
  local files file body primary_pattern
  start_group "switch apt mirror to $FALLBACK_MIRROR"

  files="$(grep -rlF -- "$PRIMARY_MIRROR" "$WORK/sources.list.d" 2>/dev/null || true)"
  if [ -z "$files" ]; then
    end_group
    fail "no source file contains the mirror host $PRIMARY_MIRROR, so round 2 cannot be retried"
  fi

  primary_pattern="${PRIMARY_MIRROR//./\\.}"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf 'rewriting %s\n' "$file"
    body="$(sed "s/$primary_pattern/$FALLBACK_MIRROR/g" "$file")"
    printf '%s\n' "$body" | sudo tee "$file" >/dev/null
  done <<<"$files"

  end_group
}

download_packages() {
  CURRENT_MIRROR="$PRIMARY_MIRROR"
  if download_round 1 45 90; then
    return 0
  fi

  printf '::warning::round 1 download from %s failed\n' "$PRIMARY_MIRROR" >&2
  local remaining
  remaining="$(remaining_budget)"
  if [ "$remaining" -lt 20 ]; then
    printf '::error::time budget exhausted after round 1 (%ss left); not starting round 2\n' \
      "$remaining" >&2
    return 1
  fi

  rewrite_primary_mirror
  CURRENT_MIRROR="$FALLBACK_MIRROR"
  if download_round 2 90 240; then
    return 0
  fi

  printf '::error::round 2 download from %s failed\n' "$FALLBACK_MIRROR" >&2
  return 1
}

# install_debs <directory>
# Installs the .deb files in a directory and verifies both the recorded package
# state and the dependency graph. Returns non-zero so the caller can decide
# whether a cache entry is usable.
install_debs() {
  local deb_dir="$1"
  local package status

  start_group "install packages offline from $deb_dir"
  if ! has_debs "$deb_dir"; then
    printf 'no .deb files found in %s\n' "$deb_dir" >&2
    end_group
    return 1
  fi

  if ! sudo apt-get install -y --no-install-recommends --no-download \
    "${APT_ARGS[@]}" "$deb_dir"/*.deb; then
    printf 'apt-get could not install the local .deb files from %s\n' "$deb_dir" >&2
    end_group
    return 1
  fi

  for package in "${PACKAGES[@]}"; do
    status="$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)"
    if [ "$status" != "install ok installed" ]; then
      printf '::error::package %s is not installed (status: %s)\n' \
        "$package" "${status:-missing}" >&2
      end_group
      return 1
    fi
  done

  if ! sudo apt-get check "${APT_ARGS[@]}"; then
    printf '::error::apt-get check failed after installing %s\n' "$deb_dir" >&2
    end_group
    return 1
  fi

  end_group
  return 0
}

recover_dpkg_state() {
  local audit
  audit="$(sudo dpkg --audit 2>&1 || true)"
  if [ -n "$audit" ]; then
    printf 'dpkg --audit reported unfinished work:\n%s\n' "$audit" >&2
    if ! run_with_budget 60 "dpkg --configure -a" sudo dpkg --configure -a; then
      printf '::warning::dpkg --configure -a did not finish cleanly\n' >&2
    fi
  fi
}

install_mode() {
  if [ -d "$CACHE_DIR" ] && has_debs "$CACHE_DIR"; then
    if install_debs "$CACHE_DIR"; then
      printf 'cache hit: installed packages from %s\n' "$CACHE_DIR"
      return 0
    fi
    printf '::warning::cache hit but offline install failed\n' >&2
    recover_dpkg_state
  else
    printf 'cache miss: no usable .deb files in %s\n' "$CACHE_DIR"
  fi

  if ! download_packages; then
    printf '::error::could not download packages from any mirror\n' >&2
    return 1
  fi
  if ! install_debs "$WORK/archives"; then
    printf '::error::offline install from the downloaded archives failed\n' >&2
    return 1
  fi

  printf 'installed packages from the downloaded archives\n'
  return 0
}

publish_mode() {
  if ! download_packages; then
    printf '::error::could not download packages from any mirror; cache was not written\n' >&2
    return 1
  fi

  # Validate against the downloaded archives before touching the cache. A
  # failed validation must leave the cache usable only if it was empty, which is
  # exactly what the warm-up workflow's cache miss gives us.
  if ! install_debs "$WORK/archives"; then
    printf '::error::publish validation failed; cache was not written\n' >&2
    return 1
  fi

  start_group "publish verified .deb files to $CACHE_DIR"
  rm -rf -- "$CACHE_DIR"
  mkdir -p "$CACHE_DIR"
  sudo cp -f -- "$WORK/archives"/*.deb "$CACHE_DIR"/
  sudo chown -R "$(id -u):$(id -g)" "$CACHE_DIR"
  printf 'published %s package archives\n' \
    "$(find "$CACHE_DIR" -maxdepth 1 -type f -name '*.deb' | wc -l | tr -d ' ')"
  end_group
}

main() {
  case "$MODE" in
    install | publish) ;;
    *) fail "unknown mode: $MODE (expected install or publish)" ;;
  esac

  TOTAL_STARTED="$(epoch_now)"
  load_packages
  prepare_work_tree
  prepare_apt_sources
  prepare_apt_args

  case "$MODE" in
    install) install_mode ;;
    publish) publish_mode ;;
  esac
}

main "$@"
