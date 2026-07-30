#!/usr/bin/env bash
# 4090 执行包的共享 shell 层。被 training/stages/*.sh source。
#
# 约定：
# - 任何关键项失败 → 调用 die，非零退出，绝不"警告后继续"。
# - 不下载模型、不安装依赖、不删除任何既有产物。
# - 参数只有一份来源：configs/train-qwen3-8b-qlora-production-linux.yaml。

set -euo pipefail

TRAINING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$TRAINING_ROOT/.." && pwd)"
TOOLS_DIR="$TRAINING_ROOT/tools"
PROD_CONFIG="$REPO_ROOT/configs/train-qwen3-8b-qlora-production-linux.yaml"
SMOKE_CONFIG="$REPO_ROOT/configs/train-qwen3-8b-qlora-smoke-linux.yaml"

PY="${PYTHON_BIN:-python3}"

# 供内联 python 读取（脚本里用 os.environ 取，避免把路径拼进 heredoc）
export TOOLS_DIR REPO_ROOT TRAINING_ROOT

# ---- 输出 -----------------------------------------------------------------
_ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
say()  { printf '%s\n' "$*"; }
head1() { printf '\n%s\n%s\n%s\n' "==============================================================================" "$*" "=============================================================================="; }
ok()   { printf '  [PASS] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
pend() { printf '  [4090 真机待验证] %s\n' "$*"; }
die()  { printf '\n  [FAIL] %s\n' "$*" >&2; exit 1; }

# ---- 配置读取（唯一来源）--------------------------------------------------
# 只读顶层标量，与 training/tools/gate_common.py 的解析口径一致。
cfg_get() {
  local key="$1" file="${2:-$PROD_CONFIG}"
  [ -f "$file" ] || die "配置文件不存在：$file"
  awk -v k="$key" '
    /^[[:space:]#]/ { next }
    {
      idx = index($0, ":")
      if (idx == 0) next
      name = substr($0, 1, idx - 1)
      if (name != k) next
      val = substr($0, idx + 1)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+#.*$/, "", val)
      sub(/[[:space:]]+$/, "", val)
      gsub(/^["'\'']|["'\'']$/, "", val)
      print val
      exit
    }' "$file"
}

# ---------------------------------------------------------------------------
# 两个目录，职责严格分离
# ---------------------------------------------------------------------------
# TRAINER_OUTPUT_DIR：**只**给 LLaMA Factory 用。checkpoint / trainer_state.json /
#   tokenizer 资产 / training_loss.png 都在这里。正式开训前必须不存在或为空 ——
#   流程产物一律不许写进来，否则 04 阶段的"目录必须为空"门禁就永远过不了。
# CONTROL_DIR：流程侧的一切 —— 日志、阶段状态、准入/预处理报告、Base/Adapter
#   评测、selection、package、run-meta。
TRAINER_OUTPUT_DIR="${TRAINER_OUTPUT_DIR_OVERRIDE:-$(cfg_get output_dir 2>/dev/null || true)}"
SMOKE_OUTPUT_DIR="$(cfg_get output_dir "$SMOKE_CONFIG" 2>/dev/null || true)"
CONTROL_DIR="${TRAINING_CONTROL_DIR:-${TRAINER_OUTPUT_DIR}-control}"

LOG_DIR="$CONTROL_DIR/logs"
STATE_DIR="$CONTROL_DIR/stage-state"
export TRAINER_OUTPUT_DIR CONTROL_DIR LOG_DIR STATE_DIR SMOKE_OUTPUT_DIR

# ---- 阶段状态：上一阶段成功才允许进入下一阶段 -----------------------------
stage_begin() {
  STAGE_NAME="$1"
  # 只创建 CONTROL_DIR；TRAINER_OUTPUT_DIR 由 LLaMA Factory 自己在 04 阶段建。
  mkdir -p "$LOG_DIR" "$STATE_DIR"
  STAGE_LOG="$LOG_DIR/${STAGE_NAME}-$(date -u +%Y%m%dT%H%M%SZ).log"
  head1 "阶段 ${STAGE_NAME}    $(_ts)"
  say "  仓库          : $REPO_ROOT"
  say "  Trainer 目录  : $TRAINER_OUTPUT_DIR   （只给 LLaMA Factory）"
  say "  Control 目录  : $CONTROL_DIR   （流程产物）"
  say "  日志          : $STAGE_LOG"
}

stage_require() {
  # stage_require <前置阶段名> …
  local missing=()
  for s in "$@"; do
    [ -f "$STATE_DIR/$s.ok" ] || missing+=("$s")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "前置阶段未成功完成：${missing[*]}
请先执行它们；每个阶段成功后会在 $STATE_DIR 写入 <阶段名>.ok。"
  fi
}

stage_done() {
  printf '%s\n' "$(_ts)" > "$STATE_DIR/${STAGE_NAME}.ok"
  say ""
  say "  阶段 ${STAGE_NAME} 完成 → $STATE_DIR/${STAGE_NAME}.ok"
}

# ---- 通用门禁 -------------------------------------------------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1（$2）"
}

assert_no_smoke_overlap() {
  local prod="$TRAINER_OUTPUT_DIR" smoke="$SMOKE_OUTPUT_DIR" ctrl="$CONTROL_DIR"
  [ -n "$prod" ] || die "无法从训练配置读取 output_dir"
  if [ -n "$smoke" ]; then
    [ "$prod" != "$smoke" ] || die "Trainer 输出目录与 Smoke 目录相同：$prod"
    case "$prod/" in "$smoke"/*) die "Trainer 输出目录位于 Smoke 目录内：$prod";; esac
    case "$smoke/" in "$prod"/*) die "Smoke 目录位于 Trainer 输出目录内：$smoke";; esac
    [ "$ctrl" != "$smoke" ] || die "Control 目录与 Smoke 目录相同：$ctrl"
  fi
  # Control 与 Trainer 也必须互不嵌套，否则流程产物会污染"目录必须为空"的判定
  [ "$ctrl" != "$prod" ] || die "Control 目录不能等于 Trainer 输出目录：$ctrl"
  case "$ctrl/" in "$prod"/*) die "Control 目录位于 Trainer 输出目录内：$ctrl";; esac
  case "$prod/" in "$ctrl"/*) die "Trainer 输出目录位于 Control 目录内：$prod";; esac
  ok "目录三方分离（trainer=$prod, control=$ctrl, smoke=${smoke:-未配置}）"
}

# 01–03 阶段结束时调用：证明流程没有提前碰 Trainer 目录
assert_trainer_dir_pristine() {
  local d="$TRAINER_OUTPUT_DIR"
  if [ ! -e "$d" ]; then
    ok "Trainer 输出目录尚不存在（符合预期）：$d"
    return 0
  fi
  [ -d "$d" ] || die "Trainer 输出目录路径被占用且不是目录：$d"
  local n
  n="$(find "$d" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$n" = "0" ]; then
    ok "Trainer 输出目录存在但为空（符合预期）：$d"
    return 0
  fi
  die "Trainer 输出目录在开训前已有 $n 个条目：$d
本阶段不应写入该目录。请人工确认这些内容的来源：
  ls -la $d
若是历史训练产物，请改用新的 TRAINER_OUTPUT_DIR_OVERRIDE 或人工移走，
本脚本不会自动删除、覆盖或续训。"
}

# 基础模型 + revision 门禁。
# Linux（4090）：无法用证据证明 revision 一律 FAIL，不接受"人工确认后继续"。
# 非 Linux（Mac）：模型本就不该存在，标记为待验证并返回非零，由调用方决定是否放行。
assert_base_model_present() {
  local base; base="$(cfg_get model_name_or_path)"
  local rev;  rev="$(cfg_get model_revision)"
  local is_linux=0
  [ "$(uname -s)" = "Linux" ] && is_linux=1

  if [ ! -d "$base" ]; then
    if [ "$is_linux" = "1" ]; then
      die "基础模型目录不存在：$base
本执行包**不会自动下载模型**。请人工确认来源与许可证后准备好权重，
核对 revision=${rev}，再重跑本阶段。
排查命令：$PY $TOOLS_DIR/verify_model_revision.py --model-dir $base --inspect"
    fi
    pend "本机没有基础模型（Mac 不承担训练）；4090 上必须存在且 revision 可证"
    return 1
  fi
  ok "基础模型目录存在：$base"

  local rev_json="${CONTROL_DIR:-/tmp}/preflight/model-revision.json"
  if "$PY" "$TOOLS_DIR/verify_model_revision.py" \
        --model-dir "$base" --expect "$rev" --json-out "$rev_json"; then
    ok "基础模型 revision 已由可信证据证明并匹配（详见 ${rev_json}）"
    return 0
  fi
  if [ "$is_linux" = "1" ]; then
    die "基础模型 revision 未能证明或不匹配，禁止继续。
不接受人工口头确认；请按上面的只读命令排查，或补一份带文件 SHA-256 的 manifest：
  $PY $TOOLS_DIR/verify_model_revision.py --manifest-schema"
  fi
  pend "本机无法证明 revision（Mac 上属预期）；4090 上此项为硬门禁"
  return 1
}

run_logged() {
  # run_logged <日志文件> <命令…>：同时落盘 stdout/stderr 并保留退出码
  local log="$1"; shift
  set +e
  "$@" 2>&1 | tee -a "$log"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}
