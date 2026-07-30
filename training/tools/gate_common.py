#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""4090 执行包的共享读取层：唯一的"事实来源"解析器。

设计口径：
- **不复制参数**。训练超参只有一份来源：
  ``configs/train-qwen3-8b-qlora-production-linux.yaml``。
  本模块只**读**它，不改它，也不在别处重复定义。
- **不硬编码 SHA-256**。数据指纹只有一份来源：
  ``datasets/customer-service-dataset-manifest.json``。
  另外交叉核对训练 YAML 注释里的绑定值，两处不一致即报错。
- **不依赖第三方库**。只用标准库，因此在 Mac 上不装任何依赖也能跑静态校验。

被以下脚本共用：
  preprocess_report.py / evaluate.py / select_best_checkpoint.py /
  adapter_reload_check.py / package_adapter.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PRODUCTION = REPO_ROOT / "configs/train-qwen3-8b-qlora-production-linux.yaml"
CONFIG_SMOKE = REPO_ROOT / "configs/train-qwen3-8b-qlora-smoke-linux.yaml"
MANIFEST = REPO_ROOT / "datasets/customer-service-dataset-manifest.json"
DATASET_INFO = REPO_ROOT / "datasets/dataset_info.json"
DATASETS_DIR = REPO_ROOT / "datasets"

SPLIT_FILES = {
    "train": "customer-service-train-640.json",
    "validation": "customer-service-validation-80.json",
    "test": "customer-service-test-80.json",
}
EXPECTED_COUNTS = {"train": 640, "validation": 80, "test": 80}

# 训练/验证允许使用；test 只允许离线评测加载，禁止出现在训练配置的数据字段里。
TRAINING_DATASET_KEYS = ("dataset", "eval_dataset")
TEST_DATASET_NAME = "customer_service_test_80"


class GateError(RuntimeError):
    """关键项失败。调用方应当以非零码退出，不得继续下一阶段。"""


# ---------------------------------------------------------------------------
# 极简 YAML 标量读取
# ---------------------------------------------------------------------------
def read_yaml_scalars(path: Path) -> dict:
    """只解析顶层 ``key: value`` 标量，够用且不引入 PyYAML 依赖。

    训练 YAML 全部是顶层标量，没有嵌套结构；一旦将来出现嵌套，
    这里读不到的键会以 KeyError 暴露，而不会静默取到错误值。
    """
    if not path.is_file():
        raise GateError(f"配置文件不存在：{path}")
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith((" ", "\t", "#")):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$", line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2)
        raw = raw.split(" #", 1)[0].strip()
        out[key] = raw.strip("'\"")
    return out


def production_config() -> dict:
    return read_yaml_scalars(CONFIG_PRODUCTION)


