#!/usr/bin/env bash
# 停止 Mac 本地推理服务（FastAPI/uvicorn）。kill 前必须同时校验：命令行含
# uvicorn、命令行含 services.app 或 app:app、命令行含端口——三项缺一不可；
# 不满足则拒绝停止且保留 PID 文件。不使用 pkill -f 等宽泛匹配方式。
# SIGTERM 超时后的 SIGKILL 只允许在重新通过全部身份校验后执行
# （防止等待期间 PID 被其他进程复用）。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SERVICES_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/app.pid"
PORT="${PORT:-8000}"

if [ ! -f "$PID_FILE" ]; then
  echo "未找到 PID 文件：$PID_FILE（服务可能未运行）"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  echo "PID 文件为空，清理。"
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID 已不存在，清理陈旧 PID 文件。"
  rm -f "$PID_FILE"
  exit 0
fi

verify_identity() {
  local pid="$1"
  local cmd problems=""
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if [ -z "$cmd" ]; then
    echo "PID $pid 命令行为空（进程可能已退出）" >&2
    return 1
  fi
  if ! printf '%s' "$cmd" | grep -q "uvicorn"; then
    problems="${problems}  - 命令行不含 uvicorn\n"
  fi
  if ! printf '%s' "$cmd" | grep -qE "services\.app|app:app"; then
    problems="${problems}  - 命令行不含 services.app 或 app:app\n"
  fi
  if ! printf '%s' "$cmd" | grep -q "$PORT"; then
    problems="${problems}  - 命令行不含端口 ${PORT}\n"
  fi
  if [ -n "$problems" ]; then
    {
      echo "PID $pid 身份校验未通过（可能是 PID 被复用）："
      printf '%s' "$problems"
      echo "  实际命令行：$cmd"
    } >&2
    return 1
  fi
  return 0
}

if ! verify_identity "$PID"; then
  echo "为避免误杀，本脚本不停止该进程，也不删除 PID 文件。" >&2
  exit 1
fi

echo "停止服务：PID $PID"
kill "$PID"
for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || { echo "已停止"; rm -f "$PID_FILE"; exit 0; }
  sleep 0.5
done

echo "进程未在 10 秒内退出，SIGKILL 前重新校验身份（防止等待期间 PID 被复用）" >&2
if ! verify_identity "$PID"; then
  echo "重新校验未通过，拒绝 SIGKILL，也不删除 PID 文件，请人工确认。" >&2
  exit 1
fi
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
