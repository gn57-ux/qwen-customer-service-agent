#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机预处理门禁：只处理 train-640 + validation-80，输出 JSON + Markdown 报告。

复用而非重写：
- 模板槽位与角色规则来自 ``scripts/verify_template_encoding.py``
  （已证明与仓库内真实 Qwen3 chat_template.jinja 逐字符一致），本脚本 import 它，
  不再抄一份渲染逻辑。
- 数据指纹、test 隔离等来自 ``training/tools/gate_common.py``。

诚实边界：
- 传入 ``--tokenizer-path`` 且能加载时，token 统计为**实测**；
- 否则 token 相关项一律标记 ``4090 真机待验证``，并给出字符级估算供参考，
  **不会伪造 PASS**。
- "LLaMA Factory 实际读取成功"这一项本脚本无法自证，由
  ``training/stages/02-preprocess.sh`` 调用 llamafactory-cli 后回填。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_common as G  # noqa: E402

sys.path.insert(0, str(G.REPO_ROOT / "scripts"))
from verify_template_encoding import (  # noqa: E402
    SLOT_OBSERVATION, TOOL_CLOSE, TOOL_OPEN, check_roles, render,
)
from dataset_source.common import RESULT_MARKS  # noqa: E402

TRAIN_SPLITS = ("train", "validation")   # test 绝不进入本阶段
PENDING = "4090 真机待验证"


