#!/usr/bin/env python3
"""从已校验的正式 tar.gz 恢复 Adapter，并生成 RESTORE-VERIFICATION.json。

用法：
    python3 services/restore_adapter.py \
        --tar /path/to/customer-service-production-v1-*.tar.gz \
        --manifest /path/to/customer-service-production-v1-*.manifest.json \
        --dest models/adapters/customer-service-production-v1 \
        --expect-base-revision b968826d9c46dd6066d109eabc6255188de91218

刻意不提供"从任意目录复制"的能力：唯一输入是已校验的正式 tar.gz + 其配套
manifest.json，不接受从 adapters/customer-service-smoke 或其他目录直接复制。

产出的 RESTORE-VERIFICATION.json 与 Adapter 文件同目录，
被 services/adapter_check.py 在每次服务启动时读取并重新计算哈希复核。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tar", required=True, help="正式 Adapter tar.gz 路径")
    ap.add_argument("--manifest", required=True, help="配套 manifest.json 路径")
    ap.add_argument("--dest", required=True, help="恢复目标目录（不得已存在）")
    ap.add_argument("--expect-base-revision", required=True)
    args = ap.parse_args()

    tar_path = Path(args.tar)
    manifest_path = Path(args.manifest)
    dest = Path(args.dest)

    if not tar_path.is_file():
        print(f"[FAIL] tar 不存在：{tar_path}", file=sys.stderr)
        return 1
    if not manifest_path.is_file():
        print(f"[FAIL] manifest 不存在：{manifest_path}", file=sys.stderr)
        return 1
    if dest.exists():
        print(f"[FAIL] 目标目录已存在，拒绝覆盖：{dest}", file=sys.stderr)
        return 1
    if "smoke" in str(dest).lower():
        print("[FAIL] 目标目录名包含 'smoke'，拒绝作为正式 Adapter 恢复目标", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_archive_sha = manifest["archive_sha256"]
    actual_archive_sha = sha256_file(tar_path)
    if actual_archive_sha != expected_archive_sha:
        print(
            f"[FAIL] tar.gz SHA-256 与 manifest 不符："
            f"实际 {actual_archive_sha}，manifest {expected_archive_sha}",
            file=sys.stderr,
        )
        return 1
    print(f"[PASS] archive SHA-256 匹配：{actual_archive_sha}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="adapter-restore-") as tmp:
        with tarfile.open(tar_path, "r:gz") as tf:
            tf.extractall(tmp)
        entries = [p for p in Path(tmp).iterdir()]
        if len(entries) != 1 or not entries[0].is_dir():
            print(f"[FAIL] tar 内容不是预期的单一目录结构：{entries}", file=sys.stderr)
            return 1
        entries[0].rename(dest)
    print(f"[PASS] 已解压到：{dest}")

    file_verification = []
    problems = []
    for f in manifest["files"]:
        p = dest / f["name"]
        if not p.is_file():
            problems.append(f"缺少文件: {f['name']}")
            continue
        actual_size = p.stat().st_size
        actual_sha = sha256_file(p)
        ok_size = actual_size == f["bytes"]
        ok_sha = actual_sha == f["sha256"]
        file_verification.append({
            "name": f["name"], "expected_bytes": f["bytes"], "expected_sha256": f["sha256"],
            "actual_bytes": actual_size, "actual_sha256": actual_sha,
            "size_ok": ok_size, "sha_ok": ok_sha,
        })
        status = "PASS" if ok_size and ok_sha else "FAIL"
        print(f"  [{status}] {f['name']}")
        if not (ok_size and ok_sha):
            problems.append(f"{f['name']}: size_ok={ok_size} sha_ok={ok_sha}")

    meta = manifest["metadata"]
    rev_ok = meta["base_model"]["revision"] == args.expect_base_revision
    if not rev_ok:
        problems.append(
            f"base revision 不符：manifest={meta['base_model']['revision']}，"
            f"期望={args.expect_base_revision}"
        )

    overall_ok = not problems

    report = {
        "restored_at": datetime.now(timezone.utc).isoformat(),
        "source_tar": str(tar_path.resolve()),
        "source_tar_sha256": actual_archive_sha,
        "restored_to": str(dest.resolve()),
        "file_verification": file_verification,
        "metadata_checks": {
            "base_revision_expected": args.expect_base_revision,
            "base_revision_actual": meta["base_model"]["revision"],
            "base_revision_match": rev_ok,
            "best_checkpoint": meta["best_checkpoint"],
            "best_eval_loss": meta["best_eval_loss"],
            "dataset_sha256": meta["dataset_sha256"],
            "peft_type": meta["adapter"]["peft_type"],
            "git_commit": meta["git"]["commit"],
        },
        "problems": problems,
        "verdict": "PASS" if overall_ok else "FAIL",
        "note": "从已校验的正式 tar.gz 解压；未从 Smoke Adapter 或其他目录复制任何文件。"
                "file_verification 中的 expected_sha256 供服务启动时独立复核。",
    }
    out = dest / "RESTORE-VERIFICATION.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n恢复校验报告：{out}")
    print(f"结论：{report['verdict']}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
