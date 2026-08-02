#!/usr/bin/env python3
"""正式模型加载验证脚本（环境变量驱动，不含任何硬编码路径或模型名）。

用法：
    .venv/bin/python services/test-model-load.py
    BASE_MODEL_PATH=... ADAPTER_PATH=... .venv/bin/python services/test-model-load.py

做的事情与 services/app.py 启动时完全一致（同一套 model_runtime.load_model），
额外跑一次最小生成，打印设备/精度/耗时/内存，便于人工在真机上确认。

这不是 pytest 用例，是给人看的诊断脚本；pytest 套件见 services/tests/。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import get_settings  # noqa: E402
import model_runtime  # noqa: E402


def main() -> int:
    settings = get_settings()

    print("=" * 78)
    print("正式模型加载验证")
    print("=" * 78)
    print(f"  BASE_MODEL_PATH   = {settings.base_model_path}")
    print(f"  ADAPTER_PATH      = {settings.adapter_path}")
    print(f"  期望 base revision = {settings.expected_base_revision}")
    print(f"  DEVICE preference  = {settings.device_preference}")
    print(f"  DTYPE preference   = {settings.dtype_preference}")
    print()

    try:
        result = model_runtime.load_model(
            base_model_path=settings.base_model_path,
            adapter_path=settings.adapter_path,
            expected_base_revision=settings.expected_base_revision,
            device_preference=settings.device_preference,
            dtype_preference=settings.dtype_preference,
        )
    except Exception as exc:
        print(f"[FAIL] 模型加载失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"[PASS] revision 证据：{result.base_revision_evidence}")
    print(f"[PASS] Adapter 校验：{result.adapter_detail}")
    print(f"[PASS] best_checkpoint={result.best_checkpoint} best_eval_loss={result.best_eval_loss}")
    print(f"  设备        : {result.device}（{result.device_reason}）")
    print(f"  精度        : {result.dtype_name}（{result.dtype_reason}）")
    print(f"  加载耗时     : {result.load_seconds:.2f}s")
    print(f"  峰值进程RSS  : {result.peak_rss_bytes / (1024**3):.3f} GB")
    if result.peak_device_memory_bytes is not None:
        print(f"  峰值设备内存 : {result.peak_device_memory_bytes / (1024**3):.3f} GB")

    print()
    print("--- 最小生成 smoke ---")
    messages = [
        {"role": "system", "content": "你是家电电商平台的售后客服助手。"},
        {"role": "user", "content": "你是谁？请用一句话回答。"},
    ]
    prompt = result.tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, enable_thinking=settings.enable_thinking
    )
    inputs = result.tokenizer(prompt, return_tensors="pt").to(result.model.device)

    import torch

    t0 = time.perf_counter()
    with torch.inference_mode():
        output_ids = result.model.generate(
            **inputs, max_new_tokens=64, do_sample=False,
            pad_token_id=result.tokenizer.pad_token_id or result.tokenizer.eos_token_id,
        )
    elapsed = time.perf_counter() - t0
    answer = result.tokenizer.decode(
        output_ids[0, inputs["input_ids"].shape[-1]:], skip_special_tokens=True
    ).strip()

    print(f"  生成耗时     : {elapsed:.2f}s")
    print(f"  回答是否为空  : {len(answer) == 0}")
    print(f"  回答         : {answer}")
    print()
    print("[PASS] 正式模型加载与最小生成验证通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
