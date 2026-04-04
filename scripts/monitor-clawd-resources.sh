#!/usr/bin/env bash
set -euo pipefail

INTERVAL="2"
PATTERN="Clawd on Desk|clawd-on-desk|src/main.js"
TARGET_PID=""
OUTFILE=""
ONCE=0
QUIET=0

usage() {
  cat <<'EOF'
Monitor Clawd on Desk CPU and memory usage and write CSV samples.

Usage:
  bash scripts/monitor-clawd-resources.sh [options]

Options:
  --interval <seconds>  Sampling interval (default: 2)
  --pattern <regex>     pgrep -f regex for process discovery
  --pid <pid>           Monitor this PID and all descendants
  --output <path>       Output CSV path (default: logs/clawd-resource-<timestamp>.csv)
  --once                Sample once then exit
  --quiet               Do not print per-sample logs to stdout
  -h, --help            Show this help

Examples:
  bash scripts/monitor-clawd-resources.sh
  bash scripts/monitor-clawd-resources.sh --interval 1 --output ./logs/run.csv
  bash scripts/monitor-clawd-resources.sh --pid 12345
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    --pattern)
      PATTERN="${2:-}"
      shift 2
      ;;
    --pid)
      TARGET_PID="${2:-}"
      shift 2
      ;;
    --output)
      OUTFILE="${2:-}"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! awk -v n="$INTERVAL" 'BEGIN { exit !(n + 0 > 0) }'; then
  echo "--interval must be a positive number" >&2
  exit 1
fi

if [ -n "$TARGET_PID" ] && ! [[ "$TARGET_PID" =~ ^[0-9]+$ ]]; then
  echo "--pid must be a numeric PID" >&2
  exit 1
fi

if [ -z "$OUTFILE" ]; then
  ts="$(date '+%Y%m%d-%H%M%S')"
  OUTFILE="logs/clawd-resource-${ts}.csv"
fi

mkdir -p "$(dirname "$OUTFILE")"

csv_escape() {
  local v="${1//\"/\"\"}"
  printf '"%s"' "$v"
}

collect_pid_tree() {
  local root="$1"
  local -a queue=("$root")
  local -a ordered=()
  local seen=" "
  local current
  local child

  while [ "${#queue[@]}" -gt 0 ]; do
    current="${queue[0]}"
    queue=("${queue[@]:1}")
    if [[ "$seen" == *" $current "* ]]; then
      continue
    fi
    seen="${seen}${current} "
    ordered+=("$current")
    while IFS= read -r child; do
      [ -n "$child" ] && queue+=("$child")
    done < <(pgrep -P "$current" 2>/dev/null || true)
  done

  printf '%s\n' "${ordered[@]}"
}

find_target_pids() {
  if [ -n "$TARGET_PID" ]; then
    collect_pid_tree "$TARGET_PID"
  else
    pgrep -f "$PATTERN" 2>/dev/null || true
  fi | awk -v self="$$" 'NF && $0 ~ /^[0-9]+$/ && $0 != self { if (!seen[$0]++) print $0 }'
}

sample_once() {
  local timestamp epoch joined pids_csv details_csv
  local total_cpu total_rss_kb total_rss_mb pid_count
  local pids=()
  local ps_rows
  local line pid cpu rss_kb cmd rss_mb
  local detail_parts=()

  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  epoch="$(date '+%s')"

  while IFS= read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done < <(find_target_pids)

  pid_count="${#pids[@]}"
  total_cpu="0.00"
  total_rss_kb=0

  if [ "$pid_count" -gt 0 ]; then
    joined="$(IFS=,; echo "${pids[*]}")"
    ps_rows="$(ps -p "$joined" -o pid=,pcpu=,rss=,command= 2>/dev/null || true)"

    if [ -n "$ps_rows" ]; then
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        pid="$(awk '{print $1}' <<<"$line")"
        cpu="$(awk '{print $2}' <<<"$line")"
        rss_kb="$(awk '{print $3}' <<<"$line")"
        cmd="$(awk '{$1=$2=$3=""; sub(/^ +/, ""); print}' <<<"$line")"

        total_cpu="$(awk -v a="$total_cpu" -v b="$cpu" 'BEGIN { printf "%.2f", a + b }')"
        total_rss_kb=$((total_rss_kb + rss_kb))
        rss_mb="$(awk -v n="$rss_kb" 'BEGIN { printf "%.2f", n / 1024 }')"
        detail_parts+=("pid=${pid} cpu=${cpu}% rssMB=${rss_mb} cmd=${cmd}")
      done <<<"$ps_rows"
    fi
  fi

  total_rss_mb="$(awk -v n="$total_rss_kb" 'BEGIN { printf "%.2f", n / 1024 }')"
  pids_csv="$(csv_escape "$(IFS='|'; echo "${pids[*]:-}")")"
  details_csv="$(csv_escape "$(IFS=' ; '; echo "${detail_parts[*]:-}")")"

  printf '%s,%s,%s,%s,%s,%s,%s\n' \
    "$timestamp" "$epoch" "$pid_count" "$total_cpu" "$total_rss_mb" "$pids_csv" "$details_csv" \
    >> "$OUTFILE"

  if [ "$QUIET" -eq 0 ]; then
    echo "[$timestamp] pids=${pid_count} cpu=${total_cpu}% mem=${total_rss_mb}MB"
  fi
}

printf 'timestamp,epoch,pid_count,total_cpu_percent,total_rss_mb,pids,details\n' > "$OUTFILE"

if [ "$QUIET" -eq 0 ]; then
  echo "Monitoring started. Output: $OUTFILE"
  if [ -n "$TARGET_PID" ]; then
    echo "Tracking PID tree from root PID: $TARGET_PID"
  else
    echo "Discovery pattern: $PATTERN"
  fi
fi

on_exit() {
  if [ "$QUIET" -eq 0 ]; then
    echo ""
    echo "Monitoring stopped. CSV saved at: $OUTFILE"
  fi
}
trap on_exit EXIT

while true; do
  sample_once
  if [ "$ONCE" -eq 1 ]; then
    break
  fi
  sleep "$INTERVAL"
done
