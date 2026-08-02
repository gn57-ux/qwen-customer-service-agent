#!/usr/bin/env bash
# llama-server-down.sh 与 stop.sh 的 PID 安全自检（沙箱化）：覆盖 PID 复用、
# 命令行部分匹配（含关键词但缺 Base/LoRA/端口之一）两类场景，
# 证明"任一不符即拒绝停止且保留 PID 文件"。
set -uo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
REAL_VENV_PY="$REPO_ROOT/.venv/bin/python"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/stop-scripts-selftest.XXXXXX")"
SPAWNED_PIDS=""
PASS=0
FAIL=0

cleanup() {
  for p in $SPAWNED_PIDS; do
    kill -0 "$p" 2>/dev/null && kill "$p" 2>/dev/null
  done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

echo "沙箱：$SANDBOX"
echo

# ===========================================================================
echo "===== llama-server-down.sh ====="
# ===========================================================================
mkdir -p "$SANDBOX/llama/services/.runtime"
cp "$SERVICES_DIR/llama-server-down.sh" "$SANDBOX/llama/services/"
mkdir -p "$SANDBOX/llama/services/manifests"
python3 - "$SANDBOX/llama/services/manifests/customer-service-production-v1.gguf.json" <<'PY'
import json, sys
json.dump({"gguf": {
    "base_q4_k_m": {"file": "base.gguf"},
    "adapter_lora": {"file": "lora.gguf"},
}}, open(sys.argv[1], "w"))
PY

# 用例 1：PID 复用——目标 PID 存活，但命令行是完全无关的进程（不含任何关键词）
echo "用例 1：PID 复用（命令行与 llama-server 完全无关）→ 拒绝停止"
sleep 600 &
UNRELATED=$!
SPAWNED_PIDS="$SPAWNED_PIDS $UNRELATED"
echo "$UNRELATED" > "$SANDBOX/llama/services/.runtime/llama-server.pid"
VENV_PY="$REAL_VENV_PY" GGUF_MANIFEST_PATH="$SANDBOX/llama/services/manifests/customer-service-production-v1.gguf.json" \
  bash "$SANDBOX/llama/services/llama-server-down.sh" >"$SANDBOX/out1.txt" 2>"$SANDBOX/err1.txt"
RC=$?
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
[ -f "$SANDBOX/llama/services/.runtime/llama-server.pid" ] && ok "PID 文件被保留" || bad "PID 文件被误删"
kill -0 "$UNRELATED" 2>/dev/null && ok "无关进程未被杀" || bad "无关进程被杀了"
grep -q "命令行不含 llama-server" "$SANDBOX/err1.txt" && ok "报错指出缺 llama-server 关键词" || bad "未报告原因"
kill "$UNRELATED" 2>/dev/null; wait "$UNRELATED" 2>/dev/null
echo

# 用例 2：命令行部分匹配——含 llama-server 与端口，但缺 LoRA basename
echo "用例 2：命令行含 llama-server+端口，但缺 LoRA basename → 拒绝停止"
bash -c 'exec -a "llama-server --model base.gguf --port 8002" sleep 600' &
PARTIAL=$!
SPAWNED_PIDS="$SPAWNED_PIDS $PARTIAL"
sleep 0.3
PARTIAL_CMD="$(ps -o command= -p "$PARTIAL" 2>/dev/null || true)"
if printf '%s' "$PARTIAL_CMD" | grep -q "llama-server"; then
  echo "$PARTIAL" > "$SANDBOX/llama/services/.runtime/llama-server.pid"
  VENV_PY="$REAL_VENV_PY" LLAMA_CPP_PORT=8002 GGUF_MANIFEST_PATH="$SANDBOX/llama/services/manifests/customer-service-production-v1.gguf.json" \
    bash "$SANDBOX/llama/services/llama-server-down.sh" >"$SANDBOX/out2.txt" 2>"$SANDBOX/err2.txt"
  RC=$?
  [ "$RC" != "0" ] && ok "退出码非零（缺 LoRA basename）" || bad "不应成功"
  grep -q "命令行不含 LoRA" "$SANDBOX/err2.txt" && ok "报错指出缺 LoRA basename" || bad "未指出缺 LoRA：$(cat "$SANDBOX/err2.txt")"
  kill -0 "$PARTIAL" 2>/dev/null && ok "部分匹配进程未被杀" || bad "被误杀了"
else
  echo "  SKIP  本机 exec -a 无法伪造命令行，跳过"
fi
kill "$PARTIAL" 2>/dev/null; wait "$PARTIAL" 2>/dev/null
echo

# 用例 3：PID 已死 -> 清理陈旧记录
echo "用例 3：PID 已退出 → 清理陈旧 PID 文件，退出码 0"
sleep 0.1 & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "$SANDBOX/llama/services/.runtime/llama-server.pid"
VENV_PY="$REAL_VENV_PY" bash "$SANDBOX/llama/services/llama-server-down.sh" >"$SANDBOX/out3.txt" 2>"$SANDBOX/err3.txt"
RC=$?
[ "$RC" = "0" ] && ok "退出码为 0" || bad "应为 0"
[ ! -f "$SANDBOX/llama/services/.runtime/llama-server.pid" ] && ok "陈旧 PID 文件被清理" || bad "未清理"
echo

# ===========================================================================
echo "===== stop.sh ====="
# ===========================================================================
mkdir -p "$SANDBOX/fastapi/services/.runtime"
cp "$SERVICES_DIR/stop.sh" "$SANDBOX/fastapi/services/"

echo "用例 4：PID 复用（命令行与 uvicorn 完全无关）→ 拒绝停止"
sleep 600 &
UNRELATED2=$!
SPAWNED_PIDS="$SPAWNED_PIDS $UNRELATED2"
echo "$UNRELATED2" > "$SANDBOX/fastapi/services/.runtime/app.pid"
bash "$SANDBOX/fastapi/services/stop.sh" >"$SANDBOX/out4.txt" 2>"$SANDBOX/err4.txt"
RC=$?
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
[ -f "$SANDBOX/fastapi/services/.runtime/app.pid" ] && ok "PID 文件被保留" || bad "PID 文件被误删"
kill -0 "$UNRELATED2" 2>/dev/null && ok "无关进程未被杀" || bad "无关进程被杀了"
kill "$UNRELATED2" 2>/dev/null; wait "$UNRELATED2" 2>/dev/null
echo

echo "用例 5：命令行含 uvicorn，但缺 services.app/app:app → 拒绝停止"
bash -c 'exec -a "uvicorn some.other.app --port 8000" sleep 600' &
PARTIAL2=$!
SPAWNED_PIDS="$SPAWNED_PIDS $PARTIAL2"
sleep 0.3
PARTIAL2_CMD="$(ps -o command= -p "$PARTIAL2" 2>/dev/null || true)"
if printf '%s' "$PARTIAL2_CMD" | grep -q "uvicorn"; then
  echo "$PARTIAL2" > "$SANDBOX/fastapi/services/.runtime/app.pid"
  bash "$SANDBOX/fastapi/services/stop.sh" >"$SANDBOX/out5.txt" 2>"$SANDBOX/err5.txt"
  RC=$?
  [ "$RC" != "0" ] && ok "退出码非零（缺 app 标识）" || bad "不应成功"
  grep -q "不含 services.app 或 app:app" "$SANDBOX/err5.txt" && ok "报错指出缺 app 标识" || bad "未指出：$(cat "$SANDBOX/err5.txt")"
  kill -0 "$PARTIAL2" 2>/dev/null && ok "部分匹配进程未被杀" || bad "被误杀了"
else
  echo "  SKIP  本机 exec -a 无法伪造命令行，跳过"
fi
kill "$PARTIAL2" 2>/dev/null; wait "$PARTIAL2" 2>/dev/null
echo

echo "自检结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
