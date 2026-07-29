#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 scripts/dataset_source 生成正式训练数据集与 manifest。

用法：
    python3 scripts/build_customer_service_dataset.py

产物：
    datasets/customer-service-train-640.json
    datasets/customer-service-validation-80.json
    datasets/customer-service-test-80.json
    datasets/customer-service-dataset-manifest.json

样本内容全部由 dataset_source 下的模块人工编写，本脚本只做校验、
固定随机种子的洗牌和序列化，不做任何自动改写或数据增强。
"""

import hashlib
import json
import random
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from dataset_source import all_items  # noqa: E402
from dataset_source.common import (  # noqa: E402
    CATEGORIES,
    RESERVED_ORDER_IDS,
    RISK_LEVELS,
    SCENARIOS,
    SPLITS,
    to_record,
)

RANDOM_SEED = 20260729
DATASET_VERSION = "customer-service-2026-07-v1"
CREATED_AT = "2026-07-29T00:00:00+08:00"
BASE_MODEL = "Qwen/Qwen3-8B"

EXPECTED_SPLIT_COUNT = {"train": 640, "validation": 80, "test": 80}
EXPECTED_CATEGORY_COUNT = {
    "refrigerator": 160,
    "television": 120,
    "monitor": 120,
    "order_logistics": 100,
    "return_refund": 100,
    "warranty_service": 80,
    "complaint_escalation": 50,
    "safety_refusal": 40,
    "injection_degradation": 30,
}

SPLIT_FILES = {
    "train": "customer-service-train-640.json",
    "validation": "customer-service-validation-80.json",
    "test": "customer-service-test-80.json",
}


def fail(message):
    print(f"[BUILD FAIL] {message}")
    sys.exit(1)


def main():
    items = all_items()

    uids = [item["uid"] for item in items]
    duplicated = [uid for uid, count in Counter(uids).items() if count > 1]
    if duplicated:
        fail(f"uid 重复：{duplicated}")

    split_count = Counter(item["split"] for item in items)
    if dict(split_count) != EXPECTED_SPLIT_COUNT:
        fail(f"split 数量不符，期望 {EXPECTED_SPLIT_COUNT}，实际 {dict(split_count)}")

    category_count = Counter(item["category"] for item in items)
    if dict(category_count) != EXPECTED_CATEGORY_COUNT:
        fail(f"类别数量不符，期望 {EXPECTED_CATEGORY_COUNT}，实际 {dict(category_count)}")

    # 保留给 Mock 后端 / Agent 集成测试的订单号不得进入训练数据。
    for item in items:
        blob = "".join(item["turns"])
        for reserved in RESERVED_ORDER_IDS:
            if reserved in blob:
                fail(f"{item['uid']} 使用了保留订单号 {reserved}")

    datasets_dir = REPO_ROOT / "datasets"
    datasets_dir.mkdir(exist_ok=True)

    written = {}
    for split in SPLITS:
        split_items = [item for item in items if item["split"] == split]
        # 固定种子洗牌：保证同一份源数据每次生成的文件字节一致。
        random.Random(RANDOM_SEED).shuffle(split_items)
        records = [to_record(item) for item in split_items]
        path = datasets_dir / SPLIT_FILES[split]
        text = json.dumps(records, ensure_ascii=False, indent=2) + "\n"
        path.write_text(text, encoding="utf-8")
        written[split] = {
            "file_name": SPLIT_FILES[split],
            "count": len(records),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        }
        print(f"写入 {path.relative_to(REPO_ROOT)}：{len(records)} 条")

    def counter_by(key):
        return dict(Counter(item[key] for item in items))

    def counter_by_split(key):
        out = {}
        for split in SPLITS:
            out[split] = dict(
                Counter(item[key] for item in items if item["split"] == split)
            )
        return out

    manifest = {
        "dataset_version": DATASET_VERSION,
        "created_at": CREATED_AT,
        "total_count": len(items),
        "split_count": {split: split_count[split] for split in SPLITS},
        "category_count": {c: category_count[c] for c in CATEGORIES},
        "category_count_by_split": counter_by_split("category"),
        "scenario_count": {s: counter_by("scenario").get(s, 0) for s in SCENARIOS},
        "risk_level_count": {r: counter_by("risk_level").get(r, 0) for r in RISK_LEVELS},
        "requires_rag_count": sum(1 for i in items if i["requires_rag"]),
        "requires_tool_count": sum(1 for i in items if i["requires_tool"]),
        "expected_tool_count": dict(
            Counter(i["expected_tool"] for i in items if i.get("expected_tool"))
        ),
        "tool_result_grounded_count": sum(1 for i in items if i["tool_result_grounded"]),
        "multi_turn_count": sum(1 for i in items if len(i["turns"]) > 2),
        "system_prompt_count": counter_by("system_key"),
        "source": "人工编写（Anthropic Claude 辅助起草，作者逐条复核），未使用真实客服会话、未抓取第三方数据",
        "license": "CC-BY-4.0（仅限本项目训练与评测使用，不含任何真实用户数据）",
        "base_model": BASE_MODEL,
        "random_seed": RANDOM_SEED,
        "generation_method": (
            "按类别/场景矩阵人工撰写 → 固定种子洗牌 → 审计脚本校验；"
            "不使用模板批量替换品牌、型号或订单号生成伪多样性"
        ),
        "responsibility_boundary": {
            "qlora": "客服语气、回复结构、意图识别、澄清追问、安全边界、处理流程、拒答与升级习惯",
            "rag": "维修文档、售后政策、退款规则、物流规则、产品参数等可更新事实",
            "tools": "订单、物流、退款进度等实时状态，由 queryOrderTool 等工具提供",
            "system_prompt": "身份、规则与越权边界",
            "note": (
                "订单类样本只训练行为，不训练动态事实；"
                "具体订单状态仅出现在用户轮的 [订单系统返回] 块中，assistant 只做有依据的转述。"
            ),
        },
        "reserved_order_ids_excluded": list(RESERVED_ORDER_IDS),
        "files": written,
        "smoke_dataset_kept": "customer-service-smoke-20.json（20 条冒烟数据保持原样，未删除、未修改）",
    }

    manifest_path = datasets_dir / "customer-service-dataset-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"写入 {manifest_path.relative_to(REPO_ROOT)}")
    print("构建完成。请运行 python3 scripts/audit_customer_service_dataset.py 进行审计。")


if __name__ == "__main__":
    main()
