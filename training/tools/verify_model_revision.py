#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基础模型 revision 硬门禁。

在 Linux/4090 上，**无法用证据证明 revision 就是 FAIL**，不接受"人工确认后继续"。
本工具不联网、不下载、不修改模型目录。

证据源按优先级：
  1. git      —— 模型目录是 git 仓库，读 HEAD
  2. hf-local —— huggingface-cli download --local-dir 留下的
                 .cache/huggingface/download/*.metadata（首行是 commit hash）
  3. hf-snapshot —— HF hub 缓存的 snapshots/<commit>/ 路径，
                 并与 refs/<branch> 记录交叉核对
  4. manifest —— 由模型准备步骤产出的可信 revision manifest。
                 **只写一个 revision 字符串不算证据**：manifest 必须同时绑定关键
                 模型文件清单与 SHA-256，本工具会逐个复核文件确实存在且哈希一致。

用法：
    python3 verify_model_revision.py --model-dir /workspace/models/Qwen3-8B \
        --expect b968826d9c46dd6066d109eabc6255188de91218
    python3 verify_model_revision.py --model-dir <dir> --inspect     # 只读排查命令
    python3 verify_model_revision.py --manifest-schema               # 打印 manifest 规范

退出码：0 = 已证明且匹配；1 = 证据不足或不匹配。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

MANIFEST_NAME = "revision-manifest.json"
MANIFEST_SCHEMA = "model-revision-manifest/v1"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# manifest 至少要覆盖这些"改一个字节就会换 revision"的文件
CRITICAL_PATTERNS = ("config.json", "tokenizer_config.json", "tokenizer.json")
WEIGHT_SUFFIXES = (".safetensors", ".bin")


def sha256_file(path: Path, limit_bytes: int | None = None) -> str:
    h = hashlib.sha256()
    read = 0
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            if limit_bytes is not None and read + len(chunk) > limit_bytes:
                h.update(chunk[: limit_bytes - read])
                break
            h.update(chunk)
            read += len(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# 证据源
# ---------------------------------------------------------------------------
def evidence_git(model_dir: Path) -> dict | None:
    if not (model_dir / ".git").exists():
        return None
    try:
        out = subprocess.run(["git", "-C", str(model_dir), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=15)
    except Exception as exc:
        return {"source": "git", "revision": None, "detail": f"git 调用失败：{exc}"}
    rev = out.stdout.strip()
    if not SHA_RE.match(rev):
        return {"source": "git", "revision": None,
                "detail": f"git rev-parse 未返回合法 commit：{out.stderr.strip()[:120]}"}
    dirty = subprocess.run(["git", "-C", str(model_dir), "status", "--porcelain"],
                           capture_output=True, text=True, timeout=30).stdout.strip()
    return {
        "source": "git",
        "revision": rev,
        "detail": f"{model_dir}/.git HEAD = {rev}"
                  + ("（工作区有未提交改动，权重可能已被修改）" if dirty else "（工作区干净）"),
        "warning": bool(dirty),
    }


def evidence_hf_local(model_dir: Path) -> dict | None:
    meta_dir = model_dir / ".cache/huggingface/download"
    if not meta_dir.is_dir():
        return None
    hashes: dict[str, list[str]] = {}
    for meta in meta_dir.rglob("*.metadata"):
        try:
            first = meta.read_text(encoding="utf-8").splitlines()[0].strip()
        except Exception:
            continue
        if SHA_RE.match(first):
            hashes.setdefault(first, []).append(meta.name)
    if not hashes:
        return {"source": "hf-local", "revision": None,
                "detail": f"{meta_dir} 中未找到含 commit hash 的 .metadata"}
    if len(hashes) > 1:
        return {"source": "hf-local", "revision": None,
                "detail": f"下载元数据里出现多个不同 commit：{sorted(hashes)}，"
                          "说明目录混合了不同版本的文件，拒绝采信"}
    rev = next(iter(hashes))
    return {"source": "hf-local", "revision": rev,
            "detail": f"{meta_dir} 中 {len(hashes[rev])} 个 .metadata 一致指向 {rev}"}


def evidence_hf_snapshot(model_dir: Path) -> dict | None:
    """模型目录本身位于（或软链到）HF hub 缓存的 snapshots/<commit>/ 下。"""
    real = model_dir.resolve()
    parts = real.parts
    if "snapshots" not in parts:
        return None
    i = parts.index("snapshots")
    if i + 1 >= len(parts):
        return None
    rev = parts[i + 1]
    if not SHA_RE.match(rev):
        return {"source": "hf-snapshot", "revision": None,
                "detail": f"snapshots 下的目录名不是合法 commit：{rev}"}
    repo_root = Path(*parts[: i])
    refs_dir = repo_root / "refs"
    cross = []
    if refs_dir.is_dir():
        for ref in refs_dir.iterdir():
            if ref.is_file():
                cross.append(f"{ref.name}={ref.read_text(encoding='utf-8').strip()}")
    return {"source": "hf-snapshot", "revision": rev,
            "detail": f"snapshot 路径 {real} → revision={rev}"
                      + (f"；refs: {', '.join(cross)}" if cross else "")}


def evidence_manifest(model_dir: Path, manifest_path: Path | None) -> dict | None:
    path = manifest_path or (model_dir / MANIFEST_NAME)
    if not path.is_file():
        return None
    try:
        man = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"source": "manifest", "revision": None,
                "detail": f"manifest 不可解析：{exc}"}

    if man.get("schema") != MANIFEST_SCHEMA:
        return {"source": "manifest", "revision": None,
                "detail": f"schema 不是 {MANIFEST_SCHEMA}：{man.get('schema')}"}
    rev = man.get("revision")
    if not (isinstance(rev, str) and SHA_RE.match(rev)):
        return {"source": "manifest", "revision": None,
                "detail": f"revision 字段不是合法 commit：{rev}"}

    files = man.get("files")
    if not isinstance(files, list) or not files:
        return {"source": "manifest", "revision": None,
                "detail": "manifest 只写了 revision 而没有文件清单，不构成证据（拒绝采信）"}

    names = [f.get("name", "") for f in files if isinstance(f, dict)]
    missing_critical = [p for p in CRITICAL_PATTERNS if p not in names]
    if missing_critical:
        return {"source": "manifest", "revision": None,
                "detail": f"文件清单覆盖不足：缺 {missing_critical}"}

    # ---- 权重分片完整性校验 ----
    index_path = model_dir / "model.safetensors.index.json"
    if index_path.is_file():
        if "model.safetensors.index.json" not in names:
            return {"source": "manifest", "revision": None,
                    "detail": "模型目录存在 model.safetensors.index.json 但 manifest 未绑定该文件"}
        try:
            index_data = json.loads(index_path.read_text(encoding="utf-8"))
            weight_map = index_data.get("weight_map", {})
        except Exception as exc:
            return {"source": "manifest", "revision": None,
                    "detail": f"无法解析 model.safetensors.index.json：{exc}"}
        shard_names = sorted(set(weight_map.values()))
        if not shard_names:
            return {"source": "manifest", "revision": None,
                    "detail": "model.safetensors.index.json 的 weight_map 为空"}
        missing_shards = [s for s in shard_names if s not in names]
        if missing_shards:
            return {"source": "manifest", "revision": None,
                    "detail": f"manifest 未绑定 index 引用的权重分片：{missing_shards}"}
    else:
        if "model.safetensors" not in names:
            return {"source": "manifest", "revision": None,
                    "detail": "无 index.json 时 manifest 必须绑定单文件模型权重 model.safetensors"}

    problems = []
    checked = 0
    for f in files:
        if not isinstance(f, dict):
            problems.append(f"清单条目不是对象：{f!r}")
            continue
        name, want = f.get("name"), f.get("sha256")
        p = model_dir / str(name)
        if not p.is_file():
            problems.append(f"缺少文件：{name}")
            continue
        if "bytes" in f and p.stat().st_size != f["bytes"]:
            problems.append(f"{name} 大小不符：实际 {p.stat().st_size}，清单 {f['bytes']}")
            continue
        if not (isinstance(want, str) and len(want) == 64):
            problems.append(f"{name} 缺少合法 sha256")
            continue
        if sha256_file(p) != want:
            problems.append(f"{name} SHA-256 不符")
            continue
        checked += 1
    if problems:
        return {"source": "manifest", "revision": None,
                "detail": f"清单校验失败（{len(problems)} 项）：{problems[:5]}"}
    return {"source": "manifest", "revision": rev,
            "detail": f"{path} 校验通过：{checked} 个文件的 SHA-256 与清单一致，"
                      f"证据来源字段={man.get('evidence_source')}"}


ORDER = ("git", "hf-local", "hf-snapshot", "manifest")


def collect(model_dir: Path, manifest_path: Path | None) -> list:
    out = []
    for fn in (evidence_git, evidence_hf_local, evidence_hf_snapshot):
        e = fn(model_dir)
        if e:
            out.append(e)
    e = evidence_manifest(model_dir, manifest_path)
    if e:
        out.append(e)
    return out


def inspect_commands(model_dir: Path) -> str:
    return f"""只读排查命令（都不会修改模型目录、不联网、不下载）：

  # 1) 是否 git 仓库
  ls -d {model_dir}/.git 2>/dev/null && git -C {model_dir} rev-parse HEAD

  # 2) 是否有 huggingface-cli --local-dir 的下载元数据
  find {model_dir}/.cache/huggingface/download -name '*.metadata' 2>/dev/null | head
  head -1 $(find {model_dir}/.cache/huggingface/download -name '*.metadata' 2>/dev/null | head -1)

  # 3) 是否位于 HF hub 缓存的 snapshots/<commit>/ 下
  readlink -f {model_dir}
  ls ${{HF_HUB_CACHE:-${{HF_HOME:-$HOME/.cache/huggingface}}/hub}}/models--Qwen--Qwen3-8B/snapshots 2>/dev/null
  cat  ${{HF_HUB_CACHE:-${{HF_HOME:-$HOME/.cache/huggingface}}/hub}}/models--Qwen--Qwen3-8B/refs/* 2>/dev/null

  # 4) 是否已有可信 manifest
  cat {model_dir}/{MANIFEST_NAME} 2>/dev/null

  # 关键文件指纹（用于人工与官方仓库比对，或写入 manifest）
  ls -l {model_dir}
  shasum -a 256 {model_dir}/config.json {model_dir}/tokenizer_config.json \\
                {model_dir}/tokenizer.json {model_dir}/*.safetensors

以上四条都拿不到证据时，**不要**手写一个 revision 了事：
manifest 必须绑定文件清单与 SHA-256（见 --manifest-schema），
否则本门禁会拒绝采信。"""


MANIFEST_SCHEMA_TEXT = f"""可信 revision manifest 规范（放在 <model_dir>/{MANIFEST_NAME}）：

{{
  "schema": "{MANIFEST_SCHEMA}",
  "repo": "Qwen/Qwen3-8B",
  "revision": "<40 位 commit hash>",
  "evidence_source": "huggingface-download | mirror-with-published-digests | 其它可追溯来源",
  "generated_at": "<UTC ISO8601>",
  "generated_by": "<人或脚本>",
  "note": "revision 的原始出处，必须可追溯，不能是凭印象填写",
  "files": [
    {{"name": "config.json",           "bytes": 1234,  "sha256": "<64 位>"}},
    {{"name": "tokenizer_config.json", "bytes": 5432,  "sha256": "<64 位>"}},
    {{"name": "tokenizer.json",        "bytes": 11422654, "sha256": "<64 位>"}},
    {{"name": "model-00001-of-0000N.safetensors", "bytes": ..., "sha256": "<64 位>"}}
  ]
}}

 硬性要求：
- files 非空，且必须包含 {', '.join(CRITICAL_PATTERNS)}；
- 若模型目录存在 model.safetensors.index.json，则 manifest 必须绑定该文件，
  且 index 中 weight_map 引用的**全部** safetensors 分片都必须出现在 files 中；
- 若无 index.json（单文件模型），则必须包含 model.safetensors；
- 每个条目都要有 64 位 sha256；本门禁会逐个重算并比对；
- 只有 revision 字符串、没有文件清单的 manifest 一律拒绝采信；
- 只绑定部分权重分片（如仅一个 .safetensors 文件）的 manifest 一律拒绝。"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=False)
    ap.add_argument("--expect", required=False)
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--manifest-schema", action="store_true")
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    if args.manifest_schema:
        print(MANIFEST_SCHEMA_TEXT)
        return 0
    if not args.model_dir:
        print("需要 --model-dir", file=sys.stderr)
        return 2

    model_dir = Path(args.model_dir)
    if args.inspect:
        print(inspect_commands(model_dir))
        return 0
    if not args.expect:
        print("需要 --expect", file=sys.stderr)
        return 2

    print("=" * 78)
    print("基础模型 revision 门禁")
    print("=" * 78)
    print(f"  模型目录 : {model_dir}")
    print(f"  期望 rev : {args.expect}")

    if not model_dir.is_dir():
        print(f"\n  [FAIL] 模型目录不存在：{model_dir}")
        print("  本工具不会下载模型。请人工准备权重后重试。")
        return 1

    manifest_path = Path(args.manifest) if args.manifest else None
    evidences = collect(model_dir, manifest_path)

    print("\n  证据源（按优先级）：")
    for name in ORDER:
        e = next((x for x in evidences if x["source"] == name), None)
        if e is None:
            print(f"    - {name:<12} 不可用")
        elif e["revision"] is None:
            print(f"    - {name:<12} 无效：{e['detail']}")
        else:
            print(f"    - {name:<12} revision={e['revision']}")
            print(f"      {' ' * 12} {e['detail']}")

    usable = [e for e in evidences if e.get("revision")]
    result = {
        "model_dir": str(model_dir),
        "expected": args.expect,
        "evidences": evidences,
        "used": None,
        "verdict": "FAIL",
    }

    if not usable:
        print("\n  [FAIL] 没有任何可用证据能证明 revision。")
        print("  不接受人工口头确认。请按下列只读命令排查，或补一份带文件 SHA-256 的 manifest：\n")
        print("  " + inspect_commands(model_dir).replace("\n", "\n  "))
        _dump(result, args.json_out)
        return 1

    # 多个证据源同时存在时必须互相一致，否则说明目录被混合过
    revs = {e["revision"] for e in usable}
    if len(revs) > 1:
        print(f"\n  [FAIL] 多个证据源给出不同 revision：{sorted(revs)}")
        print("  模型目录可能混合了不同版本的文件，禁止用于训练。")
        result["verdict"] = "FAIL-CONFLICT"
        _dump(result, args.json_out)
        return 1

    best = min(usable, key=lambda e: ORDER.index(e["source"]))
    result["used"] = best
    actual = best["revision"]
    print(f"\n  采信证据 : {best['source']}")
    print(f"  实际 rev : {actual}")

    if actual != args.expect:
        print(f"\n  [FAIL] revision 不符：实际 {actual}，期望 {args.expect}")
        print("  revision 不一致会让 tokenizer / chat template 变化，Adapter 会失配。")
        _dump(result, args.json_out)
        return 1

    if best.get("warning"):
        print("\n  [FAIL] 证据来自 git，但工作区有未提交改动 —— 权重可能已被本地修改，")
        print("  commit hash 不能代表磁盘上的实际内容。请清理工作区或改用 manifest 证据。")
        result["verdict"] = "FAIL-DIRTY"
        _dump(result, args.json_out)
        return 1

    print(f"\n  [PASS] revision 已由 {best['source']} 证明并与期望一致")
    result["verdict"] = "PASS"
    _dump(result, args.json_out)
    return 0


def _dump(result: dict, path: str | None):
    if path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
