"""llama.cpp backend：FastAPI 只做网关，真正推理在独立的 llama-server 进程里。

职责边界：
- FastAPI 在启动时**一次性**校验 GGUF 资产：受控 manifest（services/manifests/…，
  可提交，唯一证据源）存在且可解析、Base/Adapter 字段齐全、SHA-256 匹配、
  revision 等于期望值、adapter_scale 等于期望值——任一不符即启动失败，
  不允许"无 Adapter 也报告 production"或"回退 Base-only"。
- llama-server 是否可达、挂载的是否确实是这份 Adapter，是**运行时状态**，由
  `check_upstream_identity()` 判定，不影响 FastAPI 自身是否已启动；请求时才检查，
  不可达/身份不符时该请求返回 503，绝不静默转发给"健康但没挂对 Adapter"的实例。
- 服务端安全 System Prompt 在 FastAPI 侧合并（复用 app.ensure_system_prompt），
  llama-server 只执行已经合并好的 messages，不自己决定 system 内容。
"""

from __future__ import annotations

import hashlib
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

import httpx


@dataclass(frozen=True)
class LlamaCppBackendState:
    fastapi_loaded: bool
    load_error: str | None
    base_gguf_sha256: str | None
    adapter_gguf_sha256: str | None
    adapter_gguf_basename: str | None
    adapter_scale: float | None
    base_revision: str | None
    best_checkpoint: str | None
    best_eval_loss: float | None
    base_gguf_path: str | None
    adapter_gguf_path: str | None


