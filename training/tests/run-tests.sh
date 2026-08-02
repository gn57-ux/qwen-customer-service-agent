#!/usr/bin/env bash
# Mac 可运行的自动测试。不需要 CUDA / LLaMA Factory / 模型权重。
#
#   bash training/tests/run-tests.sh
#
# 覆盖本轮 Review 的四项修正：
#   1) Trainer / Control 目录隔离（跑完 01–03 后 Trainer 目录必须仍为空）
#   2) 模型 revision 证据：匹配 / 错配 / 无证据 / 只有 revision 字符串的假 manifest
#   3) tokenized 数据结构与 labels 掩码
#   4) evaluate 部分失败必须非零、--limit 保护、dry-run 隔离
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TRAINING_ROOT/.." && pwd)"
PY="${PYTHON_BIN:-python3}"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/training-tests.XXXXXX")"
PASS=0
FAIL=0
SKIP=0
trap 'rm -rf "$SANDBOX"' EXIT

ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  SKIP  %s\n' "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1（$3）"; else bad "$1：期望 $2，实际 $3"; fi; }
section() { printf '\n%s\n%s\n' "$1" "------------------------------------------------------------"; }

echo "沙箱：$SANDBOX"

# ===========================================================================
section "1. Trainer / Control 目录隔离"
# ===========================================================================
TRAINER="$SANDBOX/trainer-out"
CONTROL="$SANDBOX/control-out"
export TRAINER_OUTPUT_DIR_OVERRIDE="$TRAINER"
export TRAINING_CONTROL_DIR="$CONTROL"

bash "$TRAINING_ROOT/run.sh" preflight >"$SANDBOX/01.log" 2>&1
RC1=$?
if [ "$RC1" != "0" ]; then
  if grep -q '/dev/fd/.*Operation not permitted' "$SANDBOX/01.log" 2>/dev/null; then
    skip "01-preflight sandbox 进程替换受限（/dev/fd/*），跳过"
    SANDBOX_SKIP_01=1
  else
    chk "01-preflight 退出码" "0" "$RC1"
    echo "  --- 01 日志尾部 ---"; tail -5 "$SANDBOX/01.log" | sed 's/^/    /'
    SANDBOX_SKIP_01=0
  fi
else
  ok "01-preflight 退出码"
  SANDBOX_SKIP_01=0
fi

if [ "${SANDBOX_SKIP_01:-0}" = "1" ]; then
  skip "02-preprocess 依赖已跳过的 01-preflight，跳过"
  SANDBOX_SKIP_02=1
else
  bash "$TRAINING_ROOT/run.sh" preprocess >"$SANDBOX/02.log" 2>&1
  RC2=$?
  if [ "$RC2" != "0" ]; then
    if grep -q '/dev/fd/.*Operation not permitted' "$SANDBOX/02.log" 2>/dev/null; then
      skip "02-preprocess sandbox 进程替换受限（/dev/fd/*），跳过"
      SANDBOX_SKIP_02=1
    else
      chk "02-preprocess 在 Mac 上退出码（PENDING 但不报错）" "0" "$RC2"
      echo "  --- 02 日志尾部 ---"; tail -5 "$SANDBOX/02.log" | sed 's/^/    /'
      SANDBOX_SKIP_02=0
    fi
  else
    ok "02-preprocess 在 Mac 上退出码（PENDING 但不报错）"
    SANDBOX_SKIP_02=0
  fi
fi

# 03 在 Mac 上必须因为缺前置 + 非 Linux 而拒绝
bash "$TRAINING_ROOT/run.sh" base-eval >"$SANDBOX/03.log" 2>&1
RC3=$?
if [ "$RC3" != "0" ]; then ok "03-base-eval 在 Mac 上被拒绝（rc=${RC3}）"; else bad "03-base-eval 不该成功"; fi

if [ ! -e "$TRAINER" ]; then
  ok "01–03 之后 Trainer 目录仍不存在"
elif [ "$(find "$TRAINER" -mindepth 1 | wc -l | tr -d ' ')" = "0" ]; then
  ok "01–03 之后 Trainer 目录仍为空"
else
  bad "Trainer 目录被提前写入：$(find "$TRAINER" -mindepth 1 | head -5 | tr '\n' ' ')"
fi

for d in logs stage-state preflight preprocess; do
  if [ "${SANDBOX_SKIP_01:-0}" = "1" ] && [ "$d" != "logs" ] && [ "$d" != "stage-state" ]; then
    skip "流程产物落在 Control 目录：${d}（依赖 01，sandbox 受限）"
  elif [ "${SANDBOX_SKIP_02:-0}" = "1" ] && [ "$d" = "preprocess" ]; then
    skip "流程产物落在 Control 目录：${d}（依赖 02，sandbox 受限）"
  elif [ -e "$CONTROL/$d" ]; then ok "流程产物落在 Control 目录：$d"; else bad "Control 目录缺少 $d"; fi
