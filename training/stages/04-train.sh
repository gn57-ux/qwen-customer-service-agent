#!/usr/bin/env bash
# 阶段 04 · 正式 QLoRA 训练。
#
# 参数来源唯一：configs/train-qwen3-8b-qlora-production-linux.yaml。
# 本脚本**不传任何超参覆盖**，只负责门禁、日志与运行记录。
#
# 失败时保持现场：不删除 checkpoint、不清理输出目录、不回滚任何文件。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "04-train"
stage_require "01-preflight" "02-preprocess"

[ "$(uname -s)" = "Linux" ] || die "训练只能在 4090（Linux）上执行。"
require_cmd llamafactory-cli "LLaMA Factory 0.9.5"
require_cmd nvidia-smi "NVIDIA 驱动"

# ---- 训练前再次门禁 -------------------------------------------------------
say ""
say "--- 开训前复检 ---"
assert_no_smoke_overlap
assert_base_model_present

"$PY" - <<'PYEOF' || die "开训前数据/配置复检失败"
import os, sys
sys.path.insert(0, os.environ["TOOLS_DIR"])
import gate_common as G
G.verify_datasets()
G.assert_no_test_in_training_config()
G.verify_dataset_info()
G.assert_output_dirs_disjoint()
print("         数据 SHA-256、dataset_info、test 隔离、输出目录分离 —— 全部通过")
PYEOF
ok "开训前复检通过"

if [ "$(cfg_get overwrite_output_dir)" != "false" ]; then
  die "训练配置 overwrite_output_dir 不是 false，可能覆盖既有产物，禁止继续。"
fi
if [ "$TRAINER_OUTPUT_DIR" = "$SMOKE_OUTPUT_DIR" ]; then
  die "输出目录等于 Smoke 目录，禁止继续。"
fi
ok "overwrite_output_dir=false，且不会写入 Smoke 目录"

# ---- Trainer 目录必须为新训练腾空 ----------------------------------------
# 流程产物全在 CONTROL_DIR，所以这里出现任何东西都只可能是历史训练残留。
if [ -e "$TRAINER_OUTPUT_DIR" ]; then
  [ -d "$TRAINER_OUTPUT_DIR" ] || die "Trainer 输出目录路径被非目录占用：$TRAINER_OUTPUT_DIR"
  ENTRIES="$(find "$TRAINER_OUTPUT_DIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  if [ "$ENTRIES" != "0" ]; then
    CKPTS="$(find "$TRAINER_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -name 'checkpoint-*' -type d \
             | sort | sed 's/^/      /')"
    {
      echo "Trainer 输出目录非空，拒绝启动新训练：$TRAINER_OUTPUT_DIR"
      echo "  现有条目数：$ENTRIES"
      [ -n "$CKPTS" ] && { echo "  已存在的 checkpoint："; echo "$CKPTS"; }
      echo ""
      echo "本脚本**不会**自动续训、删除或覆盖。请人工在三种方案中选择："
      echo "  A) 换目录重训：TRAINER_OUTPUT_DIR_OVERRIDE=<新路径> bash training/run.sh train"
      echo "     （同时建议一并设置 TRAINING_CONTROL_DIR，保持两套产物成对）"
      echo "  B) 归档后重训：人工把该目录移走（mv），确认无误后重跑本阶段"
      echo "  C) 确认要基于既有 checkpoint 续训：这属于另一种训练语义，"
      echo "     需要显式修改训练配置（resume_from_checkpoint），不在本执行包的范围内"
      echo ""
      echo "在你做出选择之前，本阶段不会执行任何写操作。"
    } >&2
    exit 1
  fi
fi
ok "Trainer 输出目录为新训练腾空（不存在或为空）"

# ---- 运行记录 -------------------------------------------------------------
RUN_ID="train-$(date -u +%Y%m%dT%H%M%SZ)"
TRAIN_LOG="$LOG_DIR/$RUN_ID.log"
RUN_META="$CONTROL_DIR/run-meta/$RUN_ID.json"
mkdir -p "$(dirname "$RUN_META")"

START_TS="$(_ts)"
"$PY" - <<PYEOF > "$RUN_META"
import json, os, subprocess, sys
sys.path.insert(0, os.environ["TOOLS_DIR"])
import gate_common as G
cfg = G.production_config()
data = G.verify_datasets()
print(json.dumps({
  "run_id": "$RUN_ID",
  "started_at": "$START_TS",
  "finished_at": None,
  "status": "running",
  "git": G.git_state(),
  "train_config": {"path": str(G.CONFIG_PRODUCTION), "sha256": G.config_sha256()},
  "base_model": {"path": cfg.get("model_name_or_path"),
                 "revision": cfg.get("model_revision")},
  "dataset_sha256": {k: v["sha256"] for k, v in data.items() if k != "_problems"},
  "dataset": cfg.get("dataset"), "eval_dataset": cfg.get("eval_dataset"),
  "test_dataset_used": False,
  "output_dir": cfg.get("output_dir"),
  "log": "$TRAIN_LOG",
}, ensure_ascii=False, indent=2))
PYEOF
say ""
ok "运行元数据：$RUN_META"

# ---- 训练 -----------------------------------------------------------------
say ""
head1 "开始训练  $START_TS"
say "  配置：$PROD_CONFIG"
say "  日志：$TRAIN_LOG"
say "  中断后不会自动清理任何 checkpoint。"
say ""

set +e
llamafactory-cli train "$PROD_CONFIG" 2>&1 | tee -a "$TRAIN_LOG"
TRAIN_RC=${PIPESTATUS[0]}
set -e
END_TS="$(_ts)"

"$PY" - <<PYEOF
import json, pathlib
p = pathlib.Path("$RUN_META")
meta = json.loads(p.read_text(encoding="utf-8"))
meta["finished_at"] = "$END_TS"
meta["status"] = "succeeded" if $TRAIN_RC == 0 else "failed"
meta["exit_code"] = $TRAIN_RC
p.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PYEOF

if [ "$TRAIN_RC" -ne 0 ]; then
  say ""
  say "  训练失败（退出码 ${TRAIN_RC}）。现场已保留："
  say "    Trainer 目录 : $TRAINER_OUTPUT_DIR"
  say "    Control 目录 : $CONTROL_DIR"
  say "    日志     : $TRAIN_LOG"
  say "    运行记录 : $RUN_META"
  say "  已有 checkpoint 未被删除。请人工排查后决定续跑或换目录重跑。"
  die "训练未成功，禁止进入 checkpoint 选择阶段。"
fi

say ""
ok "训练完成：$START_TS → $END_TS"
if [ -f "$TRAINER_OUTPUT_DIR/trainer_state.json" ]; then
  ok "trainer_state.json 已生成"
else
  die "训练返回 0 但缺少 trainer_state.json，状态异常，请人工确认。"
fi
say "  validation eval_loss 曲线见 $TRAINER_OUTPUT_DIR/trainer_state.json 与 training_loss.png"
stage_done
