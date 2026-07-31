"""llama_cpp backend 的纯逻辑测试：不启动真实 llama-server、不加载真实 GGUF。"""

import hashlib
import json

import pytest

import llama_cpp_backend as backend

REV = "b968826d9c46dd6066d109eabc6255188de91218"
WRONG_REV = "0" * 40


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_manifest(
    gguf_dir, *, with_adapter=True, tamper_base=False, tamper_adapter=False,
    revision=REV, adapter_scale=1.0, missing_scale_field=False,
):
    gguf_dir.mkdir(parents=True, exist_ok=True)
    base_bytes = b"FAKE-BASE-GGUF-CONTENT"
    adapter_bytes = b"FAKE-ADAPTER-GGUF-CONTENT"
    (gguf_dir / "base.gguf").write_bytes(base_bytes)
    if with_adapter:
        (gguf_dir / "adapter.gguf").write_bytes(adapter_bytes)

    base_sha = _sha256(base_bytes)
    if tamper_base:
        base_sha = "0" * 64
    adapter_sha = _sha256(adapter_bytes)
    if tamper_adapter:
        adapter_sha = "0" * 64

    manifest = {
        "base_model": {"revision": revision},
        "adapter_source": {"best_checkpoint": "checkpoint-160", "best_eval_loss": 1.8314380645751953},
        "gguf": {
            "base_q4_k_m": {"file": "base.gguf", "sha256": base_sha},
        },
    }
    if with_adapter:
        adapter_entry = {"file": "adapter.gguf", "sha256": adapter_sha}
        if not missing_scale_field:
            adapter_entry["adapter_scale"] = adapter_scale
        manifest["gguf"]["adapter_lora"] = adapter_entry
    manifest_path = gguf_dir / "gguf-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest_path


# ---------------------------------------------------------------------------
# load_llama_cpp_backend
# ---------------------------------------------------------------------------
def test_manifest_missing(tmp_path):
    result = backend.load_llama_cpp_backend(tmp_path, tmp_path / "nope.json", REV, 1.0)
    assert result.fastapi_loaded is False
    assert "不存在" in result.load_error


def test_manifest_unparseable(tmp_path):
    manifest_path = tmp_path / "gguf-manifest.json"
    manifest_path.write_text("{not valid json", encoding="utf-8")
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "不可解析" in result.load_error


def test_manifest_without_adapter_rejected_base_only(tmp_path):
    """核心要求：Base-only 不允许启动并冒充 production。"""
    manifest_path = _write_manifest(tmp_path, with_adapter=False)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "adapter_lora" in result.load_error or "Adapter" in result.load_error


def test_revision_mismatch_rejected(tmp_path):
    manifest_path = _write_manifest(tmp_path, revision=WRONG_REV)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "revision" in result.load_error


def test_adapter_scale_mismatch_rejected(tmp_path):
    manifest_path = _write_manifest(tmp_path, adapter_scale=0.5)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "adapter_scale" in result.load_error


def test_adapter_scale_missing_field_rejected(tmp_path):
    manifest_path = _write_manifest(tmp_path, missing_scale_field=True)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "adapter_scale" in result.load_error


def test_base_gguf_missing_file(tmp_path):
    manifest_path = _write_manifest(tmp_path)
    (tmp_path / "base.gguf").unlink()
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "Base GGUF 不存在" in result.load_error


def test_adapter_gguf_missing_file(tmp_path):
    manifest_path = _write_manifest(tmp_path)
    (tmp_path / "adapter.gguf").unlink()
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "Adapter GGUF 不存在" in result.load_error


def test_base_sha_mismatch_rejected(tmp_path):
    manifest_path = _write_manifest(tmp_path, tamper_base=True)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "Base GGUF SHA-256 不符" in result.load_error


def test_adapter_sha_mismatch_rejected(tmp_path):
    manifest_path = _write_manifest(tmp_path, tamper_adapter=True)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is False
    assert "Adapter GGUF SHA-256 不符" in result.load_error