done

# Trainer 目录被污染时，01 必须拒绝
mkdir -p "$TRAINER" && touch "$TRAINER/checkpoint-20"
bash "$TRAINING_ROOT/run.sh" preflight >"$SANDBOX/01b.log" 2>&1
RC1B=$?
if [ "$RC1B" != "0" ]; then ok "Trainer 目录非空时 01 拒绝（rc=${RC1B}）"; else bad "Trainer 目录非空时 01 仍通过"; fi
if [ -e "$TRAINER/checkpoint-20" ]; then ok "既有内容未被删除"; else bad "既有内容被删除了"; fi
rm -rf "$TRAINER"

unset TRAINER_OUTPUT_DIR_OVERRIDE TRAINING_CONTROL_DIR

# ===========================================================================
section "2. 模型 revision 证据门禁"
# ===========================================================================
REV="b968826d9c46dd6066d109eabc6255188de91218"
WRONG="0000000000000000000000000000000000000000"
VR="$TRAINING_ROOT/tools/verify_model_revision.py"

MD="$SANDBOX/model-git"
mkdir -p "$MD"
printf '{}' > "$MD/config.json"
git -C "$MD" init -q 2>/dev/null
git -C "$MD" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$MD" -c user.email=t@t -c user.name=t commit -qm init >/dev/null 2>&1
GIT_REV="$(git -C "$MD" rev-parse HEAD 2>/dev/null || echo "")"
"$PY" "$VR" --model-dir "$MD" --expect "$GIT_REV" >"$SANDBOX/rev-git.log" 2>&1
chk "git 证据 + revision 匹配" "0" "$?"
"$PY" "$VR" --model-dir "$MD" --expect "$WRONG" >"$SANDBOX/rev-git-bad.log" 2>&1
chk "git 证据 + revision 错配" "1" "$?"

MD2="$SANDBOX/model-bare"
mkdir -p "$MD2"; printf '{}' > "$MD2/config.json"
"$PY" "$VR" --model-dir "$MD2" --expect "$REV" >"$SANDBOX/rev-none.log" 2>&1
chk "无任何证据" "1" "$?"
if grep -q "只读排查命令" "$SANDBOX/rev-none.log"; then ok "无证据时给出只读排查命令"; else bad "未给出排查命令"; fi

# 假 manifest：只有 revision，没有文件清单 → 必须拒绝
MD3="$SANDBOX/model-fake-manifest"
mkdir -p "$MD3"; printf '{}' > "$MD3/config.json"
cat > "$MD3/revision-manifest.json" <<JSON
{"schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B", "revision": "$REV"}
JSON
"$PY" "$VR" --model-dir "$MD3" --expect "$REV" >"$SANDBOX/rev-fake.log" 2>&1
chk "只写 revision 的假 manifest" "1" "$?"
if grep -q "没有文件清单" "$SANDBOX/rev-fake.log"; then ok "指出 manifest 缺文件清单"; else bad "未指出缺清单"; fi

# 合规 manifest：绑定文件 + SHA-256（单文件 model.safetensors）
MD4="$SANDBOX/model-good-manifest"
mkdir -p "$MD4"
printf '{"a":1}'   > "$MD4/config.json"
printf '{"b":2}'   > "$MD4/tokenizer_config.json"
printf '{"c":3}'   > "$MD4/tokenizer.json"
printf 'WEIGHTS'   > "$MD4/model.safetensors"
"$PY" - "$MD4" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD4" --expect "$REV" >"$SANDBOX/rev-good.log" 2>&1
chk "合规 manifest（文件+SHA-256）" "0" "$?"

# 篡改其中一个文件 → manifest 校验必须失败
printf 'TAMPERED' > "$MD4/model.safetensors"
"$PY" "$VR" --model-dir "$MD4" --expect "$REV" >"$SANDBOX/rev-tamper.log" 2>&1
chk "manifest 文件被篡改" "1" "$?"

# 非 index 模型用 model-00001-of-00001.safetensors 冒充单文件 → FAIL
MD4B="$SANDBOX/model-impersonate-single"
mkdir -p "$MD4B"
printf '{"a":1}'   > "$MD4B/config.json"
printf '{"b":2}'   > "$MD4B/tokenizer_config.json"
printf '{"c":3}'   > "$MD4B/tokenizer.json"
printf 'FAKE'      > "$MD4B/model-00001-of-00001.safetensors"
"$PY" - "$MD4B" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model-00001-of-00001.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD4B" --expect "$REV" >"$SANDBOX/rev-impersonate.log" 2>&1
chk "非 index 模型用 model-00001-of-00001 冒充单文件被拒" "1" "$?"

