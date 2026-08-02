#!/usr/bin/env bash
# 分阶段编排入口。**不提供全自动串跑** —— 每个阶段跑完由人看结果再决定是否继续。
#
#   bash training/run.sh list
#   bash training/run.sh status
#   bash training/run.sh <阶段名>
#
# 阶段名：preflight preprocess base-eval train select-best adapter-reload adapter-test package
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

declare -a ORDER=(
  "preflight:01-preflight"
  "preprocess:02-preprocess"
  "base-eval:03-base-eval"
  "train:04-train"
  "select-best:05-select-best"
  "adapter-reload:06-adapter-reload"
  "adapter-test:07-adapter-test"
  "package:08-package"
)

resolve() {
  local want="$1"
  for e in "${ORDER[@]}"; do
    [ "${e%%:*}" = "$want" ] && { printf '%s\n' "${e#*:}"; return 0; }
  done
  return 1
}

cmd_list() {
  say "阶段（必须按顺序执行，前一阶段成功才允许进入下一阶段）："
  say ""
  local i=1
  for e in "${ORDER[@]}"; do
    printf '  %d. %-16s → training/stages/%s.sh\n' "$i" "${e%%:*}" "${e#*:}"
    i=$((i + 1))
  done
  say ""
  say "Mac 可运行：preflight（部分项标记待验证）、preprocess（同上）"
  say "仅 4090   ：base-eval / train / select-best / adapter-reload / adapter-test / package"
}

cmd_status() {
  say "Trainer 目录：$TRAINER_OUTPUT_DIR"
  say "Control 目录：$CONTROL_DIR"
  say ""
  for e in "${ORDER[@]}"; do
    local name="${e%%:*}" script="${e#*:}"
    if [ -f "$STATE_DIR/$script.ok" ]; then
      printf '  [完成] %-16s %s\n' "$name" "$(cat "$STATE_DIR/$script.ok")"
    else
      printf '  [待做] %-16s\n' "$name"
    fi
  done
  say ""
  [ -f "$STATE_DIR/best-checkpoint.path" ] && \
    say "最佳 checkpoint：$(cat "$STATE_DIR/best-checkpoint.path")"
  return 0
}

main() {
  local target="${1:-}"
  case "$target" in
    ""|list|-h|--help|help) cmd_list ;;
    status) cmd_status ;;
    *)
      local script
      script="$(resolve "$target")" || { say "未知阶段：$target"; say ""; cmd_list; exit 2; }
      exec bash "$TRAINING_ROOT/stages/$script.sh"
      ;;
  esac
}

main "$@"
