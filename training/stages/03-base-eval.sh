#!/usr/bin/env bash
# 阶段 03 · Base 基线评测（test-80）。
#
# 允许在正式训练前运行。硬性边界：
# - 结果**只作基线记录**，不得据此修改 test 集、调超参或选择 checkpoint；
# - 与阶段 07 的 Adapter 终测共用同一份代码、同一份生成参数、同一份 test-80，
#   可比性由 training/tools/evaluate.py 的单一常量保证。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "03-base-eval"
stage_require "01-preflight" "02-preprocess"

[ "$(uname -s)" = "Linux" ] || die "Base 评测需要加载 8B 模型，只能在 4090 上执行。"
assert_base_model_present

EVAL_DIR="$CONTROL_DIR/evaluation"
mkdir -p "$EVAL_DIR"

say ""
say "  test-80 只在本脚本与阶段 07 被读取；不参与训练、调参、checkpoint 选择。"
say ""

run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/evaluate.py" \
  --mode base \
  --output-dir "$EVAL_DIR" \
  || die "Base 评测失败"

LATEST="$(ls -t "$EVAL_DIR"/eval-base-*.summary.json 2>/dev/null | head -1)"
[ -n "$LATEST" ] || die "未生成 Base 评测报告"
say ""
ok "Base 基线报告：$LATEST"
printf '%s\n' "$LATEST" > "$STATE_DIR/base-eval.path"
say ""
say "  提醒：本结果是基线，不能用来改 test 集或选 checkpoint。"
stage_done
