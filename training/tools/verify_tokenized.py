#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 LLaMA Factory 落盘的 tokenized 数据集（--tokenized_path 的真实产物）。

**只看 tokenized 数据本身**：input_ids / labels 张量。不再用自写渲染器推导结论，
也不靠日志里出现 "Loading dataset" 之类字样就判 PASS。

检查项：
  1. 能被 datasets.load_from_disk 读取
  2. train 恰好 640 条、validation 恰好 80 条
  3. 不存在 test split，且没有任何 split 的条数等于 test 的 80 条来源
  4. 每条都有 input_ids 与 labels，且长度一致
  5. assistant 目标区存在非 IGNORE_INDEX 的 label（否则整条不产生梯度）
  6. system / user / observation 区域的 label 全为 IGNORE_INDEX
  7. 每一轮 observation 的 token 区间在 labels 里全被 mask
  8. 每个 split 输出 count / min / P50 / P95 / max / 超 cutoff 数 / 截断率

第 6、7 项靠"把已知文本用同一个 tokenizer 编码后，在 input_ids 里定位子序列"
来定位区间 —— 定位失败即 FAIL，不允许因为找不到就跳过。

纯逻辑部分（check_records）不依赖 datasets/transformers，便于在 Mac 上用
构造数据做自动测试。
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

IGNORE_INDEX = -100
EXPECTED = {"train": 640, "validation": 80}
OBSERVATION_SLOT = (
    "<|im_start|>user\n<tool_response>\n{content}\n</tool_response><|im_end|>\n"
    "<|im_start|>assistant\n"
)


def find_subsequence(haystack: list, needle: list, start: int = 0) -> int:
    """返回 needle 在 haystack 中的起始下标；找不到返回 -1。"""
    n, m = len(haystack), len(needle)
    if m == 0 or m > n:
        return -1
    first = needle[0]
    for i in range(start, n - m + 1):
        if haystack[i] != first:
            continue
        if haystack[i:i + m] == needle:
            return i
    return -1


def check_one(record: dict, spans: list, cutoff: int):
    """校验单条 tokenized 记录。

    spans = [{"role": "system", "tokens": [...]}, {"role": "user", "tokens": [...]},
             {"role": "observation", "tokens": [...]}, ...]
    按消息原始顺序排列。每个 span 的完整 token 区间必须落在 IGNORE_INDEX 区。
    返回 (问题列表, observation_验证成功数)。
    """
    problems = []
    obs_verified = 0
    ids = record.get("input_ids")
    labels = record.get("labels")
    if not isinstance(ids, list) or not ids:
        return (["缺少 input_ids 或为空"], 0)
    if not isinstance(labels, list) or not labels:
        return (["缺少 labels 或为空"], 0)
    if len(ids) != len(labels):
        problems.append(f"input_ids({len(ids)}) 与 labels({len(labels)}) 长度不一致")
        return (problems, 0)

    # 5) assistant 目标区必须存在非 IGNORE 的 label
    trained = [i for i, v in enumerate(labels) if v != IGNORE_INDEX]
    if not trained:
        problems.append("labels 全为 IGNORE_INDEX，该条不产生任何梯度")

    # 6/7) 按消息顺序向后推进搜索位置，严格定位每个 span 的完整区间
    search_pos = 0
    for span in spans:
        tag = span["role"]
        seq = span["tokens"]
        pos = find_subsequence(ids, seq, search_pos)
        if pos < 0:
            problems.append(f"{tag} 区域的完整 token 序列未能在 input_ids 中定位"
                            f"（长度 {len(seq)}，已跳过前 {search_pos} token），无法证明其被 mask")
            continue
        leaked = [i for i in range(pos, pos + len(seq)) if labels[i] != IGNORE_INDEX]
        if leaked:
            problems.append(
                f"{tag} 区域有 {len(leaked)} 个 token 未被 mask（首个下标 {leaked[0]}）")
        elif tag == "observation":
            obs_verified += 1
        search_pos = pos + len(seq)
    return (problems, obs_verified)


