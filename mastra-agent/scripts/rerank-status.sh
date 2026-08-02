#!/usr/bin/env bash
# 查看本地 Reranker 状态：PID 文件、进程校验、健康检查、模型信息。
set -uo pipefail

MASTRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${RERANK_MODEL_PATH:-$MASTRA_ROOT/.models/bge-reranker-v2-m3-Q8_0.gguf}"
PORT="${RERANK_PORT:-8787}"
URL="http://127.0.0.1:${PORT}"
PID_FILE="$MASTRA_ROOT/.runtime/rerank-server.pid"

echo "Reranker 状态"
echo "  端点        : $URL"
echo -n "  模型文件    : "
if [ -f "$MODEL" ]; then
  echo "$(basename "$MODEL")（$(stat -f%z "$MODEL") 字节）"
else
  echo "缺失：$MODEL"
fi

echo -n "  PID 文件    : "
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  echo "$PID_FILE -> PID $PID"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    CMD="$(ps -o command= -p "$PID" 2>/dev/null || true)"
    echo "  进程        : 存活"
    if printf '%s' "$CMD" | grep -q "llama-server" && \
       printf '%s' "$CMD" | grep -q "$(basename "$MODEL")"; then
      echo "  命令行校验  : 通过（llama-server + 本项目模型）"
    else
      echo "  命令行校验  : 未通过 —— rerank:down 会拒绝停止它"
    fi
  else
    echo "  进程        : 不存在（PID 文件为陈旧记录）"
  fi
else
  echo "无（本脚本未托管任何进程）"
fi

echo -n "  健康检查    : "
if curl -fsS --max-time 3 "${URL}/health" >/dev/null 2>&1; then
  echo "通过"
else
  echo "不可达"
  exit 1
fi
