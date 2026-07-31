"""FastAPI 转发 tools/tool_choice 给 llama-server（llama_cpp backend）的测试。

背景：llama-server 对当前这个模型能原生返回结构化 message.tool_calls
（给定 tools 后 finish_reason=tool_calls，已用真实请求核实，见
mastra-agent/README-AGENT.md）。FastAPI 原来会静默丢弃请求里的 tools/
tool_choice 字段，这是已确认的协议缺口——本文件测试修复后的转发行为：
- tools/tool_choice 原样转发给上游（非流式、流式都要）；
- 白名单只允许 queryOrderTool、searchKnowledgeBase，其余一律 400；
- 上游返回的结构化 tool_calls 原样透传给客户端，不做任何改写。

全部使用假 forward_chat_completion/open_stream_chat_completion，不启动
真实 llama-server。
"""

import hashlib
import json

import pytest
from fastapi.testclient import TestClient

import app as app_module
import llama_cpp_backend
from config import Settings

REV = "b968826d9c46dd6066d109eabc6255188de91218"
ADAPTER_BASENAME = "adapter.gguf"

QUERY_ORDER_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "queryOrderTool",
        "description": "查询订单实时状态",
        "parameters": {"type": "object", "properties": {"orderId": {"type": "string"}}, "required": ["orderId"]},
    },
}
SEARCH_KB_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "searchKnowledgeBase",
        "description": "检索维修排查步骤",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
}
UNKNOWN_TOOL_SCHEMA = {
    "type": "function",
    "function": {"name": "deleteAllOrders", "description": "危险的未白名单工具", "parameters": {"type": "object"}},
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_manifest(gguf_dir):
    gguf_dir.mkdir(parents=True, exist_ok=True)
    base_bytes = b"FAKE-BASE"
    adapter_bytes = b"FAKE-ADAPTER"
    (gguf_dir / "base.gguf").write_bytes(base_bytes)
    (gguf_dir / ADAPTER_BASENAME).write_bytes(adapter_bytes)
    manifest = {
        "base_model": {"revision": REV},
        "adapter_source": {"best_checkpoint": "checkpoint-160", "best_eval_loss": 1.8314380645751953},
        "gguf": {
            "base_q4_k_m": {"file": "base.gguf", "sha256": _sha256(base_bytes)},
            "adapter_lora": {"file": ADAPTER_BASENAME, "sha256": _sha256(adapter_bytes), "adapter_scale": 1.0},
        },
    }
    manifest_path = gguf_dir / "gguf-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest_path


def _llama_cpp_settings(tmp_path, **overrides) -> Settings:
    manifest_path = _write_manifest(tmp_path / "gguf")
    base = dict(
        llm_backend="llama_cpp", gguf_dir=tmp_path / "gguf", gguf_manifest_path=manifest_path,
        expected_base_revision=REV, skip_model_load=False, environment="production",
    )
    base.update(overrides)
    return Settings(**base)


def _stub_identity_ok(monkeypatch):
    async def fake_identity(base_url, timeout_s, expected_adapter_basename, expected_scale):
        return llama_cpp_backend.IdentityResult(True, "stub ok", upstream_up=True)

    monkeypatch.setattr(llama_cpp_backend, "check_upstream_identity", fake_identity)


# ---------------------------------------------------------------------------
# build_upstream_payload：纯函数级别
# ---------------------------------------------------------------------------
def test_build_upstream_payload_includes_tools_and_tool_choice_when_present():
    msgs = [app_module.ChatMessage(role="user", content="hi")]
    payload = app_module.build_upstream_payload(
        "m", msgs, 0.0, 1.0, 16, False,
        tools=[QUERY_ORDER_TOOL_SCHEMA], tool_choice="required",
    )
    assert payload["tools"] == [QUERY_ORDER_TOOL_SCHEMA]
    assert payload["tool_choice"] == "required"


def test_build_upstream_payload_omits_tools_when_absent():
    msgs = [app_module.ChatMessage(role="user", content="hi")]
    payload = app_module.build_upstream_payload("m", msgs, 0.0, 1.0, 16, False)
    assert "tools" not in payload
    assert "tool_choice" not in payload


# ---------------------------------------------------------------------------
# 白名单校验
# ---------------------------------------------------------------------------
def test_validate_tools_whitelist_allows_known_tools():
    app_module.validate_tools_whitelist([QUERY_ORDER_TOOL_SCHEMA, SEARCH_KB_TOOL_SCHEMA], None)  # 不应抛出


def test_validate_tools_whitelist_rejects_unknown_tool():
    with pytest.raises(Exception):
        app_module.validate_tools_whitelist([UNKNOWN_TOOL_SCHEMA], None)


def test_validate_tools_whitelist_rejects_unknown_tool_choice():
    with pytest.raises(Exception):
        app_module.validate_tools_whitelist(
            [QUERY_ORDER_TOOL_SCHEMA],
            {"type": "function", "function": {"name": "deleteAllOrders"}},
        )


def test_unknown_tool_returns_400_via_http(tmp_path, monkeypatch):
    settings = _llama_cpp_settings(tmp_path)
    app = app_module.create_app(settings)
    _stub_identity_ok(monkeypatch)

    with TestClient(app) as client:
        resp = client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hi"}], "tools": [UNKNOWN_TOOL_SCHEMA]},
        )
        assert resp.status_code == 400
        assert "deleteAllOrders" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# 端到端（假上游）：非流式转发 tools/tool_choice，且结构化 tool_calls 原样透传
