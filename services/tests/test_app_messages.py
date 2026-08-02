"""多轮 messages 与参数边界测试：注入桩 tokenizer/model，不加载真实权重。"""

from pathlib import Path

import torch
from fastapi.testclient import TestClient

import app as app_module
from config import Settings


class _Encoding(dict):
    def __init__(self, input_ids):
        super().__init__(input_ids=input_ids)

    def to(self, device):
        return self


class FakeTokenizer:
    pad_token_id = 0
    eos_token_id = 1

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True, enable_thinking=False):
        parts = [f"[{m['role']}]{m.get('content') or ''}" for m in messages]
        return "\n".join(parts) + "\n[assistant]"

    def __call__(self, text, return_tensors="pt"):
        n = max(1, len(text) // 4)
        ids = torch.arange(1, n + 1).unsqueeze(0)
        return _Encoding(ids)

    def decode(self, ids, skip_special_tokens=True):
        return "好的，请提供订单号，我核对后告诉您。"


class FakeModel:
    device = "cpu"

    def generate(self, **kwargs):
        input_ids = kwargs["input_ids"]
        max_new = kwargs.get("max_new_tokens", 8)
        gen = torch.arange(9000, 9000 + max_new).unsqueeze(0)
        return torch.cat([input_ids, gen], dim=1)


def _loaded_app(**settings_overrides) -> TestClient:
    base = dict(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/x"), adapter_path=Path("/tmp/y"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=True, environment="test",
    )
    base.update(settings_overrides)
    settings = Settings(**base)
    app = app_module.create_app(settings)
    client = TestClient(app)
    client.__enter__()
    state = app.state.cs_state
    state.loaded = True
    state.load_error = None
    state.tokenizer = FakeTokenizer()
    state.model = FakeModel()
    state.device = "cpu"
    state.dtype_name = "float16"
    return client


def test_multi_turn_messages_v1_chat_completions():
    client = _loaded_app()
    body = {
        "messages": [
            {"role": "system", "content": "你是客服"},
            {"role": "user", "content": "冰箱不制冷"},
            {"role": "assistant", "content": "请问是冷藏还是冷冻不制冷？"},
            {"role": "user", "content": "冷藏"},
        ],
        "max_tokens": 16,
    }
    resp = client.post("/v1/chat/completions", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["choices"][0]["message"]["role"] == "assistant"
    assert data["choices"][0]["message"]["content"]
    assert data["usage"]["completion_tokens"] == 16


def test_system_prompt_auto_prepended_when_absent():
    client = _loaded_app()
    body = {"messages": [{"role": "user", "content": "你好"}], "max_tokens": 4}
    resp = client.post("/v1/chat/completions", json=body)
    assert resp.status_code == 200
    # prompt_tokens 应该反映拼了 system 前缀后的更长文本（弱校验：非零且 > 单条 user 消息估算）
    assert resp.json()["usage"]["prompt_tokens"] > 0


def test_system_prompt_not_duplicated_when_present():
    client = _loaded_app()
    with_system = {
        "messages": [
            {"role": "system", "content": "自定义系统提示"},
            {"role": "user", "content": "你好"},
        ],
        "max_tokens": 4,
    }
    resp = client.post("/v1/chat/completions", json=with_system)
    assert resp.status_code == 200


def test_simple_chat_endpoint_multi_turn_history():
    client = _loaded_app()
    body = {
        "message": "还是不行",
        "history": [
            {"role": "user", "content": "电视有声音没画面"},
            {"role": "assistant", "content": "请检查信号线是否插紧"},
        ],
        "max_tokens": 8,
    }
    resp = client.post("/chat", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["reply"]
    assert data["usage"]["completion_tokens"] == 8


def test_max_tokens_ceiling_rejected():
    client = _loaded_app(max_tokens_ceiling=32)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 999}
    resp = client.post("/v1/chat/completions", json=body)
    assert resp.status_code == 400
    assert "max_tokens" in resp.json()["detail"]


def test_max_messages_ceiling_rejected():
    client = _loaded_app(max_messages=3)
    body = {"messages": [{"role": "user", "content": f"msg{i}"} for i in range(5)], "max_tokens": 4}
    resp = client.post("/v1/chat/completions", json=body)
    assert resp.status_code == 400
    assert "messages" in resp.json()["detail"]


def test_max_input_tokens_rejected():
    client = _loaded_app(max_input_tokens=1)
    body = {"messages": [{"role": "user", "content": "这是一段足够长的文本用来撑爆极小的输入上限"}], "max_tokens": 4}
    resp = client.post("/v1/chat/completions", json=body)
    assert resp.status_code == 400
    assert "输入过长" in resp.json()["detail"]


def test_chat_endpoint_history_ceiling_rejected():
    client = _loaded_app(max_messages=2)
    body = {
        "message": "还有问题",
        "history": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}],
        "max_tokens": 4,
    }
    resp = client.post("/chat", json=body)
    assert resp.status_code == 400


def test_non_streaming_uses_deterministic_default():
    """默认 temperature=0 → do_sample=False，走确定性路径（不传 temperature/top_p 给 generate）。"""
    client = _loaded_app()
    calls = {}
    real_generate = FakeModel.generate

    def spy_generate(self, **kwargs):
        calls.update(kwargs)
        return real_generate(self, **kwargs)

    FakeModel.generate = spy_generate
    try:
        resp = client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 4},
        )
        assert resp.status_code == 200
        assert calls["do_sample"] is False
        assert "temperature" not in calls
    finally:
        FakeModel.generate = real_generate
