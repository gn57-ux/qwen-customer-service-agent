#!/usr/bin/env bash
# 停止本地 Reranker。
#
# 安全约束（Review 要求）：
# - 只停止 .runtime/rerank-server.pid 记录的 PID；
# - 停止前必须校验该 PID 的命令行同时包含 llama-server 与本项目的模型路径；
# - 禁止 pkill -f / killall 这类宽泛匹配，避免误杀用户其他进程。
set -euo pipefail

MASTRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${RERANK_MODEL_PATH:-$MASTRA_ROOT/.models/bge-reranker-v2-m3-Q8_0.gguf}"
PID_FILE="$MASTRA_ROOT/.runtime/rerank-server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "没有 PID 文件（$PID_FILE），本脚本没有托管中的 Reranker 进程，不做任何操作。"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  echo "PID 文件为空，已清理。"
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID 已不存在，清理 PID 文件。"
  rm -f "$PID_FILE"
  exit 0
fi

CMD="$(ps -o command= -p "$PID" 2>/dev/null || true)"
MODEL_BASENAME="$(basename "$MODEL")"

if ! printf '%s' "$CMD" | grep -q "llama-server"; then
  echo "拒绝停止：PID $PID 的命令行不含 llama-server。" >&2
  echo "  实际命令行：$CMD" >&2
  echo "  为避免误杀无关进程，这里不执行 kill。请人工确认后处理。" >&2
  exit 1
fi

if ! printf '%s' "$CMD" | grep -q "$MODEL_BASENAME"; then
  echo "拒绝停止：PID $PID 是 llama-server，但加载的不是本项目模型 $MODEL_BASENAME。" >&2
  echo "  实际命令行：$CMD" >&2
  exit 1
fi

echo "停止 Reranker：PID $PID"
kill "$PID"

for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "已停止，PID 文件已清理。"
    exit 0
  fi
  sleep 1
done

echo "进程 $PID 在 30 秒内未退出。未升级为强制终止，请人工确认后处理。" >&2
exit 1
