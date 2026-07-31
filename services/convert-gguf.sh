#!/usr/bin/env bash
# GGUF 转换编排：Base(F16→Q4_K_M) + Adapter(LoRA GGUF)。
#
# 前置校验（任一不满足即 exit 1，不跳过）：
#   - 已安装 llama-server 的 commit 与本脚本固定的 LLAMACPP_COMMIT 一致；
#   - 同 commit 的转换脚本已取到本地（models/tools/，不自动下载）；
#   - Base revision 通过 training/tools/verify_model_revision.py 校验；
#   - Adapter 的 RESTORE-VERIFICATION.json 存在且 verdict=PASS；
#   - 输出目录不存在或为空（已存在内容则拒绝覆盖）；
#   - sentencepiece 已安装（requirements-gguf-convert.txt）。
#
# 不自动删除 F16 中间产物；转换完成后只生成 manifest 候选文件，
# 不直接覆盖 services/manifests/ 下受控的 manifest（需要人工核对后合并）。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
VENV_PY="${VENV_PY:-$REPO_ROOT/.venv/bin/python}"

# 固定完整 commit：与 services/manifests/customer-service-production-v1.gguf.json
# 里 conversion_tool.commit 一致，也是已安装 llama-server 的 commit。
LLAMACPP_COMMIT="${LLAMACPP_COMMIT:-11b068d06605288ce7917534b46d52b47823dc13}"
LLAMACPP_COMMIT_SHORT="${LLAMACPP_COMMIT:0:9}"

BASE_MODEL_DIR="${BASE_MODEL_PATH:-$REPO_ROOT/models/Qwen3-8B}"
ADAPTER_DIR="${ADAPTER_PATH:-$REPO_ROOT/models/adapters/customer-service-production-v1}"
EXPECTED_BASE_REVISION="${EXPECTED_BASE_REVISION:-b968826d9c46dd6066d109eabc6255188de91218}"
OUT_DIR="${GGUF_DIR:-$REPO_ROOT/models/gguf/qwen3-8b-production-v1}"
TOOLS_DIR="${LLAMACPP_TOOLS_DIR:-$REPO_ROOT/models/tools/llama.cpp-${LLAMACPP_COMMIT_SHORT}}"
ADAPTER_SCALE="${ADAPTER_SCALE:-1.0}"

echo "=== GGUF 转换前置校验 ==="

# 1. 已安装 llama-server commit 必须与固定 commit 一致
if ! command -v llama-server >/dev/null 2>&1; then
  echo "[FAIL] 未找到 llama-server（brew install llama.cpp）" >&2
  exit 1
fi
INSTALLED_LINE="$(llama-server --version 2>&1 | head -1)"
INSTALLED_SHORT="$(printf '%s' "$INSTALLED_LINE" | sed -n 's/.*(\(.*\)).*/\1/p')"
if [ "$INSTALLED_SHORT" != "$LLAMACPP_COMMIT_SHORT" ]; then
  echo "[FAIL] 已安装 llama-server commit（$INSTALLED_SHORT）与固定 commit" \
       "（$LLAMACPP_COMMIT_SHORT）不一致，拒绝转换。" >&2
  echo "       实际版本行：$INSTALLED_LINE" >&2
  echo "       如需使用新版本，请先更新 LLAMACPP_COMMIT 并重新取转换脚本源码。" >&2
  exit 1
fi
echo "[PASS] llama-server commit 匹配：$INSTALLED_SHORT"

# 2. 同 commit 转换脚本必须已在本地（不自动下载）
if [ ! -f "$TOOLS_DIR/convert_hf_to_gguf.py" ] || [ ! -f "$TOOLS_DIR/convert_lora_to_gguf.py" ]; then
  echo "[FAIL] 未找到同 commit 转换脚本：$TOOLS_DIR" >&2
  echo "       请先获取（只读源码，不编译，不影响已安装的 llama-server 二进制）：" >&2
  echo "         curl -sL -o /tmp/llamacpp.tar.gz \\" >&2
  echo "           https://github.com/ggml-org/llama.cpp/archive/${LLAMACPP_COMMIT}.tar.gz" >&2
  echo "         # 解出 convert_hf_to_gguf.py / convert_lora_to_gguf.py / gguf-py/ / conversion/" >&2
  echo "         # 到 $TOOLS_DIR/" >&2
  exit 1
fi
echo "[PASS] 转换脚本已就绪：$TOOLS_DIR"

# 3. sentencepiece 依赖
if [ ! -x "$VENV_PY" ]; then
  echo "[FAIL] 未找到虚拟环境 Python：$VENV_PY" >&2
  exit 1
