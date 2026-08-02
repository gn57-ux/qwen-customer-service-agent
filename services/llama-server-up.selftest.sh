#!/usr/bin/env bash
# llama-server-up.sh 的"manifest 硬校验 + 已运行实例识别"逻辑自检
# （沙箱化，不碰真实 8002 端口或真实 PID 文件；用真实 .venv 解析 manifest，
# 因为脚本本身就依赖它，沙箱化的只是 PID 文件/GGUF 权重/manifest 内容）。
set -uo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
REAL_VENV_PY="$REPO_ROOT/.venv/bin/python"
REAL_SCRIPT="$SERVICES_DIR/llama-server-up.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/llama-server-selftest.XXXXXX")"
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

mkdir -p "$SANDBOX/services/.runtime" "$SANDBOX/gguf"
cp "$REAL_SCRIPT" "$SANDBOX/services/llama-server-up.sh"
cp "$SERVICES_DIR/check_llama_server_identity.py" "$SANDBOX/services/"
cp "$SERVICES_DIR/llama_cpp_backend.py" "$SANDBOX/services/"
SANDBOX_PID_FILE="$SANDBOX/services/.runtime/llama-server.pid"
SANDBOX_PORT="${LLAMA_SELFTEST_PORT:-38002}"
SANDBOX_MANIFEST="$SANDBOX/gguf-manifest.json"
REV="b968826d9c46dd6066d109eabc6255188de91218"

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

echo "沙箱：$SANDBOX"
echo "沙箱端口：$SANDBOX_PORT（真实端口 8002 不参与本自检）"
echo

write_manifest() {
  # $1=base_sha $2=adapter_sha $3=revision $4=adapter_scale
  python3 - "$SANDBOX_MANIFEST" "$1" "$2" "$3" "$4" <<'PY'
import json, sys
path, base_sha, adapter_sha, rev, scale = sys.argv[1:6]
json.dump({
    "base_model": {"revision": rev},
    "adapter_source": {"best_checkpoint": "checkpoint-160", "best_eval_loss": 1.0},
    "gguf": {
        "base_q4_k_m": {"file": "base.gguf", "sha256": base_sha},
        "adapter_lora": {"file": "adapter.gguf", "sha256": adapter_sha, "adapter_scale": float(scale)},
    },
}, open(path, "w"))
PY
}

run_sandbox() {
  VENV_PY="$REAL_VENV_PY" GGUF_DIR="$SANDBOX/gguf" GGUF_MANIFEST_PATH="$SANDBOX_MANIFEST" \
    LLAMA_CPP_PORT="$SANDBOX_PORT" EXPECTED_BASE_REVISION="$REV" ADAPTER_SCALE=1.0 \
    bash "$SANDBOX/services/llama-server-up.sh" >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
}

# ---- 用例 1：manifest 不存在 → 硬失败 --------------------------------------
echo "用例 1：manifest 不存在 → exit 1"
rm -f "$SANDBOX_MANIFEST"
run_sandbox
[ "$?" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "不存在" "$SANDBOX/err.txt" && ok "报错指出 manifest 不存在" || bad "未报告：$(cat "$SANDBOX/err.txt")"
echo

# ---- 用例 2：manifest 存在但 GGUF 文件缺失 --------------------------------
echo "用例 2：manifest 存在但 GGUF 文件缺失 → exit 1"
echo -n "base-content" > /tmp/.llamaselftest-base
echo -n "lora-content" > /tmp/.llamaselftest-lora
BASE_SHA="$(shasum -a 256 /tmp/.llamaselftest-base | awk '{print $1}')"
LORA_SHA="$(shasum -a 256 /tmp/.llamaselftest-lora | awk '{print $1}')"
write_manifest "$BASE_SHA" "$LORA_SHA" "$REV" "1.0"
run_sandbox
[ "$?" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "manifest 校验未通过" "$SANDBOX/err.txt" && ok "报错指出 manifest 校验失败" || bad "未报告"
echo

# ---- 用例 3：revision 不符 → exit 1 ----------------------------------------
echo "用例 3：manifest revision 与期望不符 → exit 1"
cp /tmp/.llamaselftest-base "$SANDBOX/gguf/base.gguf"
cp /tmp/.llamaselftest-lora "$SANDBOX/gguf/adapter.gguf"
write_manifest "$BASE_SHA" "$LORA_SHA" "0000000000000000000000000000000000000000" "1.0"
run_sandbox
[ "$?" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -qi "revision" "$SANDBOX/err.txt" && ok "报错指出 revision 不符" || bad "未报告：$(cat "$SANDBOX/err.txt")"
echo

# ---- 用例 4：adapter_scale 不符 → exit 1 -----------------------------------
echo "用例 4：adapter_scale 与期望不符 → exit 1"
write_manifest "$BASE_SHA" "$LORA_SHA" "$REV" "0.5"
run_sandbox
[ "$?" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -qi "adapter_scale" "$SANDBOX/err.txt" && ok "报错指出 adapter_scale 不符" || bad "未报告"
echo

# ---- 用例 5：manifest 校验通过后，PID 存活但不是 llama-server -------------
echo "用例 5：manifest 通过，但 PID 存活且命令行不含 llama-server → 拒绝且保留现场"
write_manifest "$BASE_SHA" "$LORA_SHA" "$REV" "1.0"
sleep 600 &
INTRUDER=$!
SPAWNED_PIDS="$SPAWNED_PIDS $INTRUDER"
echo "$INTRUDER" > "$SANDBOX_PID_FILE"
run_sandbox
[ "$?" != "0" ] && ok "退出码非零" || bad "不应成功"
[ -f "$SANDBOX_PID_FILE" ] && ok "PID 文件被保留" || bad "PID 文件被误删"
kill -0 "$INTRUDER" 2>/dev/null && ok "无关进程未被停止" || bad "无关进程被杀了"
grep -q "不含 llama-server" "$SANDBOX/err.txt" && ok "报错说明具体原因" || bad "报错未说明原因"
kill "$INTRUDER" 2>/dev/null; wait "$INTRUDER" 2>/dev/null
echo

# ---- 用例 6：PID 已死 → 清理陈旧记录（因无真实 llama-server 二进制会止步）--
echo "用例 6：PID 文件指向已退出进程 → 清理陈旧记录"
sleep 0.1 & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "$SANDBOX_PID_FILE"
run_sandbox
[ ! -f "$SANDBOX_PID_FILE" ] && ok "陈旧 PID 文件被清理" || bad "陈旧 PID 文件未清理"
echo

rm -f /tmp/.llamaselftest-base /tmp/.llamaselftest-lora

# ---- 用例 7：真实实例识别（只读，用真实 8002 上的正式服务）----------------
echo "用例 7：对真实 llama-server 执行识别流程（只读，不启动/不停止）"
if curl -fsS --max-time 2 "http://127.0.0.1:8002/health" >/dev/null 2>&1; then
  bash "$SERVICES_DIR/llama-server-up.sh" >"$SANDBOX/real-out.txt" 2>"$SANDBOX/real-err.txt"
  RC=$?
  [ "$RC" = "0" ] && ok "真实实例识别退出码 0" || bad "真实实例识别失败：$(cat "$SANDBOX/real-err.txt")"
  grep -q "不重复启动" "$SANDBOX/real-out.txt" && ok "识别为已运行实例，未重复拉起" || bad "输出异常：$(cat "$SANDBOX/real-out.txt")"
else
  echo "  SKIP  当前没有真实 llama-server 在运行，跳过"
fi
echo

echo "自检结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
