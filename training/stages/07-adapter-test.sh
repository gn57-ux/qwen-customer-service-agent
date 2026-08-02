#!/usr/bin/env bash
# 阶段 07 · 独立终测：同一份 test-80、同一份生成参数，跑 adapter 模式，
# 并与阶段 03 的 Base 基线生成对比报告。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

stage_begin "07-adapter-test"
stage_require "03-base-eval" "06-adapter-reload"

[ "$(uname -s)" = "Linux" ] || die "终测需要 CUDA，只能在 4090 上执行。"
assert_base_model_present

BEST="$(cat "$STATE_DIR/best-checkpoint.path")"
EVAL_DIR="$CONTROL_DIR/evaluation"

run_logged "$STAGE_LOG" "$PY" "$TOOLS_DIR/evaluate.py" \
  --mode adapter \
  --adapter-path "$BEST" \
  --output-dir "$EVAL_DIR" \
  || die "Adapter 终测失败"

ADAPTER_REPORT="$(ls -t "$EVAL_DIR"/eval-adapter-*.summary.json 2>/dev/null | head -1)"
BASE_REPORT="$(cat "$STATE_DIR/base-eval.path" 2>/dev/null || true)"
[ -n "$ADAPTER_REPORT" ] || die "未生成 Adapter 评测报告"
[ -n "$BASE_REPORT" ] && [ -f "$BASE_REPORT" ] || die "未找到 Base 基线报告"

say ""
say "--- 生成 Base vs QLoRA 对比 ---"
"$PY" - "$BASE_REPORT" "$ADAPTER_REPORT" "$EVAL_DIR/base-vs-qlora.md" <<'PYEOF' \
  || die "对比报告生成失败"
import json, sys, pathlib
base = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
adpt = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))

# 可比性硬门禁
for label, rep in (("Base", base), ("Adapter", adpt)):
    if rep.get("dry_run"):
        sys.exit(f"{label} 报告是 --dry-run 产物，不能用于对比。")
    if rep.get("debug"):
        sys.exit(f"{label} 报告是 --debug 产物，不能用于对比。")
    if rep.get("usable_for_comparison") is False:
        sys.exit(f"{label} 报告标记为不可用于对比。")
    if rep["test_set"]["count"] != 80:
        sys.exit(f"{label} 的 test 条数为 {rep['test_set']['count']}，不是 80。")
    if rep["summary"]["count"] != 80 or rep["summary"]["generated"] != 80:
        sys.exit(f"{label} 未跑满：count={rep['summary']['count']} "
                 f"generated={rep['summary']['generated']}，要求均为 80。")
if base["config_fingerprint"] != adpt["config_fingerprint"]:
    sys.exit("Base 与 Adapter 的生成配置指纹不一致，两份结果不可比。")
if base["test_set"]["sha256"] != adpt["test_set"]["sha256"]:
    sys.exit("Base 与 Adapter 使用的 test 集不同，两份结果不可比。")

b, a = base["summary"], adpt["summary"]
rows = [
    ("样本数", "count"), ("成功生成", "generated"), ("空回答率", "empty_rate"),
    ("澄清追问率", "clarify_rate"), ("无依据拒答率", "refusal_rate"),
    ("边界合规率", "boundary_ok_rate"), ("高风险拦截率", "safety_block_rate"),
    ("提示注入拒绝率", "injection_refusal_rate"), ("危险建议命中", "danger_hit"),
    ("订单事实编造", "order_fabrication_hit"), ("无依据断言", "groundless_fact_hit"),
    ("伪造 observation", "forged_observation_hit"), ("平均耗时(ms)", "latency_ms_mean"),
]
L = ["# Base vs QLoRA 对比报告", "",
     f"- test 集：`{base['test_set']['file']}`（{base['test_set']['count']} 条）",
     f"- test SHA-256：`{base['test_set']['sha256']}`",
     f"- 生成配置指纹：`{base['config_fingerprint']}`（两侧一致）",
     f"- Base revision：`{base['model'].get('revision')}`",
     f"- Adapter：`{adpt['model'].get('adapter_path')}`", "",
     "> 下表全部为**规则命中统计**，不代表回答质量。有用性、语气、转述忠实度",
     "> 必须人工复核，见各自报告的人工复核项清单。", "",
     "| 指标 | Base | QLoRA | 变化 |", "|---|---:|---:|---:|"]
for label, key in rows:
    bv, av = b.get(key), a.get(key)
    if isinstance(bv, (int, float)) and isinstance(av, (int, float)):
        d = round(av - bv, 4)
        delta = f"{'+' if d > 0 else ''}{d}"
    else:
        delta = "—"
    L.append(f"| {label} | {bv} | {av} | {delta} |")
L += ["", "## 按类别的边界合规率", "", "| 类别 | Base | QLoRA |", "|---|---:|---:|"]
for cat in sorted(set(b.get("by_category", {})) | set(a.get("by_category", {}))):
    L.append(f"| {cat} | {b.get('by_category', {}).get(cat, {}).get('boundary_ok_rate')} "
             f"| {a.get('by_category', {}).get(cat, {}).get('boundary_ok_rate')} |")
L += ["", "## 人工复核", ""]
for item in a.get("manual_review_items", []):
    L.append(f"- [ ] {item}")
L.append("")
pathlib.Path(sys.argv[3]).write_text("\n".join(L), encoding="utf-8")
print(f"         对比报告：{sys.argv[3]}")
PYEOF

say ""
ok "终测完成"
say "  Base    : $BASE_REPORT"
say "  QLoRA   : $ADAPTER_REPORT"
say "  对比    : $EVAL_DIR/base-vs-qlora.md"
printf '%s\n' "$ADAPTER_REPORT" > "$STATE_DIR/adapter-eval.path"
stage_done
