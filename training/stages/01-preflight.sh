#!/usr/bin/env bash
# 阶段 01 · 输入准入。任何关键项失败即非零退出，不得进入后续阶段。
#
# 只在 4090 上完整通过；在 Mac 上运行时，GPU/CUDA/LLaMA Factory 相关项
# 会标记为"4090 真机待验证"，同时数据/配置类检查照常严格执行。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "01-preflight"
REPORT="$CONTROL_DIR/preflight/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
mkdir -p "$(dirname "$REPORT")"
exec > >(tee -a "$REPORT") 2>&1

FAILED=0
IS_LINUX=0
[ "$(uname -s)" = "Linux" ] && IS_LINUX=1

# ---- 1. git ---------------------------------------------------------------
say ""
say "--- 1. 代码版本 ---"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  ok "commit=$COMMIT branch=$BRANCH"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    warn "工作区有未提交改动；训练可复现性以 commit 为准，请确认这些改动是否应当入库"
    git -C "$REPO_ROOT" status --short | sed 's/^/         /'
  else
    ok "工作区干净"
  fi
else
  die "不是 git 仓库：$REPO_ROOT"
fi

# ---- 2. GPU ---------------------------------------------------------------
say ""
say "--- 2. GPU ---"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version \
             --format=csv,noheader | sed 's/^/         /'
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  GPU_MEM="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)"
  ok "GPU=$GPU_NAME  显存=${GPU_MEM}MiB"
  if [ "${GPU_MEM:-0}" -lt 20000 ]; then
    die "显存 ${GPU_MEM}MiB 低于 QLoRA 8B 所需的约 24GB，禁止继续"
  fi
elif [ "$IS_LINUX" = "1" ]; then
  die "未找到 nvidia-smi；4090 上必须可用"
else
  pend "本机无 nvidia-smi（非 Linux），GPU 检查在 4090 上执行"
fi

# ---- 3. Python / PyTorch / CUDA ------------------------------------------
say ""
say "--- 3. Python / PyTorch / CUDA ---"
say "         python=$("$PY" -V 2>&1)"
if "$PY" - <<'PYEOF'
import sys
try:
    import torch
except ImportError:
    print("         torch 未安装")
    sys.exit(3)
print(f"         torch={torch.__version__}  cuda_available={torch.cuda.is_available()}  "
      f"cuda={torch.version.cuda}  bf16={torch.cuda.is_bf16_supported() if torch.cuda.is_available() else 'n/a'}")
sys.exit(0 if torch.cuda.is_available() else 4)
PYEOF
then
  ok "PyTorch + CUDA 可用"
else
  rc=$?
  if [ "$IS_LINUX" = "1" ]; then
    die "PyTorch/CUDA 不可用（rc=${rc}）；4090 上必须可用"
  else
    pend "本机 PyTorch/CUDA 不可用（rc=${rc}），该项在 4090 上执行"
  fi
fi

# ---- 4. 训练栈版本 --------------------------------------------------------
say ""
say "--- 4. 训练栈版本 ---"
"$PY" - <<'PYEOF' || true
import importlib.metadata as md
for name in ("llamafactory", "transformers", "peft", "bitsandbytes",
             "accelerate", "datasets", "trl"):
    try:
        print(f"         {name:<16} {md.version(name)}")
    except Exception:
        print(f"         {name:<16} 未安装")
PYEOF
if command -v llamafactory-cli >/dev/null 2>&1; then
  ok "llamafactory-cli 可用：$(command -v llamafactory-cli)"
elif [ "$IS_LINUX" = "1" ]; then
  die "未找到 llamafactory-cli；4090 上必须可用（期望 LLaMA Factory 0.9.5）"
else
  pend "本机无 llamafactory-cli，该项在 4090 上执行"
fi

# ---- 5. 基础模型 ----------------------------------------------------------
say ""
say "--- 5. 基础模型 ---"
BASE_PATH="$(cfg_get model_name_or_path)"
BASE_REV="$(cfg_get model_revision)"
say "         期望路径 : $BASE_PATH"
say "         期望 rev : $BASE_REV"
if [ ! -d "$BASE_PATH" ]; then
  HF_CACHE="${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
  if [ -d "$HF_CACHE" ] && ls "$HF_CACHE" 2>/dev/null | grep -q "Qwen3-8B"; then
    warn "模型目录不存在，但 HF 缓存里发现 Qwen3-8B：$HF_CACHE"
    warn "训练配置指向本地路径，请人工决定是从缓存导出还是修改路径；本脚本不自动处理。"
  else
    say "         HF 缓存  : ${HF_CACHE}（未发现 Qwen3-8B）"
  fi
fi
# Linux 上 assert_base_model_present 内部会 die；Mac 上返回非零并打 PENDING。
# 用 if 包住，避免 set -e 在 Mac 上直接中断准入。
if assert_base_model_present; then
  say "         目录大小 : $(du -sh "$BASE_PATH" 2>/dev/null | cut -f1)"
  say "         revision 证据：$CONTROL_DIR/preflight/model-revision.json"
