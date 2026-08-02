#!/usr/bin/env bash
# 停止 llama-server。kill 前必须同时校验：命令行含 llama-server、
# Base GGUF basename、LoRA GGUF basename、端口——四项缺一不可；
# 不满足则拒绝停止且保留 PID 文件。不使用 pkill -f 等宽泛匹配方式。
# SIGTERM 超时后的 SIGKILL 只允许在重新通过全部身份校验后执行
# （防止等待期间 PID 被其他进程复用）。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
VENV_PY="${VENV_PY:-$REPO_ROOT/.venv/bin/python}"
GGUF_DIR="${GGUF_DIR:-$REPO_ROOT/models/gguf/qwen3-8b-production-v1}"
GGUF_MANIFEST_PATH="${GGUF_MANIFEST_PATH:-$SERVICES_DIR/manifests/customer-service-production-v1.gguf.json}"
PORT="${LLAMA_CPP_PORT:-8002}"
RUNTIME_DIR="$SERVICES_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/llama-server.pid"

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

# 期望的 Base/LoRA basename 从 manifest 读取（与 up.sh 同一份事实来源）。
# manifest 不存在时是明确的"未部署 GGUF"场景，允许退化为弱校验（只查
# llama-server + 端口）；但 manifest **存在却解析不出 basename**是异常状态
# （文件损坏、VENV_PY 配置错、字段被改坏……），必须直接拒绝停止，
# 不能静默退化成弱校验——那等于允许 PID 复用绕过 Base/LoRA 校验。
BASE_BASENAME=""
LORA_BASENAME=""
if [ -f "$GGUF_MANIFEST_PATH" ]; then
  if [ ! -x "$VENV_PY" ]; then
    echo "manifest 存在（$GGUF_MANIFEST_PATH）但找不到 VENV_PY（$VENV_PY），无法解析期望的 Base/LoRA basename。" >&2
    echo "拒绝停止：不允许在无法确认身份的情况下继续。" >&2
    exit 1
  fi
  MANIFEST_PY_OUT="$("$VENV_PY" -c "
import json, sys
m = json.load(open('$GGUF_MANIFEST_PATH'))
print(m['gguf']['base_q4_k_m']['file'])
print(m['gguf']['adapter_lora']['file'])
" 2>&1)" || {
    echo "manifest 存在但解析失败：" >&2
    echo "$MANIFEST_PY_OUT" >&2
    echo "拒绝停止：不允许在无法确认身份的情况下继续。" >&2
    exit 1
  }
  BASE_BASENAME="$(echo "$MANIFEST_PY_OUT" | sed -n '1p')"
  LORA_BASENAME="$(echo "$MANIFEST_PY_OUT" | sed -n '2p')"
  if [ -z "$BASE_BASENAME" ] || [ -z "$LORA_BASENAME" ]; then
    echo "manifest 解析出的 Base/LoRA basename 为空，拒绝停止。" >&2
    exit 1
  fi
fi

verify_identity() {
  local pid="$1"
  local cmd problems=""
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if [ -z "$cmd" ]; then
    echo "PID $pid 命令行为空（进程可能已退出）" >&2
    return 1
  fi
  if ! printf '%s' "$cmd" | grep -q "llama-server"; then
    problems="${problems}  - 命令行不含 llama-server\n"
  fi
  if [ -n "$BASE_BASENAME" ] && ! printf '%s' "$cmd" | grep -q "$BASE_BASENAME"; then
    problems="${problems}  - 命令行不含 Base ${BASE_BASENAME}\n"
  fi
  if [ -n "$LORA_BASENAME" ] && ! printf '%s' "$cmd" | grep -q "$LORA_BASENAME"; then
    problems="${problems}  - 命令行不含 LoRA ${LORA_BASENAME}\n"
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

echo "停止 llama-server：PID $PID"
kill "$PID"
for _ in $(seq 1 30); do
  kill -0 "$PID" 2>/dev/null || { echo "已停止"; rm -f "$PID_FILE"; exit 0; }
  sleep 0.5
done

echo "进程未在 15 秒内退出，SIGKILL 前重新校验身份（防止等待期间 PID 被复用）" >&2
if ! verify_identity "$PID"; then
  echo "重新校验未通过，拒绝 SIGKILL，也不删除 PID 文件，请人工确认。" >&2
  exit 1
fi
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