# ---- 分片模型全权重绑定测试 ----
# 5a: 分片模型（index.json + 全部分片绑入 manifest）→ PASS
MD5="$SANDBOX/model-shard-good"
mkdir -p "$MD5"
printf '{"a":1}'   > "$MD5/config.json"
printf '{"b":2}'   > "$MD5/tokenizer_config.json"
printf '{"c":3}'   > "$MD5/tokenizer.json"
printf 'SHARD0'    > "$MD5/model-00001-of-00003.safetensors"
printf 'SHARD1'    > "$MD5/model-00002-of-00003.safetensors"
printf 'SHARD2'    > "$MD5/model-00003-of-00003.safetensors"
# 创建 index.json 引用全部分片
"$PY" -c "
import json, pathlib
d = pathlib.Path('$MD5')
index = {'metadata': {'total_size': 999}, 'weight_map': {
    'layer.0.weight': 'model-00001-of-00003.safetensors',
    'layer.1.weight': 'model-00002-of-00003.safetensors',
    'layer.2.weight': 'model-00003-of-00003.safetensors',
}}
(d / 'model.safetensors.index.json').write_text(json.dumps(index))
"
# 构建 manifest 绑定 index + 全部 3 个分片 + 关键文件
"$PY" - "$MD5" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model.safetensors.index.json",
          "model-00001-of-00003.safetensors",
          "model-00002-of-00003.safetensors",
          "model-00003-of-00003.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5" --expect "$REV" >"$SANDBOX/rev-shard-good.log" 2>&1
chk "分片模型全部分片绑入 manifest" "0" "$?"

# 5b: 模型有 index.json 但 manifest 未包含 index → FAIL
MD5B="$SANDBOX/model-shard-noindex-manifest"
mkdir -p "$MD5B"
cp "$MD5/config.json" "$MD5/tokenizer_config.json" "$MD5/tokenizer.json" \
   "$MD5/model.safetensors.index.json" \
   "$MD5/model-00001-of-00003.safetensors" \
   "$MD5/model-00002-of-00003.safetensors" \
   "$MD5/model-00003-of-00003.safetensors" "$MD5B/"
# manifest 不含 index.json
"$PY" - "$MD5B" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model-00001-of-00003.safetensors",
          "model-00002-of-00003.safetensors",
          "model-00003-of-00003.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5B" --expect "$REV" >"$SANDBOX/rev-shard-noindex.log" 2>&1
chk "分片模型 manifest 缺 index.json" "1" "$?"

# 5c: index 引用的分片未全部写入 manifest → FAIL
MD5C="$SANDBOX/model-shard-missing-in-manifest"
mkdir -p "$MD5C"
cp "$MD5/config.json" "$MD5/tokenizer_config.json" "$MD5/tokenizer.json" \
   "$MD5/model.safetensors.index.json" \
   "$MD5/model-00001-of-00003.safetensors" \
   "$MD5/model-00002-of-00003.safetensors" \
   "$MD5/model-00003-of-00003.safetensors" "$MD5C/"
# manifest 只绑了 2 个分片（缺 model-00003-of-00003）
"$PY" - "$MD5C" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model.safetensors.index.json",
          "model-00001-of-00003.safetensors",
          "model-00002-of-00003.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5C" --expect "$REV" >"$SANDBOX/rev-shard-missing.log" 2>&1
chk "index 引用的分片未全部写入 manifest" "1" "$?"

# 5d: manifest 绑了分片但磁盘缺文件 → FAIL
MD5D="$SANDBOX/model-shard-file-missing"
mkdir -p "$MD5D"
cp "$MD5/config.json" "$MD5/tokenizer_config.json" "$MD5/tokenizer.json" \
   "$MD5/model.safetensors.index.json" \
   "$MD5/model-00001-of-00003.safetensors" \
   "$MD5/model-00002-of-00003.safetensors" "$MD5D/"
