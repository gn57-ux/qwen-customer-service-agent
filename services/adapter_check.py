"""正式 Adapter 校验：不允许静默回退到 Smoke Adapter 或任何未经校验的目录。

依据 restore_adapter.py 生成的 RESTORE-VERIFICATION.json（与 Adapter 文件同目录，
恢复时一次性写入，包含每个文件的期望 SHA-256）。服务每次启动都重新计算文件哈希，
不信任"上次校验过就一直有效"。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

RESTORE_REPORT_NAME = "RESTORE-VERIFICATION.json"
REQUIRED_FILES = ("adapter_config.json", "adapter_model.safetensors")
FORBIDDEN_NAME_MARKERS = ("smoke",)  # Adapter 目录/版本名不得含这些标记


@dataclass(frozen=True)
class AdapterResult:
    matched: bool
    detail: str
    peft_type: str | None = None
    best_checkpoint: str | None = None
    best_eval_loss: float | None = None
    problems: list[str] = field(default_factory=list)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_adapter(adapter_dir: Path, expected_base_revision: str) -> AdapterResult:
    problems: list[str] = []

    lowered = str(adapter_dir).lower()
    if any(m in lowered for m in FORBIDDEN_NAME_MARKERS):
        return AdapterResult(
            False,
            f"Adapter 路径包含禁止标记 {FORBIDDEN_NAME_MARKERS}，拒绝加载：{adapter_dir}",
        )

    if not adapter_dir.is_dir():
        return AdapterResult(False, f"Adapter 目录不存在：{adapter_dir}")

    for name in REQUIRED_FILES:
        if not (adapter_dir / name).is_file():
            problems.append(f"缺少必需文件：{name}")
    if problems:
        return AdapterResult(False, "；".join(problems), problems=problems)

    try:
        adapter_config = json.loads((adapter_dir / "adapter_config.json").read_text(encoding="utf-8"))
    except Exception as exc:
        return AdapterResult(False, f"adapter_config.json 不可解析：{exc}")
    peft_type = adapter_config.get("peft_type")
    if peft_type != "LORA":
        return AdapterResult(False, f"peft_type 不是 LORA：{peft_type}", peft_type=peft_type)

    report_path = adapter_dir / RESTORE_REPORT_NAME
    if not report_path.is_file():
        return AdapterResult(
            False,
            f"缺少恢复校验报告 {RESTORE_REPORT_NAME}；未经校验的 Adapter 不允许加载。"
            "请通过 services/restore_adapter.py 从正式 tar.gz 恢复。",
            peft_type=peft_type,
        )
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return AdapterResult(False, f"恢复校验报告不可解析：{exc}", peft_type=peft_type)

    if report.get("verdict") != "PASS":
        return AdapterResult(
            False, f"恢复校验报告 verdict={report.get('verdict')}，不是 PASS", peft_type=peft_type
        )

    meta_checks = report.get("metadata_checks", {})
    actual_rev = meta_checks.get("base_revision_actual")
    if actual_rev != expected_base_revision:
        problems.append(
            f"Adapter 绑定的 base revision（{actual_rev}）与期望（{expected_base_revision}）不符"
        )

    # 每次启动都重新计算文件哈希，不信任历史报告本身没被篡改
    for entry in report.get("file_verification", []):
        name = entry.get("name")
        expected_sha = entry.get("expected_sha256")
        p = adapter_dir / str(name)
        if not p.is_file():
            problems.append(f"{name} 缺失（曾恢复时存在）")
            continue
        if not expected_sha:
            problems.append(f"{name} 恢复报告中缺少 expected_sha256，无法复核")
            continue
        actual_sha = _sha256(p)
        if actual_sha != expected_sha:
            problems.append(f"{name} SHA-256 与恢复时不符（文件可能被替换）")

    if problems:
        return AdapterResult(
            False, "；".join(problems), peft_type=peft_type, problems=problems
        )

    return AdapterResult(
        True,
        f"Adapter 校验通过：LORA r={adapter_config.get('r')} alpha={adapter_config.get('lora_alpha')}；"
        f"恢复报告 verdict=PASS；文件哈希与恢复时一致",
        peft_type=peft_type,
        best_checkpoint=meta_checks.get("best_checkpoint"),
        best_eval_loss=meta_checks.get("best_eval_loss"),
    )
