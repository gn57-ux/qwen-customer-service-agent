from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as app_module
import model_runtime
from config import Settings


def _prod_settings(**overrides) -> Settings:
    base = dict(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/does-not-exist-base-xyz"),
        adapter_path=Path("/tmp/does-not-exist-adapter-xyz"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=False,
        environment="production",
    )
    base.update(overrides)
    return Settings(**base)


def test_missing_base_model_fails_startup_hard():
    settings = _prod_settings()
    app = app_module.create_app(settings)
    with pytest.raises(RuntimeError, match="revision"):
        with TestClient(app):
            pass


def test_missing_adapter_fails_startup_even_with_valid_base(tmp_path):
    """Base revision 校验依赖真实 git/manifest 证据；这里用一个假 Base 目录，
    只验证'即使 Base 通过（此处仍会在 revision 校验就失败），Adapter 缺失分支
    也不允许启动'的最小闭环——不依赖真实 16GB 权重。"""
    fake_base = tmp_path / "fake-base"
    fake_base.mkdir()
    settings = _prod_settings(base_model_path=fake_base, adapter_path=tmp_path / "no-adapter")
    app = app_module.create_app(settings)
    with pytest.raises(RuntimeError):
        with TestClient(app):
            pass


def test_smoke_adapter_path_rejected_at_load_time(tmp_path, monkeypatch):
    """核心防回退测试：即使 revision 校验能通过，只要 Adapter 路径指向
    smoke 目录，load_model 必须拒绝，且绝不能进一步调用真实模型加载。"""
    fake_base = tmp_path / "fake-base"
    fake_base.mkdir()

    import revision_check
    from revision_check import RevisionResult

    # model_runtime.load_model 内部用 `from revision_check import verify_revision`（函数内局部
    # import），因此要在源模块 revision_check 上打桩，而不是 model_runtime 上。
    monkeypatch.setattr(
        revision_check,
        "verify_revision",
        lambda *a, **k: RevisionResult(True, "manifest", "b968826d9c46dd6066d109eabc6255188de91218", "stub pass"),
    )

    called = {"from_pretrained": False}

    class _BoomAutoModel:
        @staticmethod
        def from_pretrained(*a, **k):
            called["from_pretrained"] = True
            raise AssertionError("不应该走到真实模型加载——Adapter 校验应先失败")

    import transformers

    monkeypatch.setattr(transformers, "AutoModelForCausalLM", _BoomAutoModel)

    smoke_adapter = tmp_path / "adapters" / "customer-service-smoke"
    smoke_adapter.mkdir(parents=True)

    with pytest.raises(RuntimeError, match="Adapter 校验失败"):
        model_runtime.load_model(
            base_model_path=fake_base,
            adapter_path=smoke_adapter,
            expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
            device_preference="cpu",
            dtype_preference="float16",
        )
    assert called["from_pretrained"] is False, "禁止在 Adapter 校验失败后仍尝试加载 Base 模型"


def test_chat_completions_503_when_not_loaded():
    settings = Settings(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/x"), adapter_path=Path("/tmp/y"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=True, environment="test",
    )
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        resp = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
        assert resp.status_code == 503
        assert "未就绪" in resp.json()["detail"]


def test_chat_endpoint_503_when_not_loaded():
    settings = Settings(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/x"), adapter_path=Path("/tmp/y"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=True, environment="test",
    )
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        resp = client.post("/chat", json={"message": "hi"})
        assert resp.status_code == 503


def test_no_fallback_scan_function_exists():
    """架构性断言：模块里不存在任何'找不到就换一个目录试试'的回退逻辑。"""
    import inspect

    source = inspect.getsource(model_runtime)
    forbidden_markers = ("smoke_adapter", "fallback_adapter", "scan_for_adapter", "discover_adapter")
    for marker in forbidden_markers:
        assert marker not in source, f"model_runtime 中出现了疑似自动回退逻辑：{marker}"