@dataclass(frozen=True)
class IdentityResult:
    matched: bool
    detail: str
    upstream_up: bool = False


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_llama_cpp_backend(
    gguf_dir: Path,
    manifest_path: Path,
    expected_base_revision: str,
    expected_adapter_scale: float,
) -> LlamaCppBackendState:
    """启动时一次性校验：manifest 存在且可解析、字段齐全、GGUF 文件存在、
    SHA-256 匹配、revision 与 adapter_scale 都必须等于期望值——不只是读出来展示。

    任一失败都返回 fastapi_loaded=False 并带上原因；调用方（app.py 的 lifespan、
    llama-server-up.sh）必须把这当成硬失败处理，不允许继续。
    """
    _fail = lambda msg: LlamaCppBackendState(  # noqa: E731
        False, msg, None, None, None, None, None, None, None, None, None
    )

    if not manifest_path.is_file():
        return _fail(f"manifest 不存在：{manifest_path}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return _fail(f"manifest 不可解析：{exc}")

    base_model = manifest.get("base_model")
    gguf = manifest.get("gguf")
    if not isinstance(base_model, dict) or not base_model.get("revision"):
        return _fail("manifest 缺少 base_model.revision")
    if not isinstance(gguf, dict):
        return _fail("manifest 缺少 gguf 字段")

    base_info = gguf.get("base_q4_k_m")
    adapter_info = gguf.get("adapter_lora")
    if not isinstance(base_info, dict) or not base_info.get("file") or not base_info.get("sha256"):
        return _fail("manifest 缺少 gguf.base_q4_k_m 的 file/sha256")
    if not isinstance(adapter_info, dict) or not adapter_info.get("file") or not adapter_info.get("sha256"):
        # 硬性要求：不允许无 Adapter 启动后仍报告 production 模型。
        return _fail("manifest 缺少 gguf.adapter_lora 的 file/sha256 —— 不允许 Base-only 启动并冒充 production")

    actual_revision = base_model["revision"]
    if actual_revision != expected_base_revision:
        return _fail(
            f"manifest 的 base_model.revision（{actual_revision}）与期望（{expected_base_revision}）不符"
        )

    manifest_scale = adapter_info.get("adapter_scale")
    if manifest_scale is None:
        return _fail("manifest 缺少 gguf.adapter_lora.adapter_scale")
    if float(manifest_scale) != float(expected_adapter_scale):
        return _fail(
            f"manifest 的 adapter_scale（{manifest_scale}）与期望（{expected_adapter_scale}）不符"
        )

    base_path = gguf_dir / base_info["file"]
    adapter_path = gguf_dir / adapter_info["file"]

    problems = []
    if not base_path.is_file():
        problems.append(f"Base GGUF 不存在：{base_path}")
    if not adapter_path.is_file():
        problems.append(f"Adapter GGUF 不存在：{adapter_path}")
    if problems:
        return _fail("；".join(problems))

    actual_base_sha = _sha256_file(base_path)
    actual_adapter_sha = _sha256_file(adapter_path)
    if actual_base_sha != base_info["sha256"]:
        return _fail(
            f"Base GGUF SHA-256 不符：实际 {actual_base_sha}，manifest {base_info['sha256']}"
        )
    if actual_adapter_sha != adapter_info["sha256"]:
        return _fail(
            f"Adapter GGUF SHA-256 不符：实际 {actual_adapter_sha}，manifest {adapter_info['sha256']}"
        )

    adapter_source = manifest.get("adapter_source", {})

    return LlamaCppBackendState(
        True, None,
        base_gguf_sha256=actual_base_sha,
        adapter_gguf_sha256=actual_adapter_sha,
        adapter_gguf_basename=adapter_path.name,
        adapter_scale=float(manifest_scale),
        base_revision=actual_revision,
        best_checkpoint=adapter_source.get("best_checkpoint"),
        best_eval_loss=adapter_source.get("best_eval_loss"),
        base_gguf_path=str(base_path),
        adapter_gguf_path=str(adapter_path),
    )


# ---------------------------------------------------------------------------
# 运行时 upstream 身份校验：证明 8002 上跑的确实是"健康 + 挂了正确 Adapter"的实例，
# 不是随便一个健康但没挂 Adapter（或挂错 Adapter）的 llama-server。
# ---------------------------------------------------------------------------
async def check_upstream_identity(
    base_url: str,
    timeout_s: float,
    expected_adapter_basename: str,
    expected_scale: float,
) -> IdentityResult:
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            health_resp = await client.get(f"{base_url}/health")
            if health_resp.status_code != 200:
                return IdentityResult(False, f"/health 返回 HTTP {health_resp.status_code}")

            lora_resp = await client.get(f"{base_url}/lora-adapters")
            if lora_resp.status_code != 200:
                return IdentityResult(False, f"/lora-adapters 返回 HTTP {lora_resp.status_code}", upstream_up=True)
            lora_list = lora_resp.json()
            if not isinstance(lora_list, list) or not lora_list:
                return IdentityResult(False, "/lora-adapters 返回空列表，没有挂载任何 Adapter", upstream_up=True)

            matched_adapter = None
            for entry in lora_list:
                path = entry.get("path", "")
                if Path(path).name == expected_adapter_basename:
                    matched_adapter = entry
                    break
            if matched_adapter is None:
                found = [Path(e.get("path", "")).name for e in lora_list]
                return IdentityResult(
                    False,
                    f"/lora-adapters 未包含期望的 Adapter（期望 basename={expected_adapter_basename}，"
                    f"实际挂载 {found}）",
                    upstream_up=True,
                )
            actual_scale = matched_adapter.get("scale")
            if actual_scale is None or float(actual_scale) != float(expected_scale):
                return IdentityResult(
                    False,
                    f"Adapter scale 不符：实际 {actual_scale}，期望 {expected_scale}",
                    upstream_up=True,
                )

            props_resp = await client.get(f"{base_url}/props")
            if props_resp.status_code != 200:
                return IdentityResult(False, f"/props 返回 HTTP {props_resp.status_code}", upstream_up=True)
            props = props_resp.json()
            # 字段名以本机实测的真实响应为准：
            # default_generation_settings.params.reasoning_format
            reasoning_format = (
                props.get("default_generation_settings", {})
                .get("params", {})
                .get("reasoning_format")
            )
            if reasoning_format is not None and reasoning_format != "none":
                return IdentityResult(
                    False, f"/props 显示 reasoning_format={reasoning_format}，期望 none（--reasoning off）",
                    upstream_up=True,
                )

            return IdentityResult(
                True,
                f"health OK；adapter={expected_adapter_basename} scale={actual_scale}；"
                f"reasoning_format={reasoning_format}",
                upstream_up=True,
            )
    except Exception as exc:  # noqa: BLE001
        return IdentityResult(False, f"upstream 不可达：{type(exc).__name__}: {exc}")


async def check_upstream_health(base_url: str, timeout_s: float) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(f"{base_url}/health")
            return resp.status_code == 200
    except Exception:
        return False


async def forward_chat_completion(
    base_url: str, payload: dict[str, Any], timeout_s: float
) -> httpx.Response:
    """非流式转发：一次性请求 + 一次性响应，不做任何内容改写。"""
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        return await client.post(f"{base_url}/v1/chat/completions", json=payload)


@dataclass
class StreamHandle:
    """可关闭的流式句柄：先验证上游响应状态，成功才把它交给调用方消费；
    调用方（或客户端断开时）必须调用 aclose() 释放底层连接，不泄漏。"""

    status_code: int
    _client: httpx.AsyncClient
    _response: httpx.Response
    _error_body: bytes | None = field(default=None)

    async def aiter_raw(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._response.aiter_raw():
                if chunk:
                    yield chunk
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        await self._response.aclose()
        await self._client.aclose()


async def open_stream_chat_completion(
    base_url: str, payload: dict[str, Any], timeout_s: float
) -> StreamHandle:
    """建立并验证上游流式响应的状态码，**在返回给路由层之前**就能判断是否 502——
    不会先给客户端返回 200 再在流里才报错。

    调用方拿到 StreamHandle 后：
    - status_code == 200 时可以安全消费 aiter_raw()；
    - 非 200 时必须读取 `_error_body` 并调用 aclose()，返回 502，不建立 SSE 响应。
    """
    client = httpx.AsyncClient(timeout=timeout_s)
    request = client.build_request("POST", f"{base_url}/v1/chat/completions", json=payload)
    response = await client.send(request, stream=True)
    if response.status_code != 200:
        body = await response.aread()
        await response.aclose()
        await client.aclose()
        return StreamHandle(response.status_code, client, response, _error_body=body)
    return StreamHandle(response.status_code, client, response)
