#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一 Base / QLoRA 评测入口（固定 test-80）。

同一份代码、同一份生成参数、同一份 test 集，只有"是否挂 Adapter"这一处差异 ——
Base 与 QLoRA 的可比性由**代码结构**保证，而不是靠人记得填一样的参数。

用法（4090）：
    python3 training/tools/evaluate.py --mode base
    python3 training/tools/evaluate.py --mode adapter --adapter-path <best-checkpoint>

用法（Mac，不需要模型/CUDA）：
    python3 training/tools/evaluate.py --dry-run
        用 test-80 的参考答案代替模型输出，只验证规则指标链路是否可用。

硬性约束：
- test-80 **只在本脚本被读取**，不参与训练、调参、checkpoint 选择、early stopping；
- 不下载模型：本地路径不存在时直接报错退出，由人工决定；
- 不覆盖既有结果：输出目录已存在同名结果文件时报错退出。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_common as G  # noqa: E402
import rule_metrics as RM  # noqa: E402

# ---------------------------------------------------------------------------
# 生成配置：**唯一定义处**。Base 与 Adapter 共用，任何一方都不允许覆盖。
# 报告里记录它的 SHA-256，用于证明两次评测确实同参。
# ---------------------------------------------------------------------------
GEN_CONFIG = {
    "do_sample": False,          # 贪心解码：消除采样噪声，保证可复现
    "temperature": None,
    "top_p": None,
    "top_k": None,
    "num_beams": 1,
    "max_new_tokens": 512,
    "repetition_penalty": 1.0,
    "seed": 20260729,            # 与数据集构建同种子
    "enable_thinking": False,    # qwen3_nothink：非思考模式
}
EXPECTED_TEST_COUNT = 80

QUANT_CONFIG = {
    "load_in_4bit": True,
    "bnb_4bit_quant_type": "nf4",
    "bnb_4bit_use_double_quant": True,
    "bnb_4bit_compute_dtype": "bfloat16",
}


def config_fingerprint() -> str:
    blob = json.dumps(
        {"gen": GEN_CONFIG, "quant": QUANT_CONFIG}, ensure_ascii=False, sort_keys=True
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def set_all_seeds(seed: int):
    import random
    random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


# ---------------------------------------------------------------------------
# 模型加载
# ---------------------------------------------------------------------------
def load_model(mode: str, adapter_path: str | None):
    """加载 4-bit NF4 + bf16 的 Base，adapter 模式再叠 PEFT。不下载任何权重。"""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    cfg = G.production_config()
    base_path = cfg["model_name_or_path"]
    revision = cfg.get("model_revision")

    if not Path(base_path).is_dir():
        raise G.GateError(
            f"基础模型目录不存在：{base_path}\n"
            "本脚本不会自动下载模型。请人工确认模型来源与许可证后手动准备，"
            "并核对 revision=" + str(revision)
        )

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    tok = AutoTokenizer.from_pretrained(base_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        base_path,
        quantization_config=quant,
        dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )
    adapter_meta = None
    if mode == "adapter":
        if not adapter_path:
            raise G.GateError("adapter 模式必须显式指定 --adapter-path")
        ap = Path(adapter_path)
        if not (ap / "adapter_config.json").is_file():
            raise G.GateError(f"Adapter 目录缺少 adapter_config.json：{ap}")
        adapter_meta = json.loads((ap / "adapter_config.json").read_text(encoding="utf-8"))
        if adapter_meta.get("peft_type") != "LORA":
            raise G.GateError(f"peft_type 不是 LORA：{adapter_meta.get('peft_type')}")
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(ap))
    model.eval()
    return tok, model, {
        "base_path": base_path,
        "revision": revision,
        "adapter_path": adapter_path,
        "adapter_config": adapter_meta,
    }


def build_prompt(tok, messages: list) -> str:
    """把 observation 映射为 chat template 的 role=tool，与训练态同构。"""
    mapped = [
        {"role": ("tool" if m["role"] == "observation" else m["role"]), "content": m["content"]}
        for m in messages
    ]
    return tok.apply_chat_template(
        mapped, tokenize=False, add_generation_prompt=True, enable_thinking=False
    )


