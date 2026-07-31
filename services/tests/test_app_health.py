from pathlib import Path

from fastapi.testclient import TestClient

import app as app_module
from config import Settings


def _test_settings(**overrides) -> Settings:
    base = dict(
        llm_backend="pytorch_peft",
        base_model_path=Path("/tmp/does-not-exist-base"),
        adapter_path=Path("/tmp/does-not-exist-adapter"),
        expected_base_revision="b968826d9c46dd6066d109eabc6255188de91218",
        skip_model_load=True,
        environment="test",
    )
    base.update(overrides)
    return Settings(**base)


def test_health_not_loaded_state():
    settings = _test_settings()
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "not_loaded"
        assert body["loaded"] is False
        assert body["load_error"] == "测试模式：未加载"


def test_health_reports_expected_static_fields():
    settings = _test_settings()
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        body = client.get("/health").json()
        assert body["base_revision_expected"] == "b968826d9c46dd6066d109eabc6255188de91218"
        assert "mps_available" in body
        assert "cuda_available" in body
        assert body["streaming_mode"] == "true_token_stream_via_text_iterator_streamer"
        assert body["enable_thinking"] is False


def test_health_reflects_loaded_state_when_manually_populated():
    """不加载真实模型，手动填充状态字段验证 /health 在'已加载'时的输出结构。"""
    settings = _test_settings()
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        state = app.state.cs_state
        state.loaded = True
        state.load_error = None
        state.device = "mps"
        state.dtype_name = "bfloat16"
        state.dtype_reason = "探测通过"
        state.best_checkpoint = "checkpoint-160"
        state.best_eval_loss = 1.8314380645751953
        state.peak_rss_bytes = 17_000_000_000

        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["loaded"] is True
        assert body["device"] == "mps"
        assert body["dtype"] == "bfloat16"
        assert body["best_checkpoint"] == "checkpoint-160"
        assert body["best_eval_loss"] == 1.8314380645751953
        assert body["peak_rss_gb"] == round(17_000_000_000 / (1024**3), 3)


def test_models_endpoint():
    settings = _test_settings(model_name="unit-test-model")
    app = app_module.create_app(settings)
    with TestClient(app) as client:
        body = client.get("/v1/models").json()
        assert body["data"][0]["id"] == "unit-test-model"