fi

# ---- 6. 数据条数 / SHA-256 / dataset_info / test 隔离 --------------------
say ""
say "--- 6. 数据与配置 ---"
if "$PY" - <<'PYEOF'
import sys, json
sys.path.insert(0, __import__("os").environ["TOOLS_DIR"])
import gate_common as G
try:
    data = G.verify_datasets()
    for split, v in data.items():
        if split == "_problems":
            continue
        print(f"         {split:<11} {v['count']:>4} 条  sha256={v['sha256']}  "
              f"绑定一致={v['config_binding_match']}")
    print("        ", G.assert_no_test_in_training_config())
    print("        ", G.verify_dataset_info())
    print("        ", G.assert_output_dirs_disjoint())
except G.GateError as exc:
    print(f"         {exc}")
    sys.exit(1)
PYEOF
then
  ok "三份数据条数与 SHA-256 与 manifest/训练配置一致"
  ok "dataset_info.json 注册完整（含 observation_tag / function_tag）"
  ok "test-80 未出现在训练配置的 dataset / eval_dataset"
else
  FAILED=1
  say "  [FAIL] 数据/配置校验失败"
fi

# ---- 7. 数据审计 ----------------------------------------------------------
say ""
say "--- 7. 数据集审计 ---"
if "$PY" "$REPO_ROOT/scripts/audit_customer_service_dataset.py" >"$LOG_DIR/audit.log" 2>&1; then
  ok "审计退出码 0；摘要：$(grep -E '^最终结果' "$LOG_DIR/audit.log" | head -1)"
else
  FAILED=1
  say "  [FAIL] 数据集审计未通过，详见 $LOG_DIR/audit.log"
  tail -20 "$LOG_DIR/audit.log" | sed 's/^/         /'
fi

# ---- 8. dataset_dir 路径一致性 -------------------------------------------
say ""
say "--- 8. dataset_dir ---"
DATASET_DIR="$(cfg_get dataset_dir)"
say "         配置值 : $DATASET_DIR"
say "         实际值 : $REPO_ROOT/datasets"
if [ "$DATASET_DIR" = "$REPO_ROOT/datasets" ]; then
  ok "dataset_dir 与当前仓库路径一致"
elif [ "$IS_LINUX" = "1" ]; then
  die "dataset_dir 与仓库实际路径不符。请把仓库放到 $(dirname "$DATASET_DIR") 下，
或人工修改训练配置后重新核对 SHA 绑定。本脚本不擅自改配置。"
else
  pend "Mac 上路径不同属正常；4090 上仓库须位于 $(dirname "$DATASET_DIR")"
fi

# ---- 9. 输出目录与磁盘 ---------------------------------------------------
say ""
say "--- 9. 输出目录与磁盘 ---"
assert_no_smoke_overlap
# 本阶段**只**建 CONTROL_DIR；TRAINER_OUTPUT_DIR 必须保持不存在或为空。
mkdir -p "$CONTROL_DIR"
if [ -d "$TRAINER_OUTPUT_DIR" ] && ls "$TRAINER_OUTPUT_DIR"/checkpoint-* >/dev/null 2>&1; then
  warn "Trainer 输出目录已存在 checkpoint：$TRAINER_OUTPUT_DIR"
  warn "训练配置 overwrite_output_dir=$(cfg_get overwrite_output_dir)；"
  warn "本执行包不会删除、覆盖或自动续训，阶段 04 会因目录非空而拒绝启动。"
fi
assert_trainer_dir_pristine
DISK_TARGET="$CONTROL_DIR"
DISK_AVAIL_KB="$(df -Pk "$DISK_TARGET" | awk 'NR==2{print $4}')"
DISK_AVAIL_GB=$(( DISK_AVAIL_KB / 1024 / 1024 ))
say "         可用磁盘 : ${DISK_AVAIL_GB} GB（${DISK_TARGET}）"
if [ "$DISK_AVAIL_GB" -lt 60 ]; then
  if [ "$IS_LINUX" = "1" ]; then
    die "可用磁盘 ${DISK_AVAIL_GB}GB 不足；基础模型约 16GB + 3 个 checkpoint + 日志，建议 ≥60GB"
  else
    warn "可用磁盘 ${DISK_AVAIL_GB}GB（Mac 上不训练，仅提示）"
  fi
else
  ok "磁盘可用 ${DISK_AVAIL_GB} GB"
fi

# ---- 结论 -----------------------------------------------------------------
say ""
if [ "$FAILED" -ne 0 ]; then
  die "准入未通过，禁止进入预处理与训练阶段。报告：$REPORT"
fi
assert_trainer_dir_pristine
ok "准入通过。报告：$REPORT"
stage_done