def test_valid_manifest_loads_successfully(tmp_path):
    manifest_path = _write_manifest(tmp_path)
    result = backend.load_llama_cpp_backend(tmp_path, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is True
    assert result.load_error is None
    assert result.base_revision == REV
    assert result.best_checkpoint == "checkpoint-160"
    assert result.best_eval_loss == 1.8314380645751953
    assert result.adapter_scale == 1.0
    assert result.adapter_gguf_basename == "adapter.gguf"
    assert len(result.base_gguf_sha256) == 64
    assert len(result.adapter_gguf_sha256) == 64


def test_real_gguf_manifest_on_disk():
    """针对本次真正生成、受控可提交的 manifest 做一次真实校验（不使用桩数据）。"""
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]
    manifest_path = repo_root / "services" / "manifests" / "customer-service-production-v1.gguf.json"
    gguf_dir = repo_root / "models" / "gguf" / "qwen3-8b-production-v1"
    if not manifest_path.is_file():
        pytest.skip("受控 manifest 不存在，跳过真实路径校验")
    if not gguf_dir.is_dir():
        pytest.skip("正式 GGUF 尚未转换到本机，跳过真实路径校验")
    result = backend.load_llama_cpp_backend(gguf_dir, manifest_path, REV, 1.0)
    assert result.fastapi_loaded is True, result.load_error
    assert result.base_revision == REV
    assert result.best_checkpoint and "checkpoint-160" in result.best_checkpoint


# ---------------------------------------------------------------------------
# check_upstream_health / check_upstream_identity
# ---------------------------------------------------------------------------
@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_upstream_health_unreachable_returns_false():
    # 端口 1 基本不可能有服务监听，用于制造必然失败的连接
    ok = await backend.check_upstream_health("http://127.0.0.1:1", 1.0)
    assert ok is False


@pytest.mark.anyio
async def test_upstream_identity_unreachable():
    result = await backend.check_upstream_identity("http://127.0.0.1:1", 1.0, "adapter.gguf", 1.0)
    assert result.matched is False
    assert result.upstream_up is False


# ---------------------------------------------------------------------------
# check_upstream_identity：起一个假 HTTP 服务模拟 llama-server 的
# /health /lora-adapters /props，覆盖匹配/不匹配/scale错误/reasoning未关闭分支。
# ---------------------------------------------------------------------------
def _fake_llama_server(lora_list, props_reasoning="none", health_ok=True):
    import json as _json
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # 静音
            pass

        def do_GET(self):
            if self.path == "/health":
                self.send_response(200 if health_ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")
            elif self.path == "/lora-adapters":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(_json.dumps(lora_list).encode("utf-8"))
            elif self.path == "/props":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                body = {"default_generation_settings": {"params": {"reasoning_format": props_reasoning}}}
                self.wfile.write(_json.dumps(body).encode("utf-8"))
            else:
                self.send_response(404)
                self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    import threading
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


@pytest.mark.anyio
async def test_identity_matches_correct_adapter():
    server, url = _fake_llama_server([{"path": "/x/adapter.gguf", "scale": 1.0}])
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is True
        assert result.upstream_up is True
    finally:
        server.shutdown()


@pytest.mark.anyio
async def test_identity_rejects_empty_lora_list():
    server, url = _fake_llama_server([])
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is False
        assert "没有挂载" in result.detail
    finally:
        server.shutdown()


@pytest.mark.anyio
async def test_identity_rejects_wrong_adapter_basename():
    server, url = _fake_llama_server([{"path": "/x/other-adapter.gguf", "scale": 1.0}])
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is False
        assert "未包含期望的 Adapter" in result.detail
    finally:
        server.shutdown()


@pytest.mark.anyio
async def test_identity_rejects_wrong_scale():
    server, url = _fake_llama_server([{"path": "/x/adapter.gguf", "scale": 0.5}])
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is False
        assert "scale 不符" in result.detail
    finally:
        server.shutdown()


@pytest.mark.anyio
async def test_identity_rejects_reasoning_not_off():
    server, url = _fake_llama_server([{"path": "/x/adapter.gguf", "scale": 1.0}], props_reasoning="auto")
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is False
        assert "reasoning_format" in result.detail
    finally:
        server.shutdown()


@pytest.mark.anyio
async def test_identity_health_down_reported():
    server, url = _fake_llama_server([{"path": "/x/adapter.gguf", "scale": 1.0}], health_ok=False)
    try:
        result = await backend.check_upstream_identity(url, 3.0, "adapter.gguf", 1.0)
        assert result.matched is False
    finally:
        server.shutdown()
