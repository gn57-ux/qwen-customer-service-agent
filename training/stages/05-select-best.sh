#!/usr/bin/env bash
# 阶段 05 · 最佳 checkpoint 选择。依据只有 validation eval_loss。
# test-80 在本阶段不被读取。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "05-select-best"
stage_require "04-train"

run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/select_best_checkpoint.py" \
  --output-dir "$TRAINER_OUTPUT_DIR" --report-dir "$CONTROL_DIR/selection" \
  || die "checkpoint 选择失败：未找到 trainer_state.json、缺少 best_model_checkpoint，
或状态自相矛盾。现场保持原样，请人工确认。"

BEST="$("$PY" - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.environ["CONTROL_DIR"]) / "selection/checkpoint-selection.json"
print(json.loads(p.read_text(encoding="utf-8"))["best_model_checkpoint"])
PYEOF
)"
[ -n "$BEST" ] && [ -d "$BEST" ] || die "最佳 checkpoint 路径无效：$BEST"
printf '%s\n' "$BEST" > "$STATE_DIR/best-checkpoint.path"
say ""
ok "最佳 checkpoint：$BEST"
say "  已记录到 $STATE_DIR/best-checkpoint.path，供阶段 06/07/08 使用。"
stage_done