# ---------------------------------------------------------------------------
def test_tools_forwarded_non_streaming_and_tool_calls_passed_through(tmp_path, monkeypatch):
    settings = _llama_cpp_settings(tmp_path)
    app = app_module.create_app(settings)
    _stub_identity_ok(monkeypatch)

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {
                "id": "chatcmpl-x", "object": "chat.completion", "model": settings.model_name,
                "choices": [{
                    "index": 0, "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant", "content": "",
                        "tool_calls": [{
                            "id": "call_abc123", "type": "function",
                            "function": {"name": "queryOrderTool", "arguments": '{"orderId": "ORD1001"}'},
                        }],
                    },
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }

    async def fake_forward(base_url, payload, timeout_s):
        captured["payload"] = payload
        return _FakeResponse()

    monkeypatch.setattr(llama_cpp_backend, "forward_chat_completion", fake_forward)

    with TestClient(app) as client:
        resp = client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "帮我查一下 ORD1001 的状态"}],
                "tools": [QUERY_ORDER_TOOL_SCHEMA],
                "tool_choice": "auto",
            },
        )
        assert resp.status_code == 200

    # 转发给上游的 payload 里必须原样带上 tools/tool_choice
    assert captured["payload"]["tools"] == [QUERY_ORDER_TOOL_SCHEMA]
    assert captured["payload"]["tool_choice"] == "auto"

    # 客户端收到的响应里，结构化 tool_calls 原样透传，不被改写/丢弃
    body = resp.json()
    tool_calls = body["choices"][0]["message"]["tool_calls"]
    assert tool_calls[0]["function"]["name"] == "queryOrderTool"
    assert json.loads(tool_calls[0]["function"]["arguments"]) == {"orderId": "ORD1001"}
    assert tool_calls[0]["id"] == "call_abc123"
    assert body["choices"][0]["finish_reason"] == "tool_calls"


def test_no_tools_in_request_means_no_tools_forwarded(tmp_path, monkeypatch):
    settings = _llama_cpp_settings(tmp_path)
    app = app_module.create_app(settings)
    _stub_identity_ok(monkeypatch)

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }

    async def fake_forward(base_url, payload, timeout_s):
        captured["payload"] = payload
        return _FakeResponse()

    monkeypatch.setattr(llama_cpp_backend, "forward_chat_completion", fake_forward)

    with TestClient(app) as client:
        resp = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "你好"}]})
        assert resp.status_code == 200

    assert "tools" not in captured["payload"]
    assert "tool_choice" not in captured["payload"]


# ---------------------------------------------------------------------------
# 流式：tools 转发 + tool_calls delta 原样透传
# ---------------------------------------------------------------------------
def _fake_stream_handle(chunks, status_code=200):
    class _Handle:
        def __init__(self):
            self.status_code = status_code
            self._error_body = None

        async def aiter_raw(self):
            for c in chunks:
                yield c

        async def aclose(self):
            pass

    return _Handle()


def test_tools_forwarded_streaming_and_tool_call_deltas_passed_through(tmp_path, monkeypatch):
    settings = _llama_cpp_settings(tmp_path)
    app = app_module.create_app(settings)
    _stub_identity_ok(monkeypatch)

    delta_chunks = [
        b'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n',
        b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function",'
        b'"function":{"name":"searchKnowledgeBase","arguments":"{"}}]}}]}\n\n',
        b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"query\\": \\"x\\"}"}}]}}]}\n\n',
        b'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
        b'data: [DONE]\n\n',
    ]
    handle = _fake_stream_handle(delta_chunks)
    captured = {}

    async def fake_open_stream(base_url, payload, timeout_s):
        captured["payload"] = payload
        return handle

    monkeypatch.setattr(llama_cpp_backend, "open_stream_chat_completion", fake_open_stream)

    with TestClient(app) as client:
        resp = client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "冰箱不制冷应该先检查什么"}],
                "tools": [SEARCH_KB_TOOL_SCHEMA],
                "stream": True,
            },
        )
        assert resp.status_code == 200
        # 透明转发：响应体必须是原始 chunk 拼接后的结果，逐字节相同，
        # tool_calls 的增量 delta 不被解析/改写。
        assert resp.content == b"".join(delta_chunks)

    assert captured["payload"]["tools"] == [SEARCH_KB_TOOL_SCHEMA]