# 故意不复制 model-00003，但 manifest 里写全 3 个
"$PY" - "$MD5D" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model.safetensors.index.json",
          "model-00001-of-00003.safetensors",
          "model-00002-of-00003.safetensors",
          "model-00003-of-00003.safetensors"):
    p = d / n
    if p.is_file():
        files.append({"name": n, "bytes": p.stat().st_size,
                      "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
    else:
        files.append({"name": n, "bytes": 100, "sha256": "deadbeef" * 8})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5D" --expect "$REV" >"$SANDBOX/rev-shard-filemiss.log" 2>&1
chk "manifest 绑定但磁盘缺分片文件" "1" "$?"

# 5e: 分片被篡改 → FAIL
MD5E="$SANDBOX/model-shard-tampered"
mkdir -p "$MD5E"
cp "$MD5/config.json" "$MD5/tokenizer_config.json" "$MD5/tokenizer.json" \
   "$MD5/model.safetensors.index.json" \
   "$MD5/model-00001-of-00003.safetensors" \
   "$MD5/model-00002-of-00003.safetensors" \
   "$MD5/model-00003-of-00003.safetensors" "$MD5E/"
printf 'TAMPERED-SHARD' > "$MD5E/model-00002-of-00003.safetensors"
cp "$MD5/revision-manifest.json" "$MD5E/"
"$PY" "$VR" --model-dir "$MD5E" --expect "$REV" >"$SANDBOX/rev-shard-tamper.log" 2>&1
chk "分片模型任一分片被篡改" "1" "$?"

# 5f: 单文件 model.safetensors 完整绑定 → PASS
MD5F="$SANDBOX/model-single"
mkdir -p "$MD5F"
printf '{"a":1}'      > "$MD5F/config.json"
printf '{"b":2}'      > "$MD5F/tokenizer_config.json"
printf '{"c":3}'      > "$MD5F/tokenizer.json"
printf 'FULL-WEIGHTS' > "$MD5F/model.safetensors"
"$PY" - "$MD5F" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json",
          "model.safetensors"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5F" --expect "$REV" >"$SANDBOX/rev-single.log" 2>&1
chk "单文件 model.safetensors 完整绑定" "0" "$?"

# 5g: 非 index 模型 manifest 无任何权重文件 → FAIL
MD5G="$SANDBOX/model-no-weight"
mkdir -p "$MD5G"
printf '{"a":1}' > "$MD5G/config.json"
printf '{"b":2}' > "$MD5G/tokenizer_config.json"
printf '{"c":3}' > "$MD5G/tokenizer.json"
"$PY" - "$MD5G" "$REV" <<'PYEOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
files = []
for n in ("config.json", "tokenizer_config.json", "tokenizer.json"):
    p = d / n
    files.append({"name": n, "bytes": p.stat().st_size,
                  "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
(d / "revision-manifest.json").write_text(json.dumps({
    "schema": "model-revision-manifest/v1", "repo": "Qwen/Qwen3-8B",
    "revision": sys.argv[2], "evidence_source": "huggingface-download",
    "generated_at": "2026-07-30T00:00:00Z", "files": files}, indent=2), encoding="utf-8")
PYEOF
"$PY" "$VR" --model-dir "$MD5G" --expect "$REV" >"$SANDBOX/rev-noweight.log" 2>&1
chk "非 index 模型 manifest 无任何权重" "1" "$?"

# ===========================================================================
section "3. tokenized 结构与 labels 掩码"
# ===========================================================================
"$PY" "$TESTS_DIR/test_tokenized.py" >"$SANDBOX/tok.log" 2>&1
RCT=$?
chk "tokenized 纯逻辑测试" "0" "$RCT"
sed 's/^/    /' "$SANDBOX/tok.log"

# ===========================================================================
section "4. evaluate 完整性门禁"
# ===========================================================================
EV="$TRAINING_ROOT/tools/evaluate.py"
OUT="$SANDBOX/eval"

"$PY" "$EV" --limit 5 --output-dir "$OUT" >"$SANDBOX/ev-limit.log" 2>&1
chk "正式模式使用 --limit 被拒" "1" "$?"

"$PY" "$EV" --dry-run --output-dir "$OUT" >"$SANDBOX/ev-dry.log" 2>&1
chk "dry-run 正常完成" "0" "$?"
if ls "$OUT"/eval-dryrun-*.summary.json >/dev/null 2>&1; then
  ok "dry-run 结果文件名带 dryrun- 前缀（与正式结果隔离）"
else
  bad "dry-run 结果未加前缀"
fi
if "$PY" -c "
import json,glob,sys
f=sorted(glob.glob('$OUT/eval-dryrun-*.summary.json'))[-1]
r=json.load(open(f))
sys.exit(0 if r['dry_run'] and r['usable_for_comparison'] is False else 1)"; then
  ok "dry-run 报告标记 usable_for_comparison=false"
else
  bad "dry-run 报告未标记不可对比"
fi

"$PY" "$TESTS_DIR/test_eval_failure.py" >"$SANDBOX/ev-fail.log" 2>&1
RCF=$?
chk "第 N 条生成异常 → 退出码非零且报告仍生成" "0" "$RCF"
sed 's/^/    /' "$SANDBOX/ev-fail.log"

# ===========================================================================
section "5. checkpoint 选择与打包（回归）"
# ===========================================================================
"$PY" "$TESTS_DIR/test_select_and_package.py" >"$SANDBOX/sp.log" 2>&1
RCSP=$?
chk "选择 + 打包回归测试" "0" "$RCSP"
sed 's/^/    /' "$SANDBOX/sp.log"

printf '\n============================================================\n'
printf '测试结果：PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
printf '============================================================\n'
[ "$FAIL" -eq 0 ]
