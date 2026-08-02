import importlib
import os

import config as config_module


def test_defaults(monkeypatch):
    for k in list(os.environ):
        if k.startswith(("BASE_MODEL_PATH", "ADAPTER_PATH", "DEVICE", "DTYPE", "CS_SKIP_MODEL_LOAD", "APP_ENV")):
            monkeypatch.delenv(k, raising=False)
    s = config_module.get_settings()
    assert s.expected_base_revision == config_module.EXPECTED_BASE_REVISION_DEFAULT
    assert s.device_preference == "auto"
    assert s.dtype_preference == "auto"
    assert s.environment == "production"
    assert s.skip_model_load is False
    assert s.enable_thinking is False
    assert s.default_temperature == 0.0  # 确定性默认生成


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("BASE_MODEL_PATH", "/tmp/fake-base")
    monkeypatch.setenv("ADAPTER_PATH", "/tmp/fake-adapter")
    monkeypatch.setenv("DEVICE", "cpu")
    monkeypatch.setenv("DTYPE", "float16")
    monkeypatch.setenv("MAX_TOKENS_CEILING", "2048")
    s = config_module.get_settings()
    assert str(s.base_model_path) == "/tmp/fake-base"
    assert str(s.adapter_path) == "/tmp/fake-adapter"
    assert s.device_preference == "cpu"
    assert s.dtype_preference == "float16"
    assert s.max_tokens_ceiling == 2048


def test_is_test_mode_requires_both_flags(monkeypatch):
    monkeypatch.setenv("CS_SKIP_MODEL_LOAD", "true")
    monkeypatch.setenv("APP_ENV", "production")
    s = config_module.get_settings()
    assert s.skip_model_load is True
    assert s.is_test_mode() is False, "生产环境即使设置了 skip 标记也不得进入测试模式"

    monkeypatch.setenv("APP_ENV", "test")
    s2 = config_module.get_settings()
    assert s2.is_test_mode() is True


def test_is_test_mode_false_without_skip_flag(monkeypatch):
    monkeypatch.delenv("CS_SKIP_MODEL_LOAD", raising=False)
    monkeypatch.setenv("APP_ENV", "test")
    s = config_module.get_settings()
    assert s.is_test_mode() is False, "只设置 APP_ENV=test 不应自动跳过加载"