fi
if ! "$VENV_PY" -c "import sentencepiece" >/dev/null 2>&1; then
  echo "[FAIL] 缺少 sentencepiece，请先：" >&2
  echo "         .venv/bin/pip install -r requirements-gguf-convert.txt" >&2
  exit 1
fi
echo "[PASS] sentencepiece 已安装"

# 4. Base revision 校验（复用训练侧同一套证据规则，同 commit 逻辑不重复实现）
if [ ! -d "$BASE_MODEL_DIR" ]; then
  echo "[FAIL] Base 模型目录不存在：$BASE_MODEL_DIR" >&2
  exit 1
fi
if ! "$VENV_PY" "$REPO_ROOT/training/tools/verify_model_revision.py" \
      --model-dir "$BASE_MODEL_DIR" --expect "$EXPECTED_BASE_REVISION"; then
  echo "[FAIL] Base revision 校验未通过，拒绝转换。" >&2
  exit 1
fi
echo "[PASS] Base revision 校验通过"

# 5. Adapter 恢复报告必须 PASS
RESTORE_REPORT="$ADAPTER_DIR/RESTORE-VERIFICATION.json"
if [ ! -f "$RESTORE_REPORT" ]; then
  echo "[FAIL] 未找到 Adapter 恢复报告：$RESTORE_REPORT" >&2
  echo "       请先运行 services/restore_adapter.py 从正式 tar.gz 恢复。" >&2
  exit 1
fi
RESTORE_VERDICT="$("$VENV_PY" -c "
import json
print(json.load(open('$RESTORE_REPORT')).get('verdict'))
" 2>/dev/null || true)"
if [ "$RESTORE_VERDICT" != "PASS" ]; then
  echo "[FAIL] Adapter 恢复报告 verdict=${RESTORE_VERDICT:-<解析失败>}，不是 PASS，拒绝转换。" >&2
  exit 1
fi
echo "[PASS] Adapter 恢复报告 verdict=PASS"

# 6. 输出目录已存在且非空则拒绝覆盖
if [ -e "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  echo "[FAIL] 输出目录已存在且非空：$OUT_DIR，拒绝覆盖。" >&2
  echo "       如需重新转换，请先移走该目录或改用其他 GGUF_DIR。" >&2
  exit 1
fi
echo "[PASS] 输出目录可用：$OUT_DIR"

echo ""
echo "=== 全部前置校验通过，开始转换 ==="
mkdir -p "$OUT_DIR"

echo "--- Base: HF -> F16 GGUF ---"
PYTHONPATH="$TOOLS_DIR/gguf-py" "$VENV_PY" "$TOOLS_DIR/convert_hf_to_gguf.py" \
  "$BASE_MODEL_DIR" --outtype f16 \
  --outfile "$OUT_DIR/qwen3-8b-production-v1-f16.gguf"

echo "--- Base: F16 -> Q4_K_M（llama-quantize）---"
llama-quantize \
  "$OUT_DIR/qwen3-8b-production-v1-f16.gguf" \
  "$OUT_DIR/qwen3-8b-production-v1-Q4_K_M.gguf" \
  Q4_K_M
# 不自动删除 F16 中间产物。

echo "--- Adapter: PEFT LoRA -> GGUF LoRA ---"
PYTHONPATH="$TOOLS_DIR/gguf-py" "$VENV_PY" "$TOOLS_DIR/convert_lora_to_gguf.py" \
  "$ADAPTER_DIR" --base "$BASE_MODEL_DIR" --outtype f16 \
  --outfile "$OUT_DIR/customer-service-production-v1-lora.gguf"

echo "--- 生成 manifest 候选（不覆盖受控 manifest）---"
"$VENV_PY" "$SERVICES_DIR/generate_gguf_manifest_candidate.py" \
  --gguf-dir "$OUT_DIR" \
  --adapter-restore-report "$RESTORE_REPORT" \
  --llamacpp-commit "$LLAMACPP_COMMIT" \
  --base-revision "$EXPECTED_BASE_REVISION" \
  --adapter-scale "$ADAPTER_SCALE" \
  --out "$OUT_DIR/gguf-manifest.candidate.json"

echo ""
echo "转换完成。候选 manifest：$OUT_DIR/gguf-manifest.candidate.json"
echo "请人工核对内容后手动合并到 services/manifests/customer-service-production-v1.gguf.json"
echo "（F16 中间产物未删除：$OUT_DIR/qwen3-8b-production-v1-f16.gguf）"
