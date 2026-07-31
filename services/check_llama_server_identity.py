#!/usr/bin/env python3
"""供 shell 脚本调用的 CLI：复用 llama_cpp_backend.py 里已经实现、已经被
pytest 覆盖的校验逻辑，避免在 bash 里重新拿 grep/sed 解析 JSON（脆弱且没有测试）。

两种模式：
  manifest —— 启动前校验受控 manifest + GGUF 文件（SHA-256/revision/adapter_scale）
  upstream —— 启动后校验正在运行的 llama-server 是否确实挂了正确的 Adapter

退出码：0 = 通过；1 = 失败（详情打到 stderr，供调用方直接展示）。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llama_cpp_backend as backend  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["manifest", "upstream"], required=True)

    # manifest 模式
    ap.add_argument("--gguf-dir")
    ap.add_argument("--manifest")
    ap.add_argument("--expected-revision")
    ap.add_argument("--expected-scale", type=float, default=1.0)

    # upstream 模式
    ap.add_argument("--base-url", default="http://127.0.0.1:8002")
    ap.add_argument("--timeout", type=float, default=5.0)
    ap.add_argument("--adapter-basename")

    args = ap.parse_args()

    if args.mode == "manifest":
        if not (args.gguf_dir and args.manifest and args.expected_revision):
            print("manifest 模式需要 --gguf-dir --manifest --expected-revision", file=sys.stderr)
            return 2
        result = backend.load_llama_cpp_backend(
            Path(args.gguf_dir), Path(args.manifest), args.expected_revision, args.expected_scale
        )
        if not result.fastapi_loaded:
            print(f"[FAIL] manifest 校验失败：{result.load_error}", file=sys.stderr)
            return 1
        print(
            f"[PASS] manifest 校验通过：base_sha={result.base_gguf_sha256[:12]}… "
            f"adapter_sha={result.adapter_gguf_sha256[:12]}… "
            f"adapter={result.adapter_gguf_basename} scale={result.adapter_scale} "
            f"revision={result.base_revision}"
        )
        # 供调用方（bash）用一行输出取到 adapter basename，避免重复解析 manifest
        print(f"ADAPTER_BASENAME={result.adapter_gguf_basename}")
        return 0

    # upstream 模式
    if not args.adapter_basename:
        print("upstream 模式需要 --adapter-basename", file=sys.stderr)
        return 2
    result = asyncio.run(
        backend.check_upstream_identity(
            args.base_url, args.timeout, args.adapter_basename, args.expected_scale
        )
    )
    if not result.matched:
        print(f"[FAIL] upstream 身份校验失败：{result.detail}", file=sys.stderr)
        return 1
    print(f"[PASS] upstream 身份校验通过：{result.detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
