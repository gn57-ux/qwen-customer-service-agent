#!/usr/bin/env bash
# 报告 llama-server 当前状态：PID / 命令行校验 / 端口 / 健康检查 / 模型绑定。
set -uo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
GGUF_DIR="${GGUF_DIR:-$REPO_ROOT/models/gguf/qwen3-8b-production-v1}"
PORT="${LLAMA_CPP_PORT:-8002}"
RUNTIME_DIR="$SERVICES_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/llama-server.pid"
URL="http://127.0.0.1:${PORT}"

echo "llama-server 状态"
echo "  端点        : $URL"
echo "  Base GGUF   : $GGUF_DIR/qwen3-8b-production-v1-Q4_K_M.gguf"
echo "  LoRA GGUF   : $GGUF_DIR/customer-service-production-v1-lora.gguf"

if [ ! -f "$PID_FILE" ]; then
  echo "  PID 文件    : 不存在（未通过本脚本启动，或已停止）"
else
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  echo "  PID 文件    : $PID_FILE -> PID $PID"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "  进程        : 存活"
    CMD="$(ps -o command= -p "$PID" 2>/dev/null || true)"
    if printf '%s' "$CMD" | grep -q "llama-server" && printf '%s' "$CMD" | grep -q "lora"; then
      echo "  命令行校验  : 通过（llama-server + --lora）"
    else
      echo "  命令行校验  : 未通过（可能不是本项目实例）"
    fi
  else
    echo "  进程        : 不存活（PID 文件陈旧）"
  fi
fi

if curl -fsS --max-time 3 "${URL}/health" >/dev/null 2>&1; then
  echo "  健康检查    : 通过"
  curl -s "${URL}/health"
  echo
else
  echo "  健康检查    : 不可达"
fi