def generate(tok, model, prompt: str) -> str:
    import torch
    inputs = tok(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            do_sample=False,
            num_beams=1,
            max_new_tokens=GEN_CONFIG["max_new_tokens"],
            repetition_penalty=GEN_CONFIG["repetition_penalty"],
            pad_token_id=tok.pad_token_id or tok.eos_token_id,
        )
    text = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
    return text.strip()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "adapter"], default="base")
    ap.add_argument("--adapter-path", default=None)
    ap.add_argument("--output-dir", default=None,
                    help="默认 <production output_dir>/evaluation")
    ap.add_argument("--tag", default=None, help="结果文件名后缀，默认由 mode + UTC 时间生成")
    ap.add_argument("--limit", type=int, default=0,
                    help="只允许与 --debug 同时使用；正式评测必须跑满 80 条")
    ap.add_argument("--debug", action="store_true",
                    help="显式 debug 模式：放开 --limit，结果标记为 debug 且不可用于对比")
    ap.add_argument("--dry-run", action="store_true",
                    help="不加载模型，用参考答案代替模型输出，仅验证规则指标链路")
    args = ap.parse_args()

    # --- 完整性硬门禁：正式模式不允许裁剪样本 ---
    strict = not (args.debug or args.dry_run)
    if args.limit and not args.debug:
        print("[FAIL] --limit 只能与 --debug 同时使用；阶段 03/07 的正式评测禁止裁剪 test 集。",
              file=sys.stderr)
        return 1

    try:
        G.verify_datasets()
        G.assert_no_test_in_training_config()
        samples = G.load_split_with_metadata("test")
    except G.GateError as exc:
        print(f"[FAIL] 准入校验失败：{exc}", file=sys.stderr)
        return 1

    if strict and len(samples) != EXPECTED_TEST_COUNT:
        print(f"[FAIL] test 集条数为 {len(samples)}，期望 {EXPECTED_TEST_COUNT}。", file=sys.stderr)
        return 1
    if args.limit:
        samples = samples[: args.limit]

    started = datetime.now(timezone.utc)
    run_tag = args.tag or f"{args.mode}-{started.strftime('%Y%m%dT%H%M%SZ')}"
    # dry-run 与 debug 结果必须在文件名与报告里都能一眼看出，不能与正式结果混淆
    if args.dry_run:
        run_tag = f"dryrun-{run_tag}"
    elif args.debug:
        run_tag = f"debug-{run_tag}"
    out_dir = Path(args.output_dir or (G.production_config()["output_dir"] + "/evaluation"))
    jsonl_path = out_dir / f"eval-{run_tag}.jsonl"
    json_path = out_dir / f"eval-{run_tag}.summary.json"
    md_path = out_dir / f"eval-{run_tag}.summary.md"
    for p in (jsonl_path, json_path, md_path):
        if p.exists():
            print(f"[FAIL] 结果文件已存在，拒绝覆盖：{p}", file=sys.stderr)
            return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    set_all_seeds(GEN_CONFIG["seed"])

    model_meta = {"mode": args.mode, "dry_run": args.dry_run}
    tok = model = None
    if not args.dry_run:
        try:
            tok, model, model_meta_extra = load_model(args.mode, args.adapter_path)
            model_meta.update(model_meta_extra)
        except G.GateError as exc:
            print(f"[FAIL] {exc}", file=sys.stderr)
            return 1

    rows = []
    with jsonl_path.open("w", encoding="utf-8") as fh:
        for i, s in enumerate(samples, 1):
            prompt_msgs = s["messages"][:-1]
            reference = s["messages"][-1]["content"]
            t0 = time.perf_counter()
            ok, answer, error = True, "", None
            try:
                if args.dry_run:
                    answer = reference          # 仅验证链路，不代表模型输出
                else:
                    answer = generate(tok, model, build_prompt(tok, prompt_msgs))
            except Exception as exc:  # 单条失败不终止整轮，如实记录
                ok, answer, error = False, "", f"{type(exc).__name__}: {exc}"
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

            metrics = RM.score_one(s, answer)
            row = {
                "uid": s["uid"],
                "index": s["index"],
                "category": s["category"],
                "scenario": s["scenario"],
                "risk_level": s["risk_level"],
                "requires_rag": s["requires_rag"],
                "requires_tool": s["requires_tool"],
                "input_messages": prompt_msgs,
                "reference": reference,
                "answer": answer,
                "ok": ok,
                "error": error,
                "elapsed_ms": elapsed_ms,
                "metrics": metrics,
            }
            rows.append(row)
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"  [{i}/{len(samples)}] {s['uid']} {'ok' if ok else 'ERROR'} {elapsed_ms}ms",
                  flush=True)

    summary = RM.aggregate(rows)
    finished = datetime.now(timezone.utc)

    usable = (
        strict
        and not args.dry_run
        and not args.debug
        and len(rows) == EXPECTED_TEST_COUNT
        and summary["generated"] == EXPECTED_TEST_COUNT
        and all(r["ok"] for r in rows)
    )
    report = {
        "run_tag": run_tag,
        "mode": args.mode,
        "dry_run": args.dry_run,
        "debug": args.debug,
        "strict": strict,
        "usable_for_comparison": usable,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "duration_s": round((finished - started).total_seconds(), 1),
        "test_set": {
            "file": G.SPLIT_FILES["test"],
            "count": len(samples),
            "sha256": G.sha256_file(G.DATASETS_DIR / G.SPLIT_FILES["test"]),
        },
        "model": model_meta,
        "gen_config": GEN_CONFIG,
        "quant_config": QUANT_CONFIG,
        "config_fingerprint": config_fingerprint(),
        "train_config_sha256": G.config_sha256(),
        "git": G.git_state(),
        "host": {"platform": platform.platform(), "python": sys.version.split()[0]},
        "summary": summary,
        "artifacts": {"jsonl": str(jsonl_path), "summary_json": str(json_path),
                      "summary_md": str(md_path)},
    }
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")

    print("\n" + "=" * 78)
    print(f"评测完成：{run_tag}")
    print(f"  生成 {summary['generated']}/{summary['count']}    "
          f"空回答率 {summary['empty_rate']}    边界合规率 {summary['boundary_ok_rate']}")
    print(f"  危险建议 {summary['danger_hit']}    订单编造 {summary['order_fabrication_hit']}    "
          f"无依据断言 {summary['groundless_fact_hit']}    伪造 observation {summary['forged_observation_hit']}")
    print(f"  报告：{md_path}")
    print("=" * 78)
    if args.dry_run:
        print("注意：--dry-run 用参考答案冒充模型输出，仅用于验证链路，不是评测结果。")
    if args.debug:
        print("注意：--debug 结果不可用于 Base/QLoRA 对比。")

    # ---- 完整性硬门禁 -----------------------------------------------------
    # JSONL 与 summary 已经落盘（便于排错），但只要有一条异常就必须非零退出，
    # 不允许把失败吞掉。空回答**不是**异常：它会如实计入 empty_rate。
    if strict:
        failures = [r for r in rows if not r["ok"]]
        gate_problems = []
        if len(rows) != EXPECTED_TEST_COUNT:
            gate_problems.append(f"样本数 {len(rows)} ≠ {EXPECTED_TEST_COUNT}")
        if summary["generated"] != EXPECTED_TEST_COUNT:
            gate_problems.append(
                f"成功生成 {summary['generated']} ≠ {EXPECTED_TEST_COUNT}")
        if failures:
            gate_problems.append(f"{len(failures)} 条生成异常")
        if gate_problems:
            print("\n[FAIL] 评测完整性门禁未通过：")
            for p in gate_problems:
                print(f"  - {p}")
            for f in failures[:10]:
                print(f"  异常条目 {f['uid']}：{f['error']}")
            print(f"  明细已保留：{jsonl_path}")
            print(f"  汇总已保留：{json_path}")
            return 1
    return 0


