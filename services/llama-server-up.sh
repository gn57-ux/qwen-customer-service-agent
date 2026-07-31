#!/usr/bin/env bash
# 启动 Mac 长期推理后端（llama.cpp llama-server，Apple Metal）。
#
# 只监听 127.0.0.1:8002（内部端口，FastAPI 是唯一对外入口，端口 8000）。
# PID 写入 services/.runtime/llama-server.pid。重复执行能识别已运行实例，
# 不会重复拉起；不使用 pkill -f 等宽泛停止方式。
#
# manifest 缺失/不可解析/字段缺失/SHA 不一致/revision 不符/adapter_scale 不等于
# 1.0 —— 一律 exit 1，不允许跳过校验、不允许"警告后继续"。
# 服务就绪前必须完成 upstream 身份校验（/health + /lora-adapters + /props），
# 不只是 HTTP 200 就算数。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
VENV_PY="${VENV_PY:-$REPO_ROOT/.venv/bin/python}"
GGUF_DIR="${GGUF_DIR:-$REPO_ROOT/models/gguf/qwen3-8b-production-v1}"
GGUF_MANIFEST_PATH="${GGUF_MANIFEST_PATH:-$SERVICES_DIR/manifests/customer-service-production-v1.gguf.json}"
EXPECTED_BASE_REVISION="${EXPECTED_BASE_REVISION:-b968826d9c46dd6066d109eabc6255188de91218}"
ADAPTER_SCALE="${ADAPTER_SCALE:-1.0}"
HOST="127.0.0.1"
PORT="${LLAMA_CPP_PORT:-8002}"
CTX_SIZE="${LLAMA_CTX_SIZE:-4096}"
RUNTIME_DIR="$SERVICES_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/llama-server.pid"
LOG_FILE="$RUNTIME_DIR/llama-server.log"
URL="http://${HOST}:${PORT}"

mkdir -p "$RUNTIME_DIR"

if [ ! -x "$VENV_PY" ]; then
  echo "未找到虚拟环境 Python：$VENV_PY" >&2
  exit 1
fi

# ---- 0. manifest 硬校验（先于一切）-----------------------------------------
# 复用 llama_cpp_backend.py 的校验逻辑（同一份代码，pytest 已覆盖），
# 不在 bash 里重新解析 JSON。manifest 缺失/不可解析/字段缺失/SHA 不符/
# revision 不符/adapter_scale 不符——任一失败 exit 1，不允许跳过。
echo "校验 manifest：$GGUF_MANIFEST_PATH"
MANIFEST_CHECK_OUT="$("$VENV_PY" "$SERVICES_DIR/check_llama_server_identity.py" \
  --mode manifest \
  --gguf-dir "$GGUF_DIR" \
  --manifest "$GGUF_MANIFEST_PATH" \
  --expected-revision "$EXPECTED_BASE_REVISION" \
  --expected-scale "$ADAPTER_SCALE" 2>&1)" || {
    echo "$MANIFEST_CHECK_OUT" >&2
    echo "manifest 校验未通过，拒绝启动。" >&2
    exit 1
  }
echo "$MANIFEST_CHECK_OUT" | grep '^\[PASS\]'
ADAPTER_BASENAME="$(echo "$MANIFEST_CHECK_OUT" | sed -n 's/^ADAPTER_BASENAME=//p')"
if [ -z "$ADAPTER_BASENAME" ]; then
  echo "未能从校验结果中取到 ADAPTER_BASENAME，拒绝启动。" >&2
  exit 1
fi

BASE_MODEL="$GGUF_DIR/$("$VENV_PY" -c "
import json
m = json.load(open('$GGUF_MANIFEST_PATH'))
print(m['gguf']['base_q4_k_m']['file'])
")"
LORA_ADAPTER="$GGUF_DIR/$ADAPTER_BASENAME"
BASE_BASENAME="$(basename "$BASE_MODEL")"

check_upstream_identity() {
  "$VENV_PY" "$SERVICES_DIR/check_llama_server_identity.py" \
    --mode upstream --base-url "$URL" --timeout 5 \
    --adapter-basename "$ADAPTER_BASENAME" --expected-scale "$ADAPTER_SCALE"
}

