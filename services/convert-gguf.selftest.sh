#!/usr/bin/env bash
# convert-gguf.sh 静态逻辑与拒绝分支自检：不重新执行真实转换（不跑
# convert_hf_to_gguf.py / llama-quantize），只验证各前置校验分支能正确拦截。
set -uo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
REAL_VENV_PY="$REPO_ROOT/.venv/bin/python"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/convert-gguf-selftest.XXXXXX")"
PASS=0
FAIL=0

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

echo "沙箱：$SANDBOX"
echo

REAL_REV="b968826d9c46dd6066d109eabc6255188de91218"

run() {
  # 独立环境变量运行 convert-gguf.sh，捕获退出码/输出
  ( VENV_PY="$REAL_VENV_PY" \
    LLAMACPP_COMMIT="$1" \
    BASE_MODEL_PATH="$2" \
    ADAPTER_PATH="$3" \
    EXPECTED_BASE_REVISION="$4" \
    GGUF_DIR="$5" \
    LLAMACPP_TOOLS_DIR="$6" \
    bash "$SERVICES_DIR/convert-gguf.sh" ) >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
  echo $?
}

REAL_COMMIT="11b068d06605288ce7917534b46d52b47823dc13"
REAL_TOOLS_DIR="$REPO_ROOT/models/tools/llama.cpp-11b068d06"
REAL_BASE="$REPO_ROOT/models/Qwen3-8B"
REAL_ADAPTER="$REPO_ROOT/models/adapters/customer-service-production-v1"

echo "用例 1：llama.cpp commit 不匹配 → 拒绝"
RC=$(run "0000000000000000000000000000000000000000" "$REAL_BASE" "$REAL_ADAPTER" "$REAL_REV" \
        "$SANDBOX/out1" "$REAL_TOOLS_DIR")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "commit.*不一致" "$SANDBOX/err.txt" && ok "报错指出 commit 不一致" || bad "未报告 commit 问题"
echo

echo "用例 2：转换脚本目录不存在 → 拒绝"
RC=$(run "$REAL_COMMIT" "$REAL_BASE" "$REAL_ADAPTER" "$REAL_REV" \
        "$SANDBOX/out2" "$SANDBOX/no-such-tools-dir")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "未找到同 commit 转换脚本" "$SANDBOX/err.txt" && ok "报错指出缺转换脚本" || bad "未报告"
echo

echo "用例 3：Base revision 不匹配 → 拒绝"
mkdir -p "$SANDBOX/fake-base"
echo '{}' > "$SANDBOX/fake-base/config.json"
RC=$(run "$REAL_COMMIT" "$SANDBOX/fake-base" "$REAL_ADAPTER" "$REAL_REV" \
        "$SANDBOX/out3" "$REAL_TOOLS_DIR")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "Base revision 校验未通过" "$SANDBOX/err.txt" && ok "报错指出 revision 校验失败" || bad "未报告"
echo

echo "用例 4：Adapter 恢复报告缺失 → 拒绝"
mkdir -p "$SANDBOX/fake-adapter-no-report"
(cp -f "$REAL_ADAPTER"/*.safetensors "$SANDBOX/fake-adapter-no-report/" 2>/dev/null || true)
RC=$(run "$REAL_COMMIT" "$REAL_BASE" "$SANDBOX/fake-adapter-no-report" "$REAL_REV" \
        "$SANDBOX/out4" "$REAL_TOOLS_DIR")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "未找到 Adapter 恢复报告" "$SANDBOX/err.txt" && ok "报错指出缺恢复报告" || bad "未报告：$(cat "$SANDBOX/err.txt")"
echo

echo "用例 5：Adapter 恢复报告 verdict!=PASS → 拒绝"
mkdir -p "$SANDBOX/fake-adapter-fail"
echo '{"verdict":"FAIL"}' > "$SANDBOX/fake-adapter-fail/RESTORE-VERIFICATION.json"
RC=$(run "$REAL_COMMIT" "$REAL_BASE" "$SANDBOX/fake-adapter-fail" "$REAL_REV" \
        "$SANDBOX/out5" "$REAL_TOOLS_DIR")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "verdict=FAIL" "$SANDBOX/err.txt" && ok "报错指出 verdict 非 PASS" || bad "未报告：$(cat "$SANDBOX/err.txt")"
echo

echo "用例 6：输出目录已存在且非空 → 拒绝覆盖"
mkdir -p "$SANDBOX/existing-out"
echo "占位" > "$SANDBOX/existing-out/keep.txt"
RC=$(run "$REAL_COMMIT" "$REAL_BASE" "$REAL_ADAPTER" "$REAL_REV" \
        "$SANDBOX/existing-out" "$REAL_TOOLS_DIR")
[ "$RC" != "0" ] && ok "退出码非零" || bad "不应成功"
grep -q "拒绝覆盖" "$SANDBOX/err.txt" && ok "报错指出拒绝覆盖" || bad "未报告"
[ -f "$SANDBOX/existing-out/keep.txt" ] && ok "既有内容未被删除" || bad "既有内容被删了"
echo

echo "自检结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
