#!/usr/bin/env bash
# 阶段 02 · 真机预处理门禁。只处理 train-640 + validation-80。
#
# 两条证据链：
#   A) 纯 Python 侧（Mac 也能跑）：角色序列、tool_response 包裹、损失掩码归属、
#      长度分布、截断率 —— 由 training/tools/preprocess_report.py 产出。
#   B) LLaMA Factory 侧（只能在 4090 跑）：用 llamafactory-cli 真实读取数据集，
#      证明 0.9.5 能把 640/80 条转换成功且不产生 broken_data。
# B 的日志回填给 A，最终报告里"LLaMA Factory 实际读取成功"才会从
# "4090 真机待验证"变成 PASS。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "02-preprocess"
stage_require "01-preflight"

IS_LINUX=0
[ "$(uname -s)" = "Linux" ] && IS_LINUX=1
LF_LOG="$LOG_DIR/llamafactory-preprocess-$(date -u +%Y%m%dT%H%M%SZ).log"
LF_ARG=()

# ---- B. LLaMA Factory 真实读取 -------------------------------------------
say ""
say "--- LLaMA Factory 数据加载验证 ---"
if command -v llamafactory-cli >/dev/null 2>&1; then
  assert_base_model_present
  TOKENIZED="$CONTROL_DIR/tokenized-preprocess"
  if [ -e "$TOKENIZED" ]; then
    die "预处理缓存目录已存在：$TOKENIZED
本脚本不删除既有产物。请人工确认后改名或移走，再重跑本阶段。"
  fi
  say "  以 --do_train false 仅做数据加载与分词，不进入优化器循环。"
  say "  日志：$LF_LOG"
  # 只覆盖与"不训练"相关的开关，其余参数一律沿用 production YAML，
  # 不在这里重复定义任何超参。
  set +e
  run_logged "$LF_LOG" llamafactory-cli train "$PROD_CONFIG" \
        do_train=false \
        do_eval=false \
        output_dir="$CONTROL_DIR/preprocess-probe" \
        tokenized_path="$TOKENIZED" \
        overwrite_output_dir=true
  LF_RC=$?
  set -e
  say "  llamafactory-cli 退出码：$LF_RC"

  # 判定只看**落盘产物**，不看日志字样。产物不存在就是不通过 ——
  # 若本机 LF 版本不支持 --do_train false + --tokenized_path，到这里必然停下。
  if [ ! -e "$TOKENIZED" ]; then
    die "llamafactory-cli 没有产出 tokenized 数据：$TOKENIZED
    退出码=${LF_RC}，日志：$LF_LOG
请在本机实测该命令是否支持 --do_train false 与 --tokenized_path。
若不支持，**停在这里并报告**，不要凭日志文字放行；确认可行的替代调用方式后再继续。"
  fi
  ok "tokenized 产物已落盘：$TOKENIZED"

  say ""
  say "--- 校验 tokenized 真实张量（条数 / 长度 / labels 掩码）---"
  run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/verify_tokenized.py" \
      --tokenized-path "$TOKENIZED" \
      --tokenizer-path "$(cfg_get model_name_or_path)" \
      --report "$CONTROL_DIR/preprocess/tokenized-verify.json" \
    || die "tokenized 数据校验失败。禁止进入训练阶段。"
  ok "tokenized 数据结构、条数与 label 掩码全部通过"
  LF_ARG=(--lf-log "$LF_LOG" --tokenized-report "$CONTROL_DIR/preprocess/tokenized-verify.json")
elif [ "$IS_LINUX" = "1" ]; then
  die "未找到 llamafactory-cli；4090 上必须可用"
else
  pend "本机无 llamafactory-cli；该证据链只能在 4090 上产生"
fi

# ---- A. 纯 Python 门禁 ----------------------------------------------------
say ""
say "--- 模板 / 角色 / 掩码 / 长度门禁 ---"
TOK_ARG=()
BASE_PATH="$(cfg_get model_name_or_path)"
[ -d "$BASE_PATH" ] && TOK_ARG=(--tokenizer-path "$BASE_PATH")

# ${arr[@]+"${arr[@]}"}：空数组在 set -u 下也安全（兼容 macOS 的 bash 3.2）
set +e
"$PY" "$TOOLS_DIR/preprocess_report.py" --output-dir "$CONTROL_DIR/preprocess" \
  ${TOK_ARG[@]+"${TOK_ARG[@]}"} ${LF_ARG[@]+"${LF_ARG[@]}"} 2>&1 | tee -a "$STAGE_LOG"
RC=${PIPESTATUS[0]}
set -e

say ""
case "$RC" in
  0) ok "预处理门禁全部 PASS" ;;
  2)
    if [ "$IS_LINUX" = "1" ]; then
      die "预处理报告仍有'4090 真机待验证'项，在 4090 上不允许带 PENDING 进入训练。"
    fi
    pend "存在 4090 真机待验证项（Mac 上属预期）。**不得据此进入训练阶段。**"
    say ""
    say "  Mac 侧到此为止：阶段 02 不会标记为完成，训练必须在 4090 上重跑本阶段。"
    exit 0
    ;;
  *) die "预处理门禁 FAIL（rc=${RC}），禁止进入训练阶段。" ;;
esac

# 额外复用：与真实 Qwen3 chat template 交叉比对
say ""
say "--- 与真实 chat_template.jinja 交叉比对 ---"
if run_logged "$STAGE_LOG" "$PY" "$REPO_ROOT/scripts/verify_template_encoding.py" --jinja --show 0; then
  ok "observation 编码与真实 chat template 一致"
else
  die "模板交叉比对失败"
fi

stage_done