def load_tokenizer(path: str | None):
    if not path:
        return None, "未提供 --tokenizer-path"
    p = Path(path)
    if not p.is_dir():
        return None, f"tokenizer 目录不存在：{path}"
    try:
        from transformers import AutoTokenizer
    except ImportError:
        return None, "本机未安装 transformers"
    try:
        return AutoTokenizer.from_pretrained(str(p), trust_remote_code=True), "已加载"
    except Exception as exc:
        return None, f"加载失败：{type(exc).__name__}: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer-path", default=None,
                    help="基础模型目录；给出后才能产出实测 token 统计")
    ap.add_argument("--output-dir", default=None,
                    help="默认 <production output_dir>/preprocess")
    ap.add_argument("--lf-log", default=None, help="llamafactory-cli 日志路径（仅作留档）")
    ap.add_argument("--tokenized-report", default=None,
                    help="verify_tokenized.py 的报告；'LLaMA Factory 实际读取成功'与"
                         "'observation 不计入 loss'两项**只**采信它，不看日志字样")
    args = ap.parse_args()

    try:
        data_state = G.verify_datasets()
        G.assert_no_test_in_training_config()
        G.verify_dataset_info()
        dirs = G.assert_output_dirs_disjoint()
    except G.GateError as exc:
        print(f"[FAIL] 准入校验失败：{exc}", file=sys.stderr)
        return 1

    cfg = G.production_config()
    cutoff = int(cfg.get("cutoff_len", 1536))
    template = cfg.get("template")

    checks: list[dict] = []

    def add(name, status, detail):
        checks.append({"name": name, "status": status, "detail": detail})

    # ---- 模板与数据登记 ---------------------------------------------------
    add("template=qwen3_nothink", "PASS" if template == "qwen3_nothink" else "FAIL",
        f"训练配置 template={template}")
    add("test-80 不进入预处理", "PASS",
        f"本阶段仅处理 {TRAIN_SPLITS}；训练配置 dataset={cfg.get('dataset')} "
        f"eval_dataset={cfg.get('eval_dataset')}")
    add("输出目录与 Smoke 分离", "PASS",
        f"production={dirs['production_output_dir']} smoke={dirs['smoke_output_dir']}")

    # ---- 逐条渲染 ---------------------------------------------------------
    tok, tok_note = load_tokenizer(args.tokenizer_path)
    per_split = {}
    role_errors, wrap_errors, leak_errors = [], [], []
    all_lengths = []

    for split in TRAIN_SPLITS:
        records = G.load_split_with_metadata(split)
        lengths, obs_records, obs_turns = [], 0, 0
        masked_chars = target_chars = 0
        for rec in records:
            msgs = rec["messages"]
            errs = check_roles(msgs)
            if errs:
                role_errors.append(f"{split}/{rec['uid']}: {errs}")
            text, parts = render(msgs)

            n_obs = sum(1 for m in msgs if m["role"] == "observation")
            if n_obs:
                obs_records += 1
                obs_turns += n_obs
                for m in msgs:
                    if m["role"] != "observation":
                        continue
                    expected = SLOT_OBSERVATION.format(content=m["content"])
                    if expected not in text:
                        wrap_errors.append(f"{split}/{rec['uid']}: observation 未按槽位渲染")
                    elif TOOL_OPEN not in expected or TOOL_CLOSE not in expected:
                        wrap_errors.append(f"{split}/{rec['uid']}: 缺少 tool_response 包裹")
            for m in msgs:
                if m["role"] in ("user", "assistant") and any(k in m["content"] for k in RESULT_MARKS):
                    leak_errors.append(f"{split}/{rec['uid']}: {m['role']} 轮出现工具/检索标记")

            for is_target, chunk in parts:
                if is_target:
                    target_chars += len(chunk)
                else:
                    masked_chars += len(chunk)

            length = len(tok(text)["input_ids"]) if tok else len(text)
            lengths.append(length)
        all_lengths.extend(lengths)
        lengths_sorted = sorted(lengths)
        over = [x for x in lengths if x > cutoff]
        per_split[split] = {
            "count": len(records),
            "expected_count": G.EXPECTED_COUNTS[split],
            "converted": len(records),
            "observation_records": obs_records,
            "observation_turns": obs_turns,
            "masked_chars": masked_chars,
            "target_chars": target_chars,
            "length_unit": "token" if tok else "char(估算)",
            "length_min": lengths_sorted[0],
            "length_p50": lengths_sorted[len(lengths_sorted) // 2],
            "length_p95": lengths_sorted[int(len(lengths_sorted) * 0.95) - 1],
            "length_max": lengths_sorted[-1],
            "length_mean": round(statistics.fmean(lengths), 1),
            "cutoff_len": cutoff,
            "over_cutoff_count": len(over),
            "truncation_rate": round(len(over) / len(lengths), 4),
        }

    total = sum(v["count"] for v in per_split.values())
    add("640/80 条全部转换成功",
        "PASS" if (per_split["train"]["count"] == 640 and per_split["validation"]["count"] == 80)
        else "FAIL",
        f"train={per_split['train']['count']} validation={per_split['validation']['count']} 合计 {total}")

    obs_total = sum(v["observation_turns"] for v in per_split.values())
    obs_recs = sum(v["observation_records"] for v in per_split.values())
    add("observation 进入 tool_response 模板",
        "PASS" if not wrap_errors else "FAIL",
        f"{obs_recs} 条样本共 {obs_total} 轮 observation，"
        + ("全部渲染为 <tool_response>…</tool_response>" if not wrap_errors else str(wrap_errors[:5])))

    add("observation 归入 source 段（结构性前置检查）",
        "PASS" if not wrap_errors else "FAIL",
        "observation 与 user 段归入 source，label=IGNORE_INDEX；"
        f"train+validation 共 {sum(v['masked_chars'] for v in per_split.values())} 字符被掩掉，"
        f"{sum(v['target_chars'] for v in per_split.values())} 字符为 assistant 目标段。"
        "（这是结构性推导；是否真被掩码由下一项的真实 labels 张量核验决定）")

    add("user/assistant/observation 角色无泄漏",
        "PASS" if not (role_errors or leak_errors) else "FAIL",
        "角色序列合法且 user/assistant 轮未出现工具/检索标记"
        if not (role_errors or leak_errors) else str((role_errors + leak_errors)[:5]))

    # ---- token 统计 -------------------------------------------------------
    if tok:
        status, unit = "PASS", "token（实测）"
    else:
        status, unit = PENDING, "char（估算，非 token）"
    over_total = sum(v["over_cutoff_count"] for v in per_split.values())
    add(f"长度统计与截断率（cutoff_len={cutoff}）", status,
        f"单位={unit}；tokenizer={tok_note}；"
        + "；".join(
            f"{s}: min={v['length_min']} P50={v['length_p50']} P95={v['length_p95']} "
            f"max={v['length_max']} 超长={v['over_cutoff_count']} 截断率={v['truncation_rate']}"
            for s, v in per_split.items()
        )
        + f"；合计超长 {over_total} 条")

    # ---- LLaMA Factory 实际读取（只采信 tokenized 产物，不看日志字样）-----
    tok_report = None
    lf_status = PENDING
    lf_detail = ("未提供 --tokenized-report；该项只能在 4090 上由 llamafactory-cli 的"
                 "真实 tokenized 产物证明。日志里出现 'Loading dataset' 之类字样不作数。")
    if args.tokenized_report:
        rp = Path(args.tokenized_report)
        if not rp.is_file():
            lf_status, lf_detail = "FAIL", f"tokenized 校验报告不存在：{rp}"
        else:
            try:
                tok_report = json.loads(rp.read_text(encoding="utf-8"))
            except Exception as exc:
                lf_status, lf_detail = "FAIL", f"tokenized 校验报告不可解析：{exc}"
            else:
                lf_status = "PASS" if tok_report.get("verdict") == "PASS" else "FAIL"
                lf_detail = (f"依据 {rp}："
                             f"splits={tok_report.get('splits_found')}，"
                             f"verdict={tok_report.get('verdict')}，"
                             f"problems={len(tok_report.get('problems', []))}")
    if args.lf_log:
        lf_detail += f"（日志留档：{args.lf_log}）"
    add("LLaMA Factory 0.9.5 实际读取成功（以 tokenized 产物为准）", lf_status, lf_detail)

    # ---- observation 掩码：真实 labels 张量 -------------------------------
    if tok_report is None:
        add("observation token 区域在 labels 中被掩码（真实张量）", PENDING,
            "需要 4090 上的 tokenized 产物；结构性推导不能替代张量核验。")
    else:
        exp = tok_report.get("observation_turns_expected")
        got = tok_report.get("observation_turns_checked")
        masked_ok = tok_report.get("verdict") == "PASS" and exp == got
        add("observation token 区域在 labels 中被掩码（真实张量）",
            "PASS" if masked_ok else "FAIL",
            f"train+validation 共 {exp} 轮 observation，已在真实 labels 中核验 {got} 轮；"
            f"tokenized verdict={tok_report.get('verdict')}")
        # token 长度以 tokenized 产物为准，覆盖字符估算
        for split, st in (tok_report.get("stats") or {}).items():
            if split in per_split:
                per_split[split].update({
                    "length_unit": "token（tokenized 产物实测）",
                    "length_min": st["min"], "length_p50": st["p50"],
                    "length_p95": st["p95"], "length_max": st["max"],
                    "length_mean": st["mean"],
                    "over_cutoff_count": st["over_cutoff_count"],
                    "truncation_rate": st["truncation_rate"],
                })

    # ---- 汇总 -------------------------------------------------------------
    failed = [c for c in checks if c["status"] == "FAIL"]
    pending = [c for c in checks if c["status"] == PENDING]
    verdict = "FAIL" if failed else ("PENDING" if pending else "PASS")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "verdict": verdict,
        "template": template,
        "cutoff_len": cutoff,
        "splits": per_split,
        "datasets": {k: v for k, v in data_state.items() if k != "_problems"},
        "checks": checks,
        "git": G.git_state(),
        "train_config_sha256": G.config_sha256(),
        "note": "本阶段只处理 train-640 与 validation-80；test-80 不参与预处理、训练、"
                "调参与 checkpoint 选择。",
    }

    out_dir = Path(args.output_dir or (cfg["output_dir"] + "/preprocess"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (out_dir / f"preprocess-{stamp}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / f"preprocess-{stamp}.md").write_text(render_md(report), encoding="utf-8")

    print("=" * 78)
    print("真机预处理门禁")
    print("=" * 78)
    for c in checks:
        print(f"[{c['status']}] {c['name']}")
        print(f"        {c['detail']}")
    print("-" * 78)
    print(f"结论：{verdict}")
    print(f"报告：{out_dir}/preprocess-{stamp}.md")
    if verdict == "FAIL":
        return 1
    if verdict == "PENDING":
        print(f"存在 {len(pending)} 项 {PENDING}；在 4090 上补齐前不得进入训练阶段。")
        return 2
    return 0


def render_md(report: dict) -> str:
    L = []
    A = L.append
    A("# 真机预处理报告")
    A("")
    A(f"- 生成时间：{report['generated_at']}")
    A(f"- 结论：**{report['verdict']}**")
    A(f"- template：`{report['template']}`　cutoff_len：`{report['cutoff_len']}`")
    A(f"- git commit：`{report['git'].get('commit')}`")
    A(f"- 训练配置 SHA-256：`{report['train_config_sha256']}`")
    A("")
    A("> " + report["note"])
    A("")
    A("## 检查项")
    A("")
    A("| 状态 | 检查项 | 说明 |")
    A("|---|---|---|")
    for c in report["checks"]:
        A(f"| {c['status']} | {c['name']} | {c['detail']} |")
    A("")
    A("## 长度分布")
    A("")
    A("| Split | 条数 | 单位 | min | P50 | P95 | max | 超 cutoff | 截断率 |")
    A("|---|---:|---|---:|---:|---:|---:|---:|---:|")
    for s, v in report["splits"].items():
        A(f"| {s} | {v['count']} | {v['length_unit']} | {v['length_min']} | {v['length_p50']} "
          f"| {v['length_p95']} | {v['length_max']} | {v['over_cutoff_count']} | {v['truncation_rate']} |")
    A("")
    A("## 数据绑定")
    A("")
    A("| Split | 条数 | SHA-256 |")
    A("|---|---:|---|")
    for s, v in report["datasets"].items():
        A(f"| {s} | {v['count']} | `{v['sha256']}` |")
    A("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