# ---- 1. 已运行实例识别 -----------------------------------------------------
# 只有以下**同时**满足才认定"是本脚本托管、且身份正确的实例"：
#   1) PID 存活  2) 命令行含 llama-server
#   3) 命令行含当前 Base/Adapter 的 basename 与端口
#   4) upstream 身份校验通过（health + lora-adapters + props，不只是 HTTP 200）
# 任一不满足且进程仍存活时：不接管、不停止、不删除该 PID 文件，直接报错退出非零。
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
    if ! printf '%s' "$CMD" | grep -q "llama-server"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含 llama-server\n"
    fi
    if ! printf '%s' "$CMD" | grep -q "$BASE_BASENAME"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含本项目 Base 模型 ${BASE_BASENAME}\n"
    fi
    if ! printf '%s' "$CMD" | grep -q "$ADAPTER_BASENAME"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含本项目 LoRA Adapter ${ADAPTER_BASENAME}\n"
    fi
    if ! printf '%s' "$CMD" | grep -q "$PORT"; then
      PROBLEMS="${PROBLEMS}  - 命令行不含端口 ${PORT}\n"
    fi
    if [ -z "$PROBLEMS" ]; then
      if IDENTITY_OUT="$(check_upstream_identity 2>&1)"; then
        echo "llama-server 已在运行（PID $OLD_PID），命令行与 upstream 身份校验均通过，不重复启动。"
        echo "$IDENTITY_OUT" | grep '^\[PASS\]'
        exit 0
      else
        PROBLEMS="${PROBLEMS}  - upstream 身份校验未通过：\n$(echo "$IDENTITY_OUT" | sed 's/^/    /')\n"
      fi
    fi
    {
      echo "PID 文件指向存活进程 $OLD_PID，但校验未通过："
      printf '%s' "$PROBLEMS"
      echo "  实际命令行：$CMD"
      echo "为避免误接管或误杀，本脚本不接管、不停止该进程，也不删除该 PID 文件。"
    } >&2
    exit 1
  fi
fi

if curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
  echo "端口 ${PORT} 上已有服务在响应，但没有本脚本记录的 PID 文件。"
  echo "为避免误管理他人进程，这里不接管、不停止该进程。"
  exit 1
fi

# ---- 2. 前置检查 -----------------------------------------------------------
if ! command -v llama-server >/dev/null 2>&1; then
  echo "未找到 llama-server。请先安装：brew install llama.cpp" >&2
  exit 1
fi

# ---- 3. 启动 ---------------------------------------------------------------
echo "启动 llama-server：Base=$BASE_BASENAME LoRA=$ADAPTER_BASENAME port=$PORT ctx=$CTX_SIZE"
nohup llama-server \
  --model "$BASE_MODEL" \
  --lora "$LORA_ADAPTER" \
  --host "$HOST" \
  --port "$PORT" \
  --ctx-size "$CTX_SIZE" \
  --parallel 1 \
  --reasoning off \
  >"$LOG_FILE" 2>&1 &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "PID $NEW_PID -> $PID_FILE"

echo -n "等待服务就绪"
for _ in $(seq 1 90); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo " -> 进程已退出"
    echo "启动失败，日志尾部：" >&2
    tail -30 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
    echo " -> health 200"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -fsS --max-time 2 "${URL}/health" >/dev/null 2>&1; then
  echo " -> 超时"
  echo "服务在 90 秒内未就绪，日志尾部：" >&2
  tail -30 "$LOG_FILE" >&2
  exit 1
fi

# ---- 4. 就绪前必须完成 upstream 身份校验（不只是 HTTP 200）-----------------
echo "校验 upstream 身份（/health + /lora-adapters + /props）..."
if ! IDENTITY_OUT="$(check_upstream_identity 2>&1)"; then
  echo "$IDENTITY_OUT" >&2
  echo "刚启动的实例未通过身份校验（可能没有真正挂上 LoRA），停止该进程并报告：" >&2
  kill "$NEW_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  tail -30 "$LOG_FILE" >&2
  exit 1
fi
echo "$IDENTITY_OUT" | grep '^\[PASS\]'

echo "llama-server 就绪：$URL（内部端口，仅供 FastAPI 调用）"
