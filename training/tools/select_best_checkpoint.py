#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析 trainer_state.json，确定并校验最佳 checkpoint。

选择依据**只有 validation 的 eval_loss**（由训练配置的
``metric_for_best_model: eval_loss`` + ``greater_is_better: false`` 决定）。
test-80 在本阶段不被读取，也不参与任何比较 —— 本脚本根本不打开该文件。

找不到 trainer_state.json、缺少 best_model_checkpoint、或状态自相矛盾
（例如 best_metric 与日志里的最小 eval_loss 对不上、最佳目录不存在或文件不全）
时一律**退出非零**，不做任何猜测性回退。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_common as G  # noqa: E402

# PEFT LoRA checkpoint 的必需文件
REQUIRED_ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors")
# 重载还需要的分词器资产（LLaMA Factory 会一并写入 checkpoint 或 output_dir）
TOKENIZER_FILES = ("tokenizer_config.json", "tokenizer.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default=None, help="训练 output_dir，默认取自训练配置")
    ap.add_argument("--report-dir", default=None)
    args = ap.parse_args()

    cfg = G.production_config()
    out_dir = Path(args.output_dir or cfg["output_dir"])
    state_path = out_dir / "trainer_state.json"

    if not out_dir.is_dir():
        print(f"[FAIL] 训练输出目录不存在：{out_dir}", file=sys.stderr)
        return 1
    if not state_path.is_file():
        print(f"[FAIL] 未找到 trainer_state.json：{state_path}\n"
              "训练可能未完成或被中断；现场保持原样，请人工确认后再处理。", file=sys.stderr)
        return 1

    state = json.loads(state_path.read_text(encoding="utf-8"))
    best_ckpt = state.get("best_model_checkpoint")
    best_metric = state.get("best_metric")

    # ---- 汇总每个 checkpoint 的 eval_loss ---------------------------------
    evals = []
    for entry in state.get("log_history", []):
        if "eval_loss" in entry:
            evals.append({
                "step": entry.get("step"),
                "epoch": round(entry.get("epoch", 0), 4),
                "eval_loss": entry["eval_loss"],
            })
    evals.sort(key=lambda e: (e["step"] or 0))

    found_ckpts = sorted(
        (p for p in out_dir.glob("checkpoint-*") if p.is_dir()),
        key=lambda p: int(p.name.split("-")[-1]) if p.name.split("-")[-1].isdigit() else 0,
    )
    ckpt_rows = []
    for p in found_ckpts:
        step = int(p.name.split("-")[-1]) if p.name.split("-")[-1].isdigit() else None
        match = next((e for e in evals if e["step"] == step), None)
        missing = [f for f in REQUIRED_ADAPTER_FILES if not (p / f).is_file()]
        ckpt_rows.append({
            "path": str(p),
            "name": p.name,
            "step": step,
            "epoch": match["epoch"] if match else None,
            "eval_loss": match["eval_loss"] if match else None,
            "adapter_files_complete": not missing,
            "missing_files": missing,
        })

    problems = []
    if not evals:
        problems.append("trainer_state.json 的 log_history 中没有任何 eval_loss 记录")
    if not best_ckpt:
        problems.append("trainer_state.json 缺少 best_model_checkpoint")
    if best_metric is None:
        problems.append("trainer_state.json 缺少 best_metric")

    best_path = Path(best_ckpt) if best_ckpt else None
    if best_path is not None:
        if not best_path.is_dir():
            # 训练机与当前机器路径可能不同，按目录名在 out_dir 下再找一次
            alt = out_dir / best_path.name
            if alt.is_dir():
                best_path = alt
            else:
                problems.append(f"best_model_checkpoint 目录不存在：{best_ckpt}")
        if best_path.is_dir():
            missing = [f for f in REQUIRED_ADAPTER_FILES if not (best_path / f).is_file()]
            if missing:
                problems.append(f"最佳 checkpoint 缺少必需文件：{missing}")
            absent_tok = [f for f in TOKENIZER_FILES
                          if not (best_path / f).is_file() and not (out_dir / f).is_file()]
            if absent_tok:
                problems.append(
                    f"最佳 checkpoint 与 output_dir 均缺少分词器文件：{absent_tok}"
                    "（重载时需要，缺失会导致 Adapter 与 tokenizer 失配）")

    # 状态一致性：best_metric 必须等于 log_history 里的最小 eval_loss
    if evals and best_metric is not None:
        min_eval = min(e["eval_loss"] for e in evals)
        if abs(min_eval - best_metric) > 1e-9:
            problems.append(
                f"状态矛盾：best_metric={best_metric} 与 log_history 最小 eval_loss={min_eval} 不一致")
        if best_path is not None and best_path.name.startswith("checkpoint-"):
            best_step = int(best_path.name.split("-")[-1])
            row = next((e for e in evals if e["step"] == best_step), None)
            if row is None:
                problems.append(f"状态矛盾：best checkpoint step={best_step} 在 log_history 中没有 eval 记录")
            elif abs(row["eval_loss"] - best_metric) > 1e-9:
                problems.append(
                    f"状态矛盾：best checkpoint 的 eval_loss={row['eval_loss']} ≠ best_metric={best_metric}")

    # 配置一致性：选择依据必须是 eval_loss 且越小越好
    if cfg.get("metric_for_best_model") != "eval_loss":
        problems.append(f"训练配置 metric_for_best_model={cfg.get('metric_for_best_model')}，非 eval_loss")
    if cfg.get("greater_is_better", "false").lower() != "false":
        problems.append("训练配置 greater_is_better 不是 false")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "output_dir": str(out_dir),
        "selection_basis": {
            "metric": cfg.get("metric_for_best_model"),
            "greater_is_better": cfg.get("greater_is_better"),
            "source": "validation（eval_dataset=" + str(cfg.get("eval_dataset")) + "）",
            "test_set_used": False,
            "note": "test-80 不参与 checkpoint 选择；本脚本不读取 test 文件。",
        },
        "eval_history": evals,
        "checkpoints": ckpt_rows,
        "best_model_checkpoint": str(best_path) if best_path else None,
        "best_metric": best_metric,
        "problems": problems,
        "verdict": "FAIL" if problems else "PASS",
        "git": G.git_state(),
    }

    report_dir = Path(args.report_dir or (str(out_dir) + "/selection"))
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "checkpoint-selection.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (report_dir / "checkpoint-selection.md").write_text(render_md(report), encoding="utf-8")

    print("=" * 78)
    print("最佳 checkpoint 选择")
    print("=" * 78)
    print(f"{'checkpoint':>22}  {'step':>6}  {'epoch':>7}  {'eval_loss':>10}  完整")
    for c in ckpt_rows:
        print(f"{c['name']:>22}  {str(c['step']):>6}  {str(c['epoch']):>7}  "
              f"{c['eval_loss'] if c['eval_loss'] is not None else '—':>10}  "
              f"{'是' if c['adapter_files_complete'] else '否 ' + str(c['missing_files'])}")
    print("-" * 78)
    print(f"best_model_checkpoint : {report['best_model_checkpoint']}")
    print(f"best_metric(eval_loss): {best_metric}")
    print(f"选择依据              : validation eval_loss（test-80 未参与）")
    print(f"报告                  : {report_dir}/checkpoint-selection.md")
    if problems:
        print("\n[FAIL] 存在问题，禁止进入下一阶段：")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\n[PASS]")
    return 0


