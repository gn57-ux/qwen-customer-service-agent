"""基础模型 revision 证据校验（服务运行时自用，独立于 training/ 工具）。

刻意与 training/tools/verify_model_revision.py 分开实现：
services/ 是要长期部署的推理服务，不应该在运行时依赖 training/ 目录存在。
两者遵循同一套证据优先级（git → hf-local → hf-snapshot → manifest），
但各自独立维护，改一边不会影响另一边。

manifest 规则与训练侧一致：只写 revision 字符串不算证据，必须绑定文件清单
与 SHA-256。
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MANIFEST_NAME = "revision-manifest.json"
MANIFEST_SCHEMA = "model-revision-manifest/v1"
CRITICAL_FILES = ("config.json", "tokenizer_config.json")
WEIGHT_SUFFIXES = (".safetensors", ".bin")


@dataclass(frozen=True)
class RevisionResult:
    matched: bool
    evidence_source: str | None
    actual_revision: str | None
    detail: str


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _from_git(model_dir: Path) -> tuple[str | None, str]:
    if not (model_dir / ".git").exists():
        return None, "不是 git 仓库"
    try:
        out = subprocess.run(
            ["git", "-C", str(model_dir), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=15,
        )
    except Exception as exc:
        return None, f"git 调用失败：{exc}"
    rev = out.stdout.strip()
    if not SHA_RE.match(rev):
        return None, "git rev-parse 未返回合法 commit"
    dirty = subprocess.run(
        ["git", "-C", str(model_dir), "status", "--porcelain"],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if dirty:
        return None, f"工作区有未提交改动，commit={rev} 不能代表磁盘内容"
    return rev, f".git HEAD={rev}"


def _from_hf_local(model_dir: Path) -> tuple[str | None, str]:
    meta_dir = model_dir / ".cache" / "huggingface" / "download"
    if not meta_dir.is_dir():
        return None, "无 huggingface-cli 下载元数据目录"
    found: dict[str, int] = {}
    for meta in meta_dir.rglob("*.metadata"):
        try:
            first = meta.read_text(encoding="utf-8").splitlines()[0].strip()
        except Exception:
            continue
        if SHA_RE.match(first):
            found[first] = found.get(first, 0) + 1
    if not found:
        return None, "下载元数据中未找到合法 commit hash"
    if len(found) > 1:
        return None, f"下载元数据指向多个不同 commit：{sorted(found)}"
    rev = next(iter(found))
    return rev, f"{meta_dir} 中 {found[rev]} 个 .metadata 一致指向 {rev}"


def _from_hf_snapshot(model_dir: Path) -> tuple[str | None, str]:
    real = model_dir.resolve()
    parts = real.parts
    if "snapshots" not in parts:
        return None, "路径不在 HF 缓存 snapshots/ 下"
    i = parts.index("snapshots")
    if i + 1 >= len(parts):
        return None, "snapshots 后缺少 commit 目录"
    rev = parts[i + 1]
    if not SHA_RE.match(rev):
        return None, f"snapshots 目录名不是合法 commit：{rev}"
    return rev, f"snapshot 路径 → revision={rev}"


def _from_manifest(model_dir: Path) -> tuple[str | None, str]:
    path = model_dir / MANIFEST_NAME
    if not path.is_file():
        return None, f"{MANIFEST_NAME} 不存在"
    try:
        man = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"manifest 不可解析：{exc}"
    if man.get("schema") != MANIFEST_SCHEMA:
        return None, f"schema 不符：{man.get('schema')}"
    rev = man.get("revision")
    if not (isinstance(rev, str) and SHA_RE.match(rev)):
        return None, "revision 字段不是合法 commit"
    files = man.get("files")
    if not isinstance(files, list) or not files:
        return None, "manifest 只写了 revision，没有文件清单，不构成证据"
    names = [f.get("name", "") for f in files if isinstance(f, dict)]
    if any(p not in names for p in CRITICAL_FILES) or not any(
        n.endswith(WEIGHT_SUFFIXES) for n in names
    ):
        return None, "manifest 文件清单覆盖不足（缺关键文件或权重文件）"
    for f in files:
        p = model_dir / str(f.get("name"))
        want = f.get("sha256")
        if not p.is_file():
            return None, f"清单文件缺失：{f.get('name')}"
        if not (isinstance(want, str) and len(want) == 64):
            return None, f"{f.get('name')} 缺少合法 sha256"
        if _sha256(p) != want:
            return None, f"{f.get('name')} SHA-256 不符"
    return rev, f"{path} 校验通过，{len(files)} 个文件 SHA-256 一致"


EVIDENCE_SOURCES = (
    ("git", _from_git),
    ("hf-local", _from_hf_local),
    ("hf-snapshot", _from_hf_snapshot),
    ("manifest", _from_manifest),
)


def verify_revision(model_dir: Path, expected: str) -> RevisionResult:
    if not model_dir.is_dir():
        return RevisionResult(False, None, None, f"模型目录不存在：{model_dir}")

    found: dict[str, tuple[str, str]] = {}
    details = []
    for name, fn in EVIDENCE_SOURCES:
        rev, detail = fn(model_dir)
        details.append(f"{name}: {detail}")
        if rev:
            found[name] = (rev, detail)

    if not found:
        return RevisionResult(
            False, None, None,
            "没有任何可用证据能证明 revision（" + "；".join(details) + "）",
        )

    revs = {v[0] for v in found.values()}
    if len(revs) > 1:
        return RevisionResult(
            False, None, None,
            f"多个证据源给出不同 revision：{sorted(revs)}，模型目录可能被混合过",
        )

    source = next(iter(found))
    actual, detail = found[source]
    if actual != expected:
        return RevisionResult(
            False, source, actual,
            f"revision 不符：实际 {actual}（来自 {source}），期望 {expected}",
        )
    return RevisionResult(True, source, actual, f"{source} 证明：{detail}")
