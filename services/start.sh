#!/usr/bin/env bash
# 启动 Mac 本地推理服务（services/app.py）。
#
# 只监听 127.0.0.1，PID 写入 services/.runtime/app.pid。
# 重复执行能识别已运行实例，不会重复拉起；不使用 pkill -f 等宽泛停止方式。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
VENV_PY="$REPO_ROOT/.venv/bin/python"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
RUNTIME_DIR="$SERVICES_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/app.pid"
LOG_FILE="$RUNTIME_DIR/app.log"
URL="http://${HOST}:${PORT}"

mkdir -p "$RUNTIME_DIR"

if [ ! -x "$VENV_PY" ]; then
  echo "未找到虚拟环境：$VENV_PY" >&2
  echo "请先执行：python3.11 -m venv .venv && .venv/bin/pip install -r requirements-mac.txt" >&2
  exit 1
fi

# ---- 已运行实例识别（同款四项校验，与 mastra-agent/scripts/rerank-up.sh 一致）----
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$OLD_PID" ]; then
    echo "PID 文件为空，按陈旧记录清理。"
    rm -f "$PID_FILE"
  elif ! kill -0 "$OLD_PID" 2>/dev/null; then
    echo "PID $OLD_PID 已不存在，清理陈旧 PID 文件。"
    rm -f "$PID_FILE"
  else
    CMD="$(ps -o command= -p "$OLD_PID" 2>/dev/null || true)"
    PROBLEMS=""
    if ! printf '%s' "$CMD" | grep -q "uvicorn"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含 uvicorn\n"
    fi
    if ! printf '%s' "$CMD" | grep -q "app:app\|services.app\|services/app"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含本项目 app\n"
    fi
    if ! curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
      PROBLEMS="${PROBLEMS}  - 健康检查 ${URL}/health 不可达\n"
    fi
    if [ -z "$PROBLEMS" ]; then
      GGUF_MANIFEST_PATH="${GGUF_MANIFEST_PATH:-$SERVICES_DIR/manifests/customer-service-production-v1.gguf.json}"
      ADAPTER_SCALE="${ADAPTER_SCALE:-1.0}"
      if READY_OUT="$("$VENV_PY" "$SERVICES_DIR/check_fastapi_ready.py" \
            --url "${URL}/health" --manifest "$GGUF_MANIFEST_PATH" --expected-scale "$ADAPTER_SCALE" 2>&1)"; then
        echo "服务已在运行（PID $OLD_PID），就绪判定（backend/身份/SHA）通过，不重复启动。"
        echo "$READY_OUT"
        exit 0
      else
        PROBLEMS="${PROBLEMS}  - 就绪判定未通过：\n$(echo "$READY_OUT" | sed 's/^/    /')\n"
      fi
    fi
    {
      echo "PID 文件指向存活进程 $OLD_PID，但校验未通过："
      printf '%s' "$PROBLEMS"
      echo "  实际命令行：$CMD"
      echo "为避免误接管，本脚本不接管、不停止该进程，也不删除该 PID 文件。"
    } >&2
    exit 1
  fi
fi

echo "启动推理服务：$URL"
cd "$REPO_ROOT"
nohup "$VENV_PY" -m uvicorn services.app:app --host "$HOST" --port "$PORT" \
  --app-dir "$REPO_ROOT" >"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "PID $NEW_PID -> $PID_FILE"

echo -n "等待服务就绪"
for _ in $(seq 1 60); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo " -> 进程已退出"
    echo "启动失败，日志尾部：" >&2
    tail -30 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
    echo " -> 就绪"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
  echo " -> 超时"
  echo "服务在 60 秒内未就绪，日志尾部：" >&2
  tail -30 "$LOG_FILE" >&2
  exit 1
fi

curl -s "${URL}/health" | "$VENV_PY" -m json.tool

# ---- 就绪判定：不能只看 HTTP 200，必须解析 /health 并核对
# backend/fastapi_loaded/upstream_health/upstream_identity/adapter_scale，
# 再拿 manifest 文件独立复核 SHA-256（不只信任 FastAPI 自己上报的状态）。
GGUF_MANIFEST_PATH="${GGUF_MANIFEST_PATH:-$SERVICES_DIR/manifests/customer-service-production-v1.gguf.json}"
ADAPTER_SCALE="${ADAPTER_SCALE:-1.0}"
if ! "$VENV_PY" "$SERVICES_DIR/check_fastapi_ready.py" \
      --url "${URL}/health" --manifest "$GGUF_MANIFEST_PATH" --expected-scale "$ADAPTER_SCALE"; then
  echo "FastAPI 未真正就绪，停止刚启动的进程并报告：" >&2
  kill "$NEW_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "服务就绪：$URL"
