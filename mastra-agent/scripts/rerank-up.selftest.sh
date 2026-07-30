#!/usr/bin/env bash
# rerank-up.sh 的"已运行实例识别"逻辑自检。
#
# 安全前提：全部用例都在临时沙箱里跑 —— 把 rerank-up.sh 复制到
# $SANDBOX/scripts/ 后，脚本算出的 MASTRA_ROOT 就是沙箱，PID 文件是
# $SANDBOX/.runtime/rerank-server.pid，**不会读写真实 .runtime/，
# 也不会碰真实 Reranker 进程**。只有最后一个用例在只读意义上调用真实脚本
# （四项校验通过时它只打印并 exit 0，不启动、不停止任何进程）。
set -uo pipefail

MASTRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_SCRIPT="$MASTRA_ROOT/scripts/rerank-up.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/rerank-selftest.XXXXXX")"
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

mkdir -p "$SANDBOX/scripts"
cp "$REAL_SCRIPT" "$SANDBOX/scripts/rerank-up.sh"
SANDBOX_SCRIPT="$SANDBOX/scripts/rerank-up.sh"
SANDBOX_PID_FILE="$SANDBOX/.runtime/rerank-server.pid"

# 沙箱专用端口：取一个几乎不可能被占用的高位端口，且绝不用 8787
SANDBOX_PORT="${RERANK_SELFTEST_PORT:-38787}"
FAKE_MODEL="$SANDBOX/.models/selftest-model.gguf"