# ---------------------------------------------------------------------------
# 数据指纹
# ---------------------------------------------------------------------------
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def expected_shas() -> dict:
    """从 manifest 读取三份 split 的期望 SHA-256。"""
    if not MANIFEST.is_file():
        raise GateError(f"manifest 不存在：{MANIFEST}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    files = manifest.get("files")
    out: dict[str, str] = {}
    # manifest 的 files 结构在不同版本里可能是 dict 或 list，两种都兼容，
    # 解析不到就直接报错，绝不猜。
    if isinstance(files, dict):
        for split, meta in files.items():
            if isinstance(meta, dict) and "sha256" in meta:
                out[split] = meta["sha256"]
    elif isinstance(files, list):
        for meta in files:
            if isinstance(meta, dict) and "sha256" in meta and "split" in meta:
                out[meta["split"]] = meta["sha256"]
    if set(out) != set(SPLIT_FILES):
        # 回退：按文件名在整个 manifest 文本里定位 sha256 邻近关系过于脆弱，
        # 因此这里直接失败，要求人工确认 manifest 结构。
        raise GateError(
            f"无法从 manifest 解析三份 split 的 sha256（解析到 {sorted(out)}）。"
            "manifest 结构可能已变化，请人工确认后再继续。"
        )
    return out


def verify_datasets(strict_test: bool = True) -> dict:
    """校验三份 split 的条数与 SHA-256，并与训练 YAML 的绑定注释交叉核对。"""
    expected = expected_shas()
    cfg_text = CONFIG_PRODUCTION.read_text(encoding="utf-8")
    result = {}
    problems = []
    for split, name in SPLIT_FILES.items():
        path = DATASETS_DIR / name
        if not path.is_file():
            problems.append(f"{name} 不存在")
            continue
        actual = sha256_file(path)
        records = json.loads(path.read_text(encoding="utf-8"))
        count = len(records)
        ok_sha = actual == expected[split]
        ok_cnt = count == EXPECTED_COUNTS[split]
        # 训练 YAML 的注释里必须记录同一枚 SHA
        ok_cfg = expected[split] in cfg_text
        result[split] = {
            "file": name,
            "count": count,
            "expected_count": EXPECTED_COUNTS[split],
            "sha256": actual,
            "expected_sha256": expected[split],
            "sha_match": ok_sha,
            "count_match": ok_cnt,
            "config_binding_match": ok_cfg,
        }
        if not ok_sha:
            problems.append(f"{name} SHA-256 不符：实际 {actual}，manifest {expected[split]}")
        if not ok_cnt:
            problems.append(f"{name} 条数不符：实际 {count}，期望 {EXPECTED_COUNTS[split]}")
        if not ok_cfg:
            problems.append(f"{name} 的 SHA-256 未在训练 YAML 的版本绑定注释中出现")
    if problems and strict_test:
        raise GateError("数据校验失败：\n  - " + "\n  - ".join(problems))
    result["_problems"] = problems
    return result


# ---------------------------------------------------------------------------
# test 集隔离
# ---------------------------------------------------------------------------
def assert_no_test_in_training_config() -> dict:
    """test-80 不得出现在训练配置的 dataset / eval_dataset 字段。"""
    cfg = production_config()
    hits = []
    for key in TRAINING_DATASET_KEYS:
        value = cfg.get(key, "")
        if TEST_DATASET_NAME in value or "test" in value.split("_")[-1:]:
            hits.append(f"{key}: {value}")
    if hits:
        raise GateError(
            "训练配置引用了 test 数据集，禁止继续：\n  - " + "\n  - ".join(hits)
        )
    return {
        "dataset": cfg.get("dataset"),
        "eval_dataset": cfg.get("eval_dataset"),
        "test_dataset_name": TEST_DATASET_NAME,
        "isolated": True,
    }


def assert_output_dirs_disjoint() -> dict:
    """正式输出目录不得与 Smoke 产物目录重叠。"""
    prod = production_config().get("output_dir", "")
    smoke = read_yaml_scalars(CONFIG_SMOKE).get("output_dir", "")
    if not prod:
        raise GateError("训练配置缺少 output_dir")
    p, s = Path(prod), Path(smoke) if smoke else None
    if s is not None:
        same = p == s
        nested = str(p).startswith(str(s) + "/") or str(s).startswith(str(p) + "/")
        if same or nested:
            raise GateError(f"正式输出目录与 Smoke 目录重叠：{prod} vs {smoke}")
    return {"production_output_dir": prod, "smoke_output_dir": smoke, "disjoint": True}


# ---------------------------------------------------------------------------
# dataset_info 注册
# ---------------------------------------------------------------------------
def verify_dataset_info() -> dict:
    if not DATASET_INFO.is_file():
        raise GateError(f"dataset_info.json 不存在：{DATASET_INFO}")
    info = json.loads(DATASET_INFO.read_text(encoding="utf-8"))
    required = {
        "customer_service_train_640": "customer-service-train-640.json",
        "customer_service_validation_80": "customer-service-validation-80.json",
        "customer_service_test_80": "customer-service-test-80.json",
    }
    problems = []
    for key, filename in required.items():
        entry = info.get(key)
        if not entry:
            problems.append(f"未注册：{key}")
            continue
        if entry.get("file_name") != filename:
            problems.append(f"{key} 的 file_name 不符：{entry.get('file_name')}")
        if entry.get("formatting") != "sharegpt":
            problems.append(f"{key} 的 formatting 不是 sharegpt")
        tags = entry.get("tags", {})
        if tags.get("observation_tag") != "observation":
            problems.append(f"{key} 缺少 observation_tag=observation")
        if tags.get("function_tag") != "function_call":
            problems.append(f"{key} 缺少 function_tag=function_call")
    if problems:
        raise GateError("dataset_info.json 注册校验失败：\n  - " + "\n  - ".join(problems))
    return {"registered": sorted(required), "ok": True}


# ---------------------------------------------------------------------------
# 样本元数据（uid / category / scenario / risk_level）
# ---------------------------------------------------------------------------
def load_split_with_metadata(split: str) -> list:
    """把 split JSON 的每条记录关联回 source module 的元数据。

    split 文件本身只有 messages（训练格式，不带元数据）；uid、category、
    scenario、risk_level 来自 scripts/dataset_source。这里通过 messages
    精确匹配回连，**不修改任何数据文件**。
    """
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from dataset_source import all_items  # noqa: E402
    from dataset_source.common import to_record  # noqa: E402

    index = {}
    for item in all_items():
        key = json.dumps(to_record(item)["messages"], ensure_ascii=False, sort_keys=True)
        index[key] = item

    path = DATASETS_DIR / SPLIT_FILES[split]
    records = json.loads(path.read_text(encoding="utf-8"))
    out = []
    missing = 0
    for idx, rec in enumerate(records):
        key = json.dumps(rec["messages"], ensure_ascii=False, sort_keys=True)
        item = index.get(key)
        if item is None:
            missing += 1
            out.append({
                "index": idx, "uid": f"UNKNOWN-{split}-{idx}", "category": "unknown",
                "scenario": "unknown", "risk_level": "unknown",
                "requires_rag": None, "requires_tool": None, "messages": rec["messages"],
            })
            continue
        out.append({
            "index": idx,
            "uid": item["uid"],
            "category": item["category"],
            "scenario": item["scenario"],
            "risk_level": item["risk_level"],
            "requires_rag": item["requires_rag"],
            "requires_tool": item["requires_tool"],
            "messages": rec["messages"],
        })
    if missing:
        raise GateError(
            f"{split} 中有 {missing} 条无法关联回 source module，"
            "说明数据文件与 scripts/dataset_source 不同步，禁止继续。"
        )
    return out


def git_state() -> dict:
    import subprocess
    def run(*args):
        try:
            return subprocess.run(
                args, cwd=REPO_ROOT, capture_output=True, text=True, timeout=15
            ).stdout.strip()
        except Exception:
            return ""
    return {
        "commit": run("git", "rev-parse", "HEAD"),
        "branch": run("git", "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(run("git", "status", "--porcelain")),
    }


def config_sha256() -> str:
    return sha256_file(CONFIG_PRODUCTION)
