import pytest
from pydantic import ValidationError

import app as app_module


def test_chat_message_role_allowed():
    m = app_module.ChatMessage(role="user", content="hi")
    assert m.role == "user"


def test_chat_message_role_rejected():
    with pytest.raises(ValidationError):
        app_module.ChatMessage(role="hacker", content="hi")


def test_chat_completion_request_requires_messages():
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[])


def test_chat_completion_request_temperature_bounds():
    app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], temperature=0.0)
    app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], temperature=2.0)
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], temperature=2.1)
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], temperature=-0.1)


def test_chat_completion_request_top_p_bounds():
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], top_p=0.0)
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], top_p=1.1)


def test_chat_completion_request_max_tokens_positive():
    with pytest.raises(ValidationError):
        app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}], max_tokens=0)


def test_chat_completion_request_defaults_are_deterministic():
    req = app_module.ChatCompletionRequest(messages=[{"role": "user", "content": "hi"}])
    assert req.temperature == 0.0
    assert req.top_p == 1.0
    assert req.stream is False


def test_simple_chat_request_message_required():
    with pytest.raises(ValidationError):
        app_module.SimpleChatRequest(message="")


def test_parse_tool_calls_no_tags():
    content, calls = app_module.parse_tool_calls("普通回答，没有工具调用")
    assert calls is None
    assert content == "普通回答，没有工具调用"


def test_parse_tool_calls_valid():
    raw = '前置文本<tool_call>{"name": "queryOrderTool", "arguments": {"orderId": "ORD1001"}}</tool_call>'
    content, calls = app_module.parse_tool_calls(raw)
    assert content == "前置文本"
    assert calls is not None
    assert calls[0]["function"]["name"] == "queryOrderTool"
    assert "ORD1001" in calls[0]["function"]["arguments"]


def test_parse_tool_calls_malformed_json_ignored():
    raw = "<tool_call>{not valid json}</tool_call>"
    content, calls = app_module.parse_tool_calls(raw)
    assert calls is None
    assert "<tool_call>" in content  # 未被当成合法调用清理掉
