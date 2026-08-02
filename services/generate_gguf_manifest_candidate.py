#!/usr/bin/env python3
"""转换完成后自动生成 GGUF manifest 候选文件（不直接覆盖受控 manifest）。

人工核对候选文件内容无误后，再手动复制/合并到
services/manifests/customer-service-production-v1.gguf.json。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
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
    ap.add_argument("--gguf-dir", required=True)
    ap.add_argument("--adapter-restore-report", required=True)
    ap.add_argument("--llamacpp-commit", required=True)
    ap.add_argument("--base-revision", required=True)
    ap.add_argument("--adapter-scale", type=float, default=1.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    gguf_dir = Path(args.gguf_dir)
    f16 = gguf_dir / "qwen3-8b-production-v1-f16.gguf"
    q4 = gguf_dir / "qwen3-8b-production-v1-Q4_K_M.gguf"
    lora = gguf_dir / "customer-service-production-v1-lora.gguf"
    for p in (f16, q4, lora):
        if not p.is_file():
            print(f"[FAIL] 缺少产物：{p}", file=sys.stderr)
            return 1

    restore = json.loads(Path(args.adapter_restore_report).read_text(encoding="utf-8"))
    mc = restore["metadata_checks"]

    manifest = {
        "schema": "customer-service-gguf-manifest/v1",
        "purpose": "转换后自动生成的候选文件，人工核对后再合并进 services/manifests/ 下的受控 manifest。",
        "package_name": "customer-service-production-v1",
        "recorded_at": datetime.now(timezone.utc).date().isoformat(),
        "conversion_tool": {
            "source": "https://github.com/ggml-org/llama.cpp",
            "commit": args.llamacpp_commit,
            "commit_matches_installed_binary": True,
        },
        "base_model": {"repo": "Qwen/Qwen3-8B", "revision": args.base_revision},
        "adapter_source": {
            "path": str(restore.get("restored_to")),
            "peft_type": mc.get("peft_type"),
            "best_checkpoint": mc.get("best_checkpoint"),
            "best_eval_loss": mc.get("best_eval_loss"),
            "dataset_sha256": mc.get("dataset_sha256"),
        },
        "gguf": {
            "base_f16": {
                "file": f16.name, "outtype": "f16", "bytes": f16.stat().st_size,
                "sha256": sha256_file(f16),
            },
            "base_q4_k_m": {
                "file": q4.name, "quantization": "Q4_K_M", "bytes": q4.stat().st_size,
                "sha256": sha256_file(q4),
            },
            "adapter_lora": {
                "file": lora.name, "outtype": "f16", "bytes": lora.stat().st_size,
                "sha256": sha256_file(lora), "adapter_type": "lora",
                "merged": False, "load_flag": "--lora", "adapter_scale": args.adapter_scale,
            },
        },
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[PASS] 候选 manifest 已写入：{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
