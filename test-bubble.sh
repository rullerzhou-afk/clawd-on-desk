#!/usr/bin/env bash
# 发送模拟权限请求测试气泡堆叠 / 复现 below-pet ↔ degraded 分支翻转 bug
#
# 用法:
#   bash test-bubble.sh           # 发 2+6 个气泡, 回车后自动清理
#   bash test-bubble.sh send      # 同上
#   bash test-bubble.sh clean     # 只清理上次留下的 curl
#
# 复现要点:
#   - 宠物窗口放屏幕中部, bubbleFollowPet 已开启
#   - 第 1 波 2 个气泡走 below-pet 分支, 紧贴宠物下方
#   - 第 2 波累计 8 个, totalH 跨过 wa.height/2 → flip 到 degraded 分支
#     视觉上整堆气泡瞬移到屏幕右下角, 且新旧顺序整个翻转

set -u

PORT="${CLAWD_PORT:-23333}"
URL="http://127.0.0.1:${PORT}/permission"
PID_FILE="/tmp/clawd-test-bubble-pids.txt"

send_one() {
  local sid="$1" cmd="$2"
  curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$cmd\"},\"session_id\":\"$sid\",\"permission_suggestions\":[]}" \
    >/dev/null &
  echo $! >> "$PID_FILE"
}

clean_all() {
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do kill "$pid" 2>/dev/null; done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # safety net: nuke any leftover curls hitting /permission
  pkill -f "curl.*${PORT}/permission" 2>/dev/null || true
  echo "cleaned"
}

case "${1:-send}" in
  clean)
    clean_all
    exit 0
    ;;
  send)
    rm -f "$PID_FILE"
    echo "wave 1: 2 bubbles (should land below pet)"
    send_one drift-test-1 "echo first bubble"
    send_one drift-test-2 "ls -la /tmp"
    sleep 1.5
    echo "wave 2: 6 more bubbles (totalH should cross wa.height/2 → flip)"
    send_one drift-test-3 "git status"
    send_one drift-test-4 "npm run build && echo done"
    send_one drift-test-5 "find . -name '*.js' -type f"
    send_one drift-test-6 "grep -r TODO src/"
    send_one drift-test-7 "cat /etc/hosts | head -20"
    send_one drift-test-8 "ps aux | grep electron | head -5"
    echo "all 8 sent. press Enter to clean up, or Ctrl-C then run 'bash test-bubble.sh clean'"
    read -r _
    clean_all
    ;;
  *)
    echo "usage: bash test-bubble.sh [send|clean]" >&2
    exit 1
    ;;
esac
