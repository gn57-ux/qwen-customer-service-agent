#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Adapter 重载校验：Base 4-bit + 最佳 Adapter，做最小推理 smoke。

做什么：
- 以与评测**完全相同**的量化配置加载 Base（4-bit NF4 / bf16 compute）；
- 叠加 PEFT Adapter，校验 ``peft_type == LORA``、target_modules、rank；
- 跑 2 条最小 prompt，确认能产出非空文本（只证明"能加载能出字"，
  质量由 07 阶段的 test-80 终测负责）；
- 记录 Adapter 体积、可训练参数量、峰值显存。

不做什么：
- 不做模型融合（merge_and_unload）—— 需要单独批准；
- 不下载模型；Base 目录不存在直接报错退出。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_common as G  # noqa: E402
import evaluate as EV  # noqa: E402  复用同一份量化/生成配置，避免两套参数

SMOKE_PROMPTS = [
    [{"role": "system", "content": "你是家电电商平台的售后客服助手。"},
     {"role": "user", "content": "冰箱不制冷应该先检查什么？"}],
    [{"role": "system", "content": "你是家电电商平台的售后客服助手。"},
     {"role": "user", "content": "帮我查一下订单 ORD8888 的状态。"}],
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter-path", required=True)
    ap.add_argument("--report-dir", default=None)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    args = ap.parse_args()

    adapter = Path(args.adapter_path)
    cfg = G.production_config()
    report_dir = Path(args.report_dir or (cfg["output_dir"] + "/adapter-reload"))

    if not adapter.is_dir():
        print(f"[FAIL] Adapter 目录不存在：{adapter}", file=sys.stderr)
        return 1
    ac_path = adapter / "adapter_config.json"
    if not ac_path.is_file():
        print(f"[FAIL] 缺少 adapter_config.json：{ac_path}", file=sys.stderr)
        return 1
    adapter_config = json.loads(ac_path.read_text(encoding="utf-8"))
    if adapter_config.get("peft_type") != "LORA":
        print(f"[FAIL] peft_type={adapter_config.get('peft_type')}，不是 LORA", file=sys.stderr)
        return 1

    try:
        import torch
    except ImportError:
        print("[FAIL] 本机未安装 torch，无法执行重载校验（此步骤只能在 4090 上运行）",
              file=sys.stderr)
        return 1
    if not torch.cuda.is_available():
        print("[FAIL] 未检测到 CUDA 设备；Adapter 重载校验只能在 4090 上运行", file=sys.stderr)
        return 1

    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    try:
        tok, model, meta = EV.load_model("adapter", str(adapter))
    except G.GateError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    load_s = round(time.perf_counter() - t0, 2)

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    adapter_bytes = sum(f.stat().st_size for f in adapter.iterdir() if f.is_file())

    smokes = []
    ok_all = True
    for i, msgs in enumerate(SMOKE_PROMPTS, 1):
        t = time.perf_counter()
        try:
            prompt = EV.build_prompt(tok, msgs)
            inputs = tok(prompt, return_tensors="pt").to(model.device)
            with torch.no_grad():
                out = model.generate(
                    **inputs, do_sample=False, num_beams=1,
                    max_new_tokens=args.max_new_tokens,
                    pad_token_id=tok.pad_token_id or tok.eos_token_id,
                )
            text = tok.decode(out[0][inputs["input_ids"].shape[1]:],
                              skip_special_tokens=True).strip()
            ok = len(text) > 0
        except Exception as exc:
            text, ok = f"{type(exc).__name__}: {exc}", False
        ok_all = ok_all and ok
        smokes.append({"index": i, "prompt": msgs[-1]["content"], "ok": ok,
                       "answer": text[:400], "elapsed_ms": round((time.perf_counter() - t) * 1000, 1)})

    peak_gb = round(torch.cuda.max_memory_allocated() / (1024 ** 3), 3)
    reserved_gb = round(torch.cuda.max_memory_reserved() / (1024 ** 3), 3)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "verdict": "PASS" if ok_all else "FAIL",
        "adapter_path": str(adapter),
        "base_model": meta["base_path"],
        "base_revision": meta["revision"],
        "peft": {
            "peft_type": adapter_config.get("peft_type"),
            "r": adapter_config.get("r"),
            "lora_alpha": adapter_config.get("lora_alpha"),
            "lora_dropout": adapter_config.get("lora_dropout"),
            "target_modules": adapter_config.get("target_modules"),
            "base_model_name_or_path": adapter_config.get("base_model_name_or_path"),
        },
        "footprint": {
            "adapter_dir_bytes": adapter_bytes,
            "adapter_dir_mb": round(adapter_bytes / (1024 ** 2), 2),
            "params_total": total,
            "params_trainable": trainable,
            "load_seconds": load_s,
            "peak_vram_allocated_gb": peak_gb,
            "peak_vram_reserved_gb": reserved_gb,
            "gpu": torch.cuda.get_device_name(0),
        },
        "quant_config": EV.QUANT_CONFIG,
        "smoke": smokes,
        "merged": False,
        "merge_note": "未做模型融合（merge_and_unload）；如需融合须单独批准。",
        "git": G.git_state(),
    }

    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (report_dir / f"adapter-reload-{stamp}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=" * 78)
    print("Adapter 重载校验")
    print("=" * 78)
    print(f"  Adapter        : {adapter}")
    print(f"  peft_type      : {adapter_config.get('peft_type')}  r={adapter_config.get('r')} "
          f"alpha={adapter_config.get('lora_alpha')}")
    print(f"  Base           : {meta['base_path']}  revision={meta['revision']}")
    print(f"  Adapter 体积   : {report['footprint']['adapter_dir_mb']} MB")
    print(f"  峰值显存       : allocated {peak_gb} GB / reserved {reserved_gb} GB")
    print(f"  加载耗时       : {load_s} s")
    for s in smokes:
        print(f"  smoke[{s['index']}] {'ok' if s['ok'] else 'FAIL'} {s['elapsed_ms']}ms :: "
              f"{s['answer'][:80]}")
    print(f"  报告           : {report_dir}/adapter-reload-{stamp}.json")
    print("=" * 78)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
