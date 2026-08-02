#!/usr/bin/env bash
# 阶段 08 · 打包备份。只打包最佳 Adapter 的重载必需文件，不含训练状态。
# 打包后解压回验；不删除原 checkpoint。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "08-package"
stage_require "07-adapter-test"

BEST="$(cat "$STATE_DIR/best-checkpoint.path")"
BASE_REPORT="$(cat "$STATE_DIR/base-eval.path" 2>/dev/null || true)"
ADAPTER_REPORT="$(cat "$STATE_DIR/adapter-eval.path" 2>/dev/null || true)"

run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/package_adapter.py" \
  --adapter-path "$BEST" \
  --fallback-dir "$TRAINER_OUTPUT_DIR" --selection-dir "$CONTROL_DIR/selection" \
  --out-dir "$CONTROL_DIR/package" \
  --name customer-service-production-v1 \
  --base-eval-report "$BASE_REPORT" \
  --eval-report "$ADAPTER_REPORT" \
  || die "打包或解压回验失败。原 checkpoint 未被改动。"

say ""
ok "打包完成，原 checkpoint 保留在 $BEST"
say ""
say "  下载回 Mac（在 Mac 上执行）："
say "    scp -r <user>@<4090>:$CONTROL_DIR/package        ~/Documents/ai客服-artifacts/"
say "    scp -r <user>@<4090>:$CONTROL_DIR/evaluation     ~/Documents/ai客服-artifacts/"
say "    scp -r <user>@<4090>:$CONTROL_DIR/logs           ~/Documents/ai客服-artifacts/"
say "    scp -r <user>@<4090>:$CONTROL_DIR/selection      ~/Documents/ai客服-artifacts/"
say ""
say "  下载后务必在 Mac 上核对归档 SHA-256 与 manifest 一致，再考虑释放 4090。"
stage_done
