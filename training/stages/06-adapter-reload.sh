#!/usr/bin/env bash
# 阶段 06 · Adapter 重载校验：Base 4-bit + 最佳 Adapter，最小推理 smoke。
# 不做模型融合。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "06-adapter-reload"
stage_require "05-select-best"

[ "$(uname -s)" = "Linux" ] || die "Adapter 重载校验需要 CUDA，只能在 4090 上执行。"
assert_base_model_present

BEST="$(cat "$STATE_DIR/best-checkpoint.path" 2>/dev/null || true)"
[ -n "$BEST" ] || die "未找到阶段 05 记录的最佳 checkpoint 路径"
[ -d "$BEST" ] || die "最佳 checkpoint 目录不存在：$BEST"

say ""
say "  Adapter：$BEST"
run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/adapter_reload_check.py" \
  --adapter-path "$BEST" \
  --report-dir "$CONTROL_DIR/adapter-reload" \
  || die "Adapter 重载校验失败（peft_type 非 LORA、加载异常或 smoke 无输出）。
现场保持原样，未做任何删除。"

say ""
ok "Adapter 可在 Base 4-bit 之上正常重载，最小推理有非空输出"
say "  说明：本阶段只证明'能加载能出字'，回答质量由阶段 07 的 test-80 终测判定。"
stage_done
