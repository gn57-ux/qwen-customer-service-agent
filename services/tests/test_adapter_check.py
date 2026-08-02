import hashlib
import json

import adapter_check as ac

REV = "b968826d9c46dd6066d109eabc6255188de91218"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_adapter(d, peft_type="LORA"):
    d.mkdir(parents=True, exist_ok=True)
    (d / "adapter_config.json").write_text(
        json.dumps({"peft_type": peft_type, "r": 16, "lora_alpha": 32}), encoding="utf-8"
    )
    (d / "adapter_model.safetensors").write_bytes(b"WEIGHTS-BLOB")
    return d


def _write_restore_report(d, base_revision=REV, verdict="PASS", tamper_sha=False):
    files = []
    for name in ("adapter_config.json", "adapter_model.safetensors"):
        content = (d / name).read_bytes()
        expected = _sha256(content)
        if tamper_sha and name == "adapter_model.safetensors":
            expected = "0" * 64
        files.append({"name": name, "expected_bytes": len(content), "expected_sha256": expected})
    report = {
        "file_verification": files,
        "metadata_checks": {
            "base_revision_actual": base_revision,
            "best_checkpoint": "checkpoint-160",
            "best_eval_loss": 1.8314380645751953,
        },
        "verdict": verdict,
    }
    (d / ac.RESTORE_REPORT_NAME).write_text(json.dumps(report), encoding="utf-8")


def test_missing_dir(tmp_path):
    result = ac.verify_adapter(tmp_path / "nope", REV)
    assert result.matched is False


def test_smoke_path_rejected_even_if_otherwise_valid(tmp_path):
    d = _write_adapter(tmp_path / "adapters" / "customer-service-smoke")
    _write_restore_report(d)
    result = ac.verify_adapter(d, REV)
    assert result.matched is False
    assert "smoke" in result.detail.lower()


def test_missing_required_files(tmp_path):
    d = tmp_path / "adapter"
    d.mkdir()
    (d / "adapter_config.json").write_text("{}", encoding="utf-8")
    result = ac.verify_adapter(d, REV)
    assert result.matched is False
    assert "缺少必需文件" in result.detail


def test_peft_type_not_lora(tmp_path):
    d = _write_adapter(tmp_path / "adapter", peft_type="PREFIX_TUNING")
    result = ac.verify_adapter(d, REV)
    assert result.matched is False
    assert result.peft_type == "PREFIX_TUNING"


def test_missing_restore_report(tmp_path):
    d = _write_adapter(tmp_path / "adapter")
    result = ac.verify_adapter(d, REV)
    assert result.matched is False
    assert "RESTORE-VERIFICATION" in result.detail


def test_restore_report_verdict_not_pass(tmp_path):
    d = _write_adapter(tmp_path / "adapter")
    _write_restore_report(d, verdict="FAIL")
    result = ac.verify_adapter(d, REV)
    assert result.matched is False


def test_base_revision_mismatch_in_report(tmp_path):
    d = _write_adapter(tmp_path / "adapter")
    _write_restore_report(d, base_revision="0" * 40)
    result = ac.verify_adapter(d, REV)
    assert result.matched is False


def test_file_tampered_after_restore(tmp_path):
    d = _write_adapter(tmp_path / "adapter")
    _write_restore_report(d, tamper_sha=True)
    result = ac.verify_adapter(d, REV)
    assert result.matched is False
    assert "SHA-256" in result.detail


def test_valid_adapter_passes(tmp_path):
    d = _write_adapter(tmp_path / "adapter")
    _write_restore_report(d)
    result = ac.verify_adapter(d, REV)
    assert result.matched is True
    assert result.peft_type == "LORA"
    assert result.best_checkpoint == "checkpoint-160"
    assert result.best_eval_loss == 1.8314380645751953


def test_real_restored_adapter_on_disk():
    """针对本次真正恢复的正式 Adapter 做一次真实校验（不使用桩数据）。"""
    from pathlib import Path

    real_dir = Path(__file__).resolve().parents[2] / "models" / "adapters" / "customer-service-production-v1"
    if not real_dir.is_dir():
        import pytest

        pytest.skip("正式 Adapter 尚未恢复到本机，跳过真实路径校验")
    result = ac.verify_adapter(real_dir, REV)
    assert result.matched is True, result.detail
    assert result.best_checkpoint and "checkpoint-160" in result.best_checkpoint