ok()   { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1（$3）"; else bad "$1：期望 $2，实际 $3"; fi; }

run_sandbox() {
  # 用沙箱脚本 + 沙箱端口 + 沙箱模型路径运行，输出丢到变量，返回退出码
  RERANK_PORT="$SANDBOX_PORT" RERANK_MODEL_PATH="$FAKE_MODEL" \
    bash "$SANDBOX_SCRIPT" >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
}

echo "沙箱：$SANDBOX"
echo "沙箱端口：$SANDBOX_PORT（真实 Reranker 端口 8787 不参与本自检）"
echo

# --- 用例 1：PID 指向存活但**不是** llama-server 的进程 --------------------
echo "用例 1：PID 存活但命令行不含 llama-server → 必须报错退出且保留现场"
mkdir -p "$SANDBOX/.runtime"
sleep 600 &
INTRUDER_PID=$!
SPAWNED_PIDS="$SPAWNED_PIDS $INTRUDER_PID"
echo "$INTRUDER_PID" > "$SANDBOX_PID_FILE"

run_sandbox
check "退出码非零" "1" "$?"
if [ -f "$SANDBOX_PID_FILE" ]; then ok "PID 文件被保留（未删除存活进程的记录）"; else bad "PID 文件被删除了 —— 违反不删除活进程 PID 文件的要求"; fi
if kill -0 "$INTRUDER_PID" 2>/dev/null; then ok "无关进程未被停止"; else bad "无关进程被杀了"; fi
if grep -q "命令行不含 llama-server" "$SANDBOX/err.txt"; then ok "报错指出了具体不通过的校验项"; else bad "报错未说明原因：$(cat "$SANDBOX/err.txt")"; fi
kill "$INTRUDER_PID" 2>/dev/null
wait "$INTRUDER_PID" 2>/dev/null
echo

# --- 用例 2：命令行像 llama-server + 模型名，但 /health 不可达 --------------
echo "用例 2：进程名与模型名都匹配、但健康检查不可达 → 仍必须报错退出"
mkdir -p "$SANDBOX/.runtime"
bash -c 'exec -a "llama-server --model selftest-model.gguf --port 38787" sleep 600' &
FAKE_PID=$!
SPAWNED_PIDS="$SPAWNED_PIDS $FAKE_PID"
sleep 1
FAKE_CMD="$(ps -o command= -p "$FAKE_PID" 2>/dev/null || true)"
echo "$FAKE_PID" > "$SANDBOX_PID_FILE"

if printf '%s' "$FAKE_CMD" | grep -q "llama-server" && printf '%s' "$FAKE_CMD" | grep -q "selftest-model.gguf"; then
  run_sandbox
  check "退出码非零" "1" "$?"
  if grep -q "健康检查" "$SANDBOX/err.txt"; then ok "报错指出健康检查不可达"; else bad "报错未提健康检查：$(cat "$SANDBOX/err.txt")"; fi
  if [ -f "$SANDBOX_PID_FILE" ]; then ok "PID 文件被保留"; else bad "PID 文件被删除了"; fi
  if kill -0 "$FAKE_PID" 2>/dev/null; then ok "该进程未被停止"; else bad "该进程被杀了"; fi
else
  echo "  SKIP  本机 ps 无法伪造命令行（exec -a 不生效），跳过此用例"
fi
kill "$FAKE_PID" 2>/dev/null
wait "$FAKE_PID" 2>/dev/null
rm -f "$SANDBOX_PID_FILE"
echo

# --- 用例 3：PID 已不存在 → 清理陈旧记录后继续 ------------------------------
echo "用例 3：PID 文件指向已退出的进程 → 清理陈旧记录并继续（因模型缺失止步）"
mkdir -p "$SANDBOX/.runtime"
sleep 0.1 &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null
echo "$DEAD_PID" > "$SANDBOX_PID_FILE"

run_sandbox
check "退出码非零（模型文件不存在）" "1" "$?"
if [ ! -f "$SANDBOX_PID_FILE" ]; then ok "陈旧 PID 文件被清理"; else bad "陈旧 PID 文件未清理"; fi
if grep -q "清理陈旧 PID 文件" "$SANDBOX/out.txt"; then ok "输出说明了清理动作"; else bad "输出未说明清理：$(cat "$SANDBOX/out.txt")"; fi
if grep -q "未找到模型文件" "$SANDBOX/err.txt"; then ok "止步于模型缺失（未误启动服务）"; else bad "未按预期止步：$(cat "$SANDBOX/err.txt")"; fi
echo

# --- 用例 4：PID 文件为空 ---------------------------------------------------
echo "用例 4：PID 文件为空 → 按陈旧记录清理"
mkdir -p "$SANDBOX/.runtime"
: > "$SANDBOX_PID_FILE"
run_sandbox
check "退出码非零（模型文件不存在）" "1" "$?"
if [ ! -f "$SANDBOX_PID_FILE" ]; then ok "空 PID 文件被清理"; else bad "空 PID 文件未清理"; fi
echo

# --- 用例 5：真实实例四项校验（只读，不启动/不停止） ------------------------
echo "用例 5：对真实 Reranker 执行 rerank-up.sh —— 四项校验应通过并 exit 0"
REAL_PID_FILE="$MASTRA_ROOT/.runtime/rerank-server.pid"
if [ -f "$REAL_PID_FILE" ]; then
  REAL_PID="$(cat "$REAL_PID_FILE")"
  bash "$REAL_SCRIPT" >"$SANDBOX/real-out.txt" 2>"$SANDBOX/real-err.txt"
  check "退出码为 0" "0" "$?"
  if grep -q "四项校验通过，不重复启动" "$SANDBOX/real-out.txt"; then ok "识别为已运行实例，未重复拉起"; else bad "输出异常：$(cat "$SANDBOX/real-out.txt" "$SANDBOX/real-err.txt")"; fi
  NOW_PID="$(cat "$REAL_PID_FILE")"
  check "PID 未被替换" "$REAL_PID" "$NOW_PID"
  if kill -0 "$REAL_PID" 2>/dev/null; then ok "真实 Reranker PID $REAL_PID 仍存活"; else bad "真实 Reranker 已不在运行"; fi
else
  echo "  SKIP  当前没有 $REAL_PID_FILE，跳过真实实例用例"
fi
echo

echo "自检结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
