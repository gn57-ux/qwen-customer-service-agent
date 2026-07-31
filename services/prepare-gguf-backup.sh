#!/usr/bin/env bash
# 生成 GGUF 备份方案（分片 + 校验 + 重组命令），本轮**不上传、不删除 F16**，
# 等 Review 确认后再决定是否上传到 GitHub Release。
#
# Q4_K_M 约 4.68GiB，超过 GitHub Release 单文件 2GiB 限制，按小于 1.9GiB 分片。
set -euo pipefail

SERVICES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICES_DIR/.." && pwd)"
GGUF_DIR="${GGUF_DIR:-$REPO_ROOT/models/gguf/qwen3-8b-production-v1}"
MANIFEST_PATH="${GGUF_MANIFEST_PATH:-$SERVICES_DIR/manifests/customer-service-production-v1.gguf.json}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/models/gguf-backup/customer-service-production-v1}"
CHUNK_SIZE="${CHUNK_SIZE:-1900m}"   # < 1.9GiB，留足余量于 GitHub Release 2GiB 单文件上限

Q4_FILE="$GGUF_DIR/qwen3-8b-production-v1-Q4_K_M.gguf"
LORA_FILE="$GGUF_DIR/customer-service-production-v1-lora.gguf"

if [ ! -f "$Q4_FILE" ]; then
  echo "[FAIL] 未找到 Q4_K_M 文件：$Q4_FILE" >&2
  exit 1
fi
if [ ! -f "$LORA_FILE" ]; then
  echo "[FAIL] 未找到 LoRA GGUF：$LORA_FILE" >&2
  exit 1
fi
if [ ! -f "$MANIFEST_PATH" ]; then
  echo "[FAIL] 未找到受控 manifest：$MANIFEST_PATH" >&2
  exit 1
fi

if [ -e "$BACKUP_DIR" ] && [ -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
  echo "[FAIL] 备份目录已存在且非空：$BACKUP_DIR，拒绝覆盖。" >&2
  echo "       如需重新生成，请先移走该目录或改用其他 BACKUP_DIR。" >&2
  exit 1
fi
mkdir -p "$BACKUP_DIR"

echo "=== 分片 Q4_K_M（chunk size < 1.9GiB）==="
split -b "$CHUNK_SIZE" "$Q4_FILE" "$BACKUP_DIR/qwen3-8b-production-v1-Q4_K_M.gguf.part-"
CHUNK_COUNT=$(ls "$BACKUP_DIR"/qwen3-8b-production-v1-Q4_K_M.gguf.part-* | wc -l | tr -d ' ')
echo "生成 $CHUNK_COUNT 个分片"

echo "=== 拷贝 Adapter GGUF（不分片，仅 87MB）==="
cp "$LORA_FILE" "$BACKUP_DIR/"

echo "=== 拷贝受控 manifest ==="
cp "$MANIFEST_PATH" "$BACKUP_DIR/"

echo "=== 生成 SHA256SUMS.txt ==="
(
  cd "$BACKUP_DIR"
  shasum -a 256 qwen3-8b-production-v1-Q4_K_M.gguf.part-* \
               customer-service-production-v1-lora.gguf \
               customer-service-production-v1.gguf.json \
    > SHA256SUMS.txt
)

WHOLE_SHA="$(shasum -a 256 "$Q4_FILE" | awk '{print $1}')"

cat > "$BACKUP_DIR/RESTORE.md" <<EOF
# GGUF 备份重组说明

分片数：$CHUNK_COUNT（每片 < 1.9GiB，兼容 GitHub Release 单文件 2GiB 限制）
Q4_K_M 完整文件 SHA-256（重组后必须等于此值）：\`$WHOLE_SHA\`

## 重组命令

\`\`\`bash
cat qwen3-8b-production-v1-Q4_K_M.gguf.part-* > qwen3-8b-production-v1-Q4_K_M.gguf
shasum -a 256 qwen3-8b-production-v1-Q4_K_M.gguf
# 期望：$WHOLE_SHA
\`\`\`

## 分片与其余文件校验

\`\`\`bash
shasum -a 256 -c SHA256SUMS.txt
\`\`\`

## 恢复到运行位置

\`\`\`bash
mkdir -p models/gguf/qwen3-8b-production-v1
cp qwen3-8b-production-v1-Q4_K_M.gguf models/gguf/qwen3-8b-production-v1/
cp customer-service-production-v1-lora.gguf models/gguf/qwen3-8b-production-v1/
# manifest 已在仓库里（services/manifests/），无需从备份复制，
# 只用来核对 customer-service-production-v1.gguf.json 里的 SHA-256 是否与
# 重组后的两份 GGUF 一致。
bash services/llama-server-up.sh   # 会自动做 manifest + upstream 身份双重校验
\`\`\`

**本轮只生成，不上传，不删除 F16 中间产物**（\`$GGUF_DIR/qwen3-8b-production-v1-f16.gguf\`）。
是否上传到 GitHub Release 等 Review 确认。
EOF

echo ""
echo "=== 完成 ==="
du -sh "$BACKUP_DIR"
ls -la "$BACKUP_DIR"
echo ""
echo "备份目录：$BACKUP_DIR"
echo "未上传、未删除 F16。"