def render_md(report: dict) -> str:
    L = []
    A = L.append
    A("# 最佳 checkpoint 选择报告")
    A("")
    A(f"- 生成时间：{report['generated_at']}")
    A(f"- 结论：**{report['verdict']}**")
    A(f"- 输出目录：`{report['output_dir']}`")
    A(f"- 最佳 checkpoint：`{report['best_model_checkpoint']}`")
    A(f"- best_metric（eval_loss）：`{report['best_metric']}`")
    A("")
    A("## 选择依据")
    A("")
    b = report["selection_basis"]
    A(f"- 指标：`{b['metric']}`（greater_is_better=`{b['greater_is_better']}`）")
    A(f"- 来源：{b['source']}")
    A(f"- 是否使用 test-80：**{b['test_set_used']}** —— {b['note']}")
    A("")
    A("## 全部 checkpoint")
    A("")
    A("| checkpoint | step | epoch | eval_loss | 文件完整 |")
    A("|---|---:|---:|---:|---|")
    for c in report["checkpoints"]:
        A(f"| {c['name']} | {c['step']} | {c['epoch']} | {c['eval_loss']} | "
          f"{'是' if c['adapter_files_complete'] else '否 ' + str(c['missing_files'])} |")
    A("")
    A("## eval_loss 历史")
    A("")
    A("| step | epoch | eval_loss |")
    A("|---:|---:|---:|")
    for e in report["eval_history"]:
        A(f"| {e['step']} | {e['epoch']} | {e['eval_loss']} |")
    A("")
    if report["problems"]:
        A("## 问题")
        A("")
        for p in report["problems"]:
            A(f"- {p}")
        A("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