def render_markdown(report: dict) -> str:
    s = report["summary"]
    L = []
    A = L.append
    A(f"# 评测报告 · {report['run_tag']}")
    A("")
    if report["dry_run"]:
        A("> **本报告为 --dry-run 链路自检**，回答内容取自 test-80 的参考答案，"
          "不代表任何模型的真实输出。")
        A("")
    A("## 1. 运行绑定")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A(f"| 模式 | `{report['mode']}` |")
    A(f"| 测试集 | `{report['test_set']['file']}`（{report['test_set']['count']} 条） |")
    A(f"| 测试集 SHA-256 | `{report['test_set']['sha256']}` |")
    A(f"| 基础模型 | `{report['model'].get('base_path')}` |")
    A(f"| 模型 revision | `{report['model'].get('revision')}` |")
    A(f"| Adapter | `{report['model'].get('adapter_path') or '—'}` |")
    A(f"| 生成配置指纹 | `{report['config_fingerprint']}` |")
    A(f"| 训练配置 SHA-256 | `{report['train_config_sha256']}` |")
    A(f"| git commit | `{report['git'].get('commit')}` |")
    A(f"| 耗时 | {report['duration_s']} s |")
    A("")
    A("生成参数（Base 与 Adapter 完全一致，由同一处常量提供）：")
    A("")
    A("```json")
    A(json.dumps(report["gen_config"], ensure_ascii=False, indent=2))
    A("```")
    A("")
    A("## 2. 规则指标")
    A("")
    A("| 指标 | 值 | 定义 |")
    A("|---|---:|---|")
    defs = s.get("metric_definitions", {})
    for key in ("generated_rate", "empty_rate", "clarify_rate", "refusal_rate",
                "boundary_ok_rate", "safety_block_rate", "injection_refusal_rate"):
        A(f"| {key} | {s.get(key)} | {defs.get(key, '')} |")
    for key in ("danger_hit", "order_fabrication_hit", "groundless_fact_hit",
                "forged_observation_hit"):
        A(f"| {key} | {s.get(key)} | {defs.get(key, '')} |")
    A("")
    A(f"> {s.get('scope_note', '')}")
    A("")
    A("## 3. 分组")
    A("")
    for label, key in (("类别", "by_category"), ("场景", "by_scenario"), ("风险等级", "by_risk_level")):
        A(f"### 按{label}")
        A("")
        A("| 分组 | 条数 | 边界合规率 | 危险建议 | 空回答 |")
        A("|---|---:|---:|---:|---:|")
        for name, g in s.get(key, {}).items():
            A(f"| {name} | {g['count']} | {g['boundary_ok_rate']} | {g['danger']} | {g['empty']} |")
        A("")
    A("## 4. 人工复核项（规则不覆盖）")
    A("")
    for item in s.get("manual_review_items", []):
        A(f"- [ ] {item}")
    A("")
    A("## 5. 明细")
    A("")
    A(f"逐条输入、参考答案、模型回答与命中证据见 `{Path(report['artifacts']['jsonl']).name}`。")
    A("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
