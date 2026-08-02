"""流式 SSE 协议测试：桩替换 generate_stream_sync 本身，只验证桥接/协议层，
不依赖真实 TextIteratorStreamer 与模型（那部分由真实 5 问推理验证）。"""

from pathlib import Path

from fastapi.testclient import TestClient

import app as app_module
from config import Settings


def _client_loaded(monkeypatch, pieces=None, raise_error=None):
    settings = Settings(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/x"), adapter_path=Path("/tmp/y"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=True, environment="test",
    )
    app = app_module.create_app(settings)
    client = TestClient(app)
    client.__enter__()
    state = app.state.cs_state
    state.loaded = True
    state.tokenizer = object()
    state.model = object()

    def fake_stream(tokenizer, model, prompt, temperature, top_p, max_tokens):
        if raise_error is not None:
            raise raise_error
        yield from (pieces or ["你", "好", "，", "请", "稍", "等"])

    monkeypatch.setattr(app_module, "generate_stream_sync", fake_stream)
    monkeypatch.setattr(
        app_module, "count_prompt_tokens", lambda tokenizer, prompt: 10
    )
    monkeypatch.setattr(app_module, "build_prompt", lambda tokenizer, messages, enable_thinking: "PROMPT")
    return client


def _parse_sse(text: str) -> list[dict]:
    events = []
    for line in text.splitlines():
        if line.startswith("data: ") and line != "data: [DONE]":
            import json

            events.append(json.loads(line[len("data: "):]))
    return events


def test_streaming_emits_role_then_content_then_stop(monkeypatch):
    client = _client_loaded(monkeypatch, pieces=["你", "好"])
    resp = client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True, "max_tokens": 8},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(resp.text)

    assert events[0]["choices"][0]["delta"] == {"role": "assistant"}
    content_events = [e for e in events if e["choices"][0]["delta"].get("content")]
    assert [e["choices"][0]["delta"]["content"] for e in content_events] == ["你", "好"]
    assert events[-1]["choices"][0]["finish_reason"] == "stop"
    assert events[-1]["usage"]["completion_tokens"] == 2
    assert "[DONE]" in resp.text


def test_streaming_error_mid_generation_reported_not_swallowed(monkeypatch):
    client = _client_loaded(monkeypatch, raise_error=RuntimeError("模拟 MPS 生成失败"))
    resp = client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True, "max_tokens": 8},
    )
    assert resp.status_code == 200  # SSE 连接本身已建立
    events = _parse_sse(resp.text)
    error_events = [e for e in events if e["choices"][0]["finish_reason"] == "error"]
    assert error_events, "生成异常必须体现在 SSE 事件里，不能被静默吞掉"
    assert "模拟 MPS 生成失败" in error_events[0]["error"]["message"]