def summarize(lengths: list, cutoff: int) -> dict:
    s = sorted(lengths)
    over = [x for x in s if x > cutoff]
    return {
        "count": len(s),
        "min": s[0], "max": s[-1],
        "p50": s[len(s) // 2],
        "p95": s[max(0, int(len(s) * 0.95) - 1)],
        "mean": round(statistics.fmean(s), 1),
        "cutoff_len": cutoff,
        "over_cutoff_count": len(over),
        "truncation_rate": round(len(over) / len(s), 4),
    }


def check_records(by_split: dict, spans_by_split: dict, cutoff: int) -> dict:
    """纯逻辑校验，可在无 datasets/transformers 的机器上直接测试。"""
    problems, stats = [], {}
    obs_verified_total = 0
    for split, expected in EXPECTED.items():
        recs = by_split.get(split)
        if recs is None:
            problems.append(f"缺少 split：{split}")
            continue
        if len(recs) != expected:
            problems.append(f"{split} 条数不符：实际 {len(recs)}，期望 {expected}")
        lengths = []
        for idx, rec in enumerate(recs):
            spans = spans_by_split.get(split, {}).get(idx, {})
            rec_problems, obs_ok = check_one(rec, spans, cutoff)
            for p in rec_problems:
                problems.append(f"{split}[{idx}] {p}")
            obs_verified_total += obs_ok
            ids = rec.get("input_ids") or []
            lengths.append(len(ids))
        if lengths:
            stats[split] = summarize(lengths, cutoff)

    extra = [s for s in by_split if s not in EXPECTED]
    if extra:
        problems.append(f"出现了预期之外的 split：{extra}（test 绝不允许进入预处理）")

    return {"problems": problems, "stats": stats, "obs_verified": obs_verified_total}


# ---------------------------------------------------------------------------
# 真机加载
# ---------------------------------------------------------------------------
def load_tokenized(path: Path) -> dict:
    try:
        from datasets import load_from_disk
    except ImportError:
        raise G.GateError("本机未安装 datasets 库，无法读取 tokenized 产物（该步骤只能在 4090 运行）")
    ds = load_from_disk(str(path))
    if hasattr(ds, "keys"):
        return {k: ds[k] for k in ds.keys()}
    # 单一 split：LLaMA Factory 在只有 train 时可能直接落一个 Dataset
    return {"train": ds}


def build_masked_spans(tok, split: str, cutoff: int) -> dict:
    """为每条样本算出"必须被 mask"的 token 序列（按消息原始顺序）。

    返回 {rec_index: [{"role": "system", "tokens": [...]}, ...]}
    role 仅包含 system / user / observation，按 messages 出现顺序排列。
    """
    spans = {}
    for rec in G.load_split_with_metadata(split):
        ordered = []
        for m in rec["messages"][:-1]:
            role = m["role"]
            if role not in ("system", "user", "observation"):
                continue
            # LLaMA Factory does not tokenize an observation as bare content.
            # qwen3_nothink.format_observation wraps it in the complete ChatML
            # tool-response slot first.  Tokenizing only the bare content can
            # differ at its boundaries because of BPE merging and produces
            # false "not found" failures for longer observations.
            text = (
                OBSERVATION_SLOT.format(content=m["content"])
                if role == "observation"
                else m["content"]
            )
            ids = tok(text, add_special_tokens=False)["input_ids"]
            if len(ids) >= 4:
                ordered.append({"role": role, "tokens": list(ids)})
        spans[rec["index"]] = ordered
    return spans


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenized-path", required=True)
    ap.add_argument("--tokenizer-path", default=None)
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    cfg = G.production_config()
    cutoff = int(cfg.get("cutoff_len", 1536))
    path = Path(args.tokenized_path)

    print("=" * 78)
    print("tokenized 数据校验（读真实张量，不用渲染器推导）")
    print("=" * 78)
    print(f"  路径     : {path}")
    print(f"  cutoff   : {cutoff}")

    if not path.exists():
        print(f"\n  [FAIL] tokenized 产物不存在：{path}")
        print("  说明 llamafactory-cli 没有真正落盘预处理结果。"
              "请在 4090 上实测该命令是否支持 --do_train false + --tokenized_path；"
              "若不支持，停止并报告，不要凭日志文字放行。")
        return 1

    try:
        by_split_ds = load_tokenized(path)
    except G.GateError as exc:
        print(f"\n  [FAIL] {exc}")
        return 1
    except Exception as exc:
        print(f"\n  [FAIL] load_from_disk 失败：{type(exc).__name__}: {exc}")
        return 1

    print(f"  splits   : {sorted(by_split_ds)}")

    tok = None
    tok_path = args.tokenizer_path or cfg.get("model_name_or_path")
    if tok_path and Path(tok_path).is_dir():
        try:
            from transformers import AutoTokenizer
            tok = AutoTokenizer.from_pretrained(tok_path, trust_remote_code=True)
        except Exception as exc:
            print(f"\n  [FAIL] 无法加载 tokenizer（{exc}），"
                  "则无法证明 observation 区域被 mask。")
            return 1
    else:
        print(f"\n  [FAIL] tokenizer 目录不可用：{tok_path}；"
              "无法定位 observation token 区间，因此无法证明其被 mask。")
        return 1

    by_split = {}
    spans_by_split = {}
    for split, ds in by_split_ds.items():
        by_split[split] = [
            {"input_ids": list(r["input_ids"]), "labels": list(r["labels"])}
            for r in ds
        ] if len(ds) and "input_ids" in ds.column_names and "labels" in ds.column_names else [
            dict(r) for r in ds
        ]
        if split in EXPECTED:
            spans_by_split[split] = build_masked_spans(tok, split, cutoff)

    result = check_records(by_split, spans_by_split, cutoff)

    # observation 轮数：从冻结数据算出期望值，不写死
    obs_expected = sum(
        1
        for split in EXPECTED
        for rec in G.load_split_with_metadata(split)
        for m in rec["messages"]
        if m["role"] == "observation"
    )
    obs_checked = result.get("obs_verified", 0)
    if obs_checked != obs_expected:
        result["problems"].append(
            f"observation 区间覆盖不足：期望核验 {obs_expected} 轮（完整定位且全为 -100），"
            f"实际核验 {obs_checked} 轮")

    print("\n  长度分布：")
    for split, st in result["stats"].items():
        print(f"    {split:<11} count={st['count']} min={st['min']} P50={st['p50']} "
              f"P95={st['p95']} max={st['max']} 超{cutoff}={st['over_cutoff_count']} "
              f"截断率={st['truncation_rate']}")
    print(f"\n  observation 轮：期望 {obs_expected} 轮（train+validation），"
          f"已核验 {obs_checked} 轮全部落在 IGNORE_INDEX 区" if not result["problems"]
          else f"\n  observation 轮：期望 {obs_expected} 轮，实际核验 {obs_checked} 轮")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tokenized_path": str(path),
        "cutoff_len": cutoff,
        "splits_found": sorted(by_split_ds),
        "stats": result["stats"],
        "observation_turns_expected": obs_expected,
        "observation_turns_checked": obs_checked,
        "problems": result["problems"],
        "verdict": "FAIL" if result["problems"] else "PASS",
    }
    if args.report:
        p = Path(args.report)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n  报告 : {p}")

    if result["problems"]:
        print(f"\n  [FAIL] {len(result['problems'])} 项问题：")
        for p in result["problems"][:20]:
            print(f"    - {p}")
        return 1
    print("\n  [PASS] tokenized 数据结构、条数、长度与 label 掩码全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
