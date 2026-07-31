import hashlib
import json
import subprocess

import revision_check as rc

REV = "b968826d9c46dd6066d109eabc6255188de91218"
WRONG = "0" * 40


def _git_init(path, run_command=subprocess.run):
    (path / "config.json").write_text("{}", encoding="utf-8")
    run_command(["git", "init", "-q"], cwd=path, check=True)
    run_command(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], cwd=path, check=True)
    run_command(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], cwd=path, check=True)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True).stdout.strip()


def test_missing_model_dir(tmp_path):
    result = rc.verify_revision(tmp_path / "does-not-exist", REV)
    assert result.matched is False
    assert "不存在" in result.detail


def test_git_match(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    actual_rev = _git_init(d)
    result = rc.verify_revision(d, actual_rev)
    assert result.matched is True
    assert result.evidence_source == "git"


def test_git_mismatch(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    _git_init(d)
    result = rc.verify_revision(d, WRONG)
    assert result.matched is False


def test_git_dirty_workdir_rejected(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    actual_rev = _git_init(d)
    (d / "config.json").write_text('{"changed": true}', encoding="utf-8")
    result = rc.verify_revision(d, actual_rev)
    assert result.matched is False
    assert "未提交" in result.detail or "commit" in result.detail


def test_no_evidence_at_all(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    (d / "config.json").write_text("{}", encoding="utf-8")
    result = rc.verify_revision(d, REV)
    assert result.matched is False
    assert result.evidence_source is None


def test_hf_local_metadata(tmp_path):
    d = tmp_path / "model"
    meta_dir = d / ".cache" / "huggingface" / "download"
    meta_dir.mkdir(parents=True)
    (meta_dir / "config.json.metadata").write_text(REV + "\n", encoding="utf-8")
    (meta_dir / "model.safetensors.metadata").write_text(REV + "\n", encoding="utf-8")
    result = rc.verify_revision(d, REV)
    assert result.matched is True
    assert result.evidence_source == "hf-local"


def test_hf_local_conflicting_metadata_rejected(tmp_path):
    d = tmp_path / "model"
    meta_dir = d / ".cache" / "huggingface" / "download"
    meta_dir.mkdir(parents=True)
    (meta_dir / "a.metadata").write_text(REV + "\n", encoding="utf-8")
    (meta_dir / "b.metadata").write_text(WRONG + "\n", encoding="utf-8")
    result = rc.verify_revision(d, REV)
    assert result.matched is False


def test_manifest_without_file_list_rejected(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    (d / rc.MANIFEST_NAME).write_text(
        json.dumps({"schema": rc.MANIFEST_SCHEMA, "revision": REV}), encoding="utf-8"
    )
    result = rc.verify_revision(d, REV)
    assert result.matched is False
    assert "文件清单" in result.detail or "证据" in result.detail


def test_manifest_with_files_matches(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    (d / "config.json").write_bytes(b'{"a":1}')
    (d / "tokenizer_config.json").write_bytes(b'{"b":2}')
    (d / "model.safetensors").write_bytes(b"WEIGHTS")
    files = []
    for name in ("config.json", "tokenizer_config.json", "model.safetensors"):
        content = (d / name).read_bytes()
        files.append({"name": name, "sha256": hashlib.sha256(content).hexdigest()})
    (d / rc.MANIFEST_NAME).write_text(
        json.dumps({"schema": rc.MANIFEST_SCHEMA, "revision": REV, "files": files}), encoding="utf-8"
    )
    result = rc.verify_revision(d, REV)
    assert result.matched is True
    assert result.evidence_source == "manifest"


def test_manifest_tampered_file_rejected(tmp_path):
    d = tmp_path / "model"
    d.mkdir()
    (d / "config.json").write_bytes(b'{"a":1}')
    (d / "tokenizer_config.json").write_bytes(b'{"b":2}')
    (d / "model.safetensors").write_bytes(b"WEIGHTS")
    files = []
    for name in ("config.json", "tokenizer_config.json", "model.safetensors"):
        content = (d / name).read_bytes()
        files.append({"name": name, "sha256": hashlib.sha256(content).hexdigest()})
    (d / rc.MANIFEST_NAME).write_text(
        json.dumps({"schema": rc.MANIFEST_SCHEMA, "revision": REV, "files": files}), encoding="utf-8"
    )
    (d / "model.safetensors").write_bytes(b"TAMPERED")
    result = rc.verify_revision(d, REV)
    assert result.matched is False
