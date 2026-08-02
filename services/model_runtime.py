"""模型加载与设备/精度探测。与 FastAPI 路由分离，便于测试时用桩替换。"""

from __future__ import annotations

import logging
import resource
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger("customer_service.model_runtime")


@dataclass
class DtypeProbeResult:
    dtype_name: str  # "bfloat16" | "float16"
    reason: str


@dataclass
class DeviceResult:
    device: str  # "mps" | "cuda" | "cpu"
    reason: str


@dataclass
class LoadResult:
    tokenizer: Any
    model: Any
    device: str
    dtype_name: str
    dtype_reason: str
    device_reason: str
    load_seconds: float
    peak_rss_bytes: int
    peak_device_memory_bytes: int | None
    base_revision_evidence: str
    adapter_detail: str
    best_checkpoint: str | None
    best_eval_loss: float | None


def peak_rss_bytes() -> int:
    """当前进程峰值常驻内存（字节）。macOS 上 ru_maxrss 单位就是字节。"""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def resolve_device(preference: str) -> DeviceResult:
    import torch

    if preference == "cpu":
        return DeviceResult("cpu", "显式指定 DEVICE=cpu")
    if preference == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("DEVICE=cuda 但本机 CUDA 不可用")
        return DeviceResult("cuda", "显式指定 DEVICE=cuda，CUDA 可用")
    if preference == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("DEVICE=mps 但本机 MPS 不可用")
        return DeviceResult("mps", "显式指定 DEVICE=mps，MPS 可用")

    # auto
    if torch.backends.mps.is_available():
        return DeviceResult("mps", "auto：检测到 MPS 可用（Apple Silicon）")
    if torch.cuda.is_available():
        return DeviceResult("cuda", "auto：检测到 CUDA 可用")
    return DeviceResult("cpu", "auto：MPS 与 CUDA 均不可用，回退 CPU（推理会很慢）")


def probe_dtype(device: str, preference: str) -> DtypeProbeResult:
    """启动前用真实算子探测 bf16 是否可用；不可用才显式降级 fp16。"""
    import torch

    if preference in ("float16", "fp16"):
        return DtypeProbeResult("float16", "显式指定 DTYPE=float16")
    if preference in ("bfloat16", "bf16"):
        return DtypeProbeResult("bfloat16", "显式指定 DTYPE=bfloat16（未探测，风险自负）")

    if device == "cpu":
        return DtypeProbeResult("float16", "CPU 设备默认使用 float16（bf16 在 CPU 上通常很慢）")

    try:
        a = torch.randn(64, 64, dtype=torch.bfloat16, device=device)
        b = torch.randn(64, 64, dtype=torch.bfloat16, device=device)
        c = a @ b
        ln = torch.nn.LayerNorm(64, dtype=torch.bfloat16, device=device)
        y = ln(c)
        y = torch.nn.functional.gelu(y)
        y = torch.nn.functional.softmax(y, dim=-1)
        if device == "mps":
            torch.mps.synchronize()
        elif device == "cuda":
            torch.cuda.synchronize()
        if not torch.isfinite(y).all():
            raise RuntimeError("bf16 探测结果包含非有限值")
        return DtypeProbeResult(
            "bfloat16",
            f"启动探测通过：{device} 上 matmul/LayerNorm/GELU/Softmax 结果均为有限值",
        )
    except Exception as exc:
        return DtypeProbeResult(
            "float16",
            f"bf16 在 {device} 上探测失败（{type(exc).__name__}: {exc}），显式降级为 float16",
        )


def load_model(
    base_model_path: Path,
    adapter_path: Path,
    expected_base_revision: str,
    device_preference: str,
    dtype_preference: str,
) -> LoadResult:
    """加载失败必须抛异常，调用方不得吞掉后假装服务正常。"""
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from revision_check import verify_revision
    from adapter_check import verify_adapter

    rev_result = verify_revision(base_model_path, expected_base_revision)
    if not rev_result.matched:
        raise RuntimeError(f"基础模型 revision 校验失败：{rev_result.detail}")
    logger.info("revision 校验通过：%s", rev_result.detail)

    adapter_result = verify_adapter(adapter_path, expected_base_revision)
    if not adapter_result.matched:
        raise RuntimeError(f"Adapter 校验失败：{adapter_result.detail}")
    logger.info("Adapter 校验通过：%s", adapter_result.detail)

    device_result = resolve_device(device_preference)
    dtype_result = probe_dtype(device_result.device, dtype_preference)
    torch_dtype = torch.bfloat16 if dtype_result.dtype_name == "bfloat16" else torch.float16

    start = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(str(base_model_path), trust_remote_code=True)

    # 尽量直接把权重调度到目标设备，避免先整体加载到 CPU 再整体搬运（峰值内存翻倍）。
    # device_map={"": device} 让 accelerate 按分片直接分配到目标设备。
    model = AutoModelForCausalLM.from_pretrained(
        str(base_model_path),
        trust_remote_code=True,
        dtype=torch_dtype,
        device_map={"": device_result.device},
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(model, str(adapter_path))
    model.eval()
    load_seconds = time.perf_counter() - start

    peak_device_memory = None
    if device_result.device == "mps":
        peak_device_memory = torch.mps.driver_allocated_memory()
    elif device_result.device == "cuda":
        peak_device_memory = torch.cuda.max_memory_allocated()

    return LoadResult(
        tokenizer=tokenizer,
        model=model,
        device=device_result.device,
        dtype_name=dtype_result.dtype_name,
        dtype_reason=dtype_result.reason,
        device_reason=device_result.reason,
        load_seconds=load_seconds,
        peak_rss_bytes=peak_rss_bytes(),
        peak_device_memory_bytes=peak_device_memory,
        base_revision_evidence=rev_result.detail,
        adapter_detail=adapter_result.detail,
        best_checkpoint=adapter_result.best_checkpoint,
        best_eval_loss=adapter_result.best_eval_loss,
    )
