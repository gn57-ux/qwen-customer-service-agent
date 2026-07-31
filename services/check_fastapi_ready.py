#!/usr/bin/env python3
"""start.sh 用来判定 FastAPI 是否真正就绪：不只是 HTTP 200，而是解析 /health
并核对 backend/fastapi_loaded/upstream_health/upstream_identity/adapter_scale，
再拿 manifest 文件里的 SHA-256 独立复核 /health 报告的 SHA-256——不只信任
FastAPI 自己的内存状态。

退出码：0 = 就绪；1 = 未就绪（原因打到 stderr）。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000/health")
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--expected-scale", type=float, default=1.0)
    ap.add_argument("--timeout", type=float, default=5.0)
    args = ap.parse_args()

    try:
        with urllib.request.urlopen(args.url, timeout=args.timeout) as resp:
            body = json.loads(resp.read())
    except Exception as exc:
        print(f"[FAIL] 无法获取 {args.url}：{exc}", file=sys.stderr)
        return 1

    backend = body.get("backend")
    problems = []

    if backend == "llama_cpp":
        if body.get("fastapi_loaded") is not True:
            problems.append(f"fastapi_loaded={body.get('fastapi_loaded')}，期望 true")
        if body.get("upstream_health") is not True:
            problems.append(f"upstream_health={body.get('upstream_health')}，期望 true")
        if body.get("upstream_identity") is not True:
            problems.append(f"upstream_identity={body.get('upstream_identity')}，期望 true"
                            f"（detail={body.get('upstream_identity_detail')}）")
        actual_scale = body.get("adapter_scale")
        if actual_scale is None or float(actual_scale) != args.expected_scale:
            problems.append(f"adapter_scale={actual_scale}，期望 {args.expected_scale}")

        if args.manifest:
            manifest_path = Path(args.manifest)
            if not manifest_path.is_file():
                problems.append(f"manifest 不存在：{manifest_path}")
            else:
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    expected_base_sha = manifest["gguf"]["base_q4_k_m"]["sha256"]
                    expected_adapter_sha = manifest["gguf"]["adapter_lora"]["sha256"]
                except Exception as exc:
                    problems.append(f"manifest 不可解析：{exc}")
                else:
                    if body.get("base_gguf_sha256") != expected_base_sha:
                        problems.append(
                            f"base_gguf_sha256 与 manifest 不符：health={body.get('base_gguf_sha256')} "
                            f"manifest={expected_base_sha}"
                        )
                    if body.get("adapter_gguf_sha256") != expected_adapter_sha:
                        problems.append(
                            f"adapter_gguf_sha256 与 manifest 不符：health={body.get('adapter_gguf_sha256')} "
                            f"manifest={expected_adapter_sha}"
                        )
    elif backend == "pytorch_peft":
        if body.get("loaded") is not True:
            problems.append(f"loaded={body.get('loaded')}，期望 true")
    else:
        problems.append(f"未知 backend：{backend}")

    if problems:
        print("[FAIL] FastAPI 未真正就绪：", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"  完整 /health：{json.dumps(body, ensure_ascii=False)}", file=sys.stderr)
        return 1

    print(f"[PASS] FastAPI 就绪：backend={backend}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
