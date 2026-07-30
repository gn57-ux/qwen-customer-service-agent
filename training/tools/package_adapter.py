#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包最佳 Adapter：只带重载所需文件，不带训练状态。

打包内容（白名单，逐项存在性检查）：
  adapter_config.json / adapter_model.safetensors      —— PEFT LoRA 权重
  tokenizer*.json / vocab.json / merges.txt /
  special_tokens_map.json / added_tokens.json /
  chat_template.jinja                                   —— 分词器与模板资产
  README.md（本脚本生成）/ metadata.json（本脚本生成）

明确**不打包**：
  optimizer.pt / scheduler.pt / rng_state*.pth / global_step* /
  training_args.bin / trainer_state.json / *.png
  —— 属于训练状态或过程产物，不是重载 Adapter 的必需品。

打包后自动解压到临时目录并重新校验（逐文件 SHA-256 + PEFT 配置可解析）。
**不删除原 checkpoint**，也不删除任何既有文件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_common as G  # noqa: E402

REQUIRED = ("adapter_config.json", "adapter_model.safetensors")
OPTIONAL = (
    "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt",
    "special_tokens_map.json", "added_tokens.json", "chat_template.jinja",
)
EXCLUDED_PREFIXES = ("optimizer", "scheduler", "rng_state", "global_step",
                     "training_args", "trainer_state", "training_loss")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter-path", required=True, help="最佳 checkpoint 目录")
    ap.add_argument("--fallback-dir", default=None,
                    help="分词器资产的备选来源（Trainer 输出目录）")
    ap.add_argument("--selection-dir", default=None,
                    help="checkpoint 选择报告所在目录（Control 目录下的 selection/）")
    ap.add_argument("--out-dir", default=None, help="默认 <output_dir>/package")
    ap.add_argument("--name", default="customer-service-production-v1")
    ap.add_argument("--eval-report", default=None, help="终测报告路径，写入元数据")
    ap.add_argument("--base-eval-report", default=None)
    args = ap.parse_args()

    cfg = G.production_config()
    src = Path(args.adapter_path)
    fallback = Path(args.fallback_dir) if args.fallback_dir else Path(cfg["output_dir"])
    out_dir = Path(args.out_dir or (cfg["output_dir"] + "/package"))

    if not src.is_dir():
        print(f"[FAIL] Adapter 目录不存在：{src}", file=sys.stderr)
        return 1

    # ---- 收集文件 ---------------------------------------------------------
    picked: list[tuple[str, Path]] = []
    missing_required = []
    for name in REQUIRED:
        p = src / name
        if p.is_file():
            picked.append((name, p))
        else:
            missing_required.append(name)
    if missing_required:
        print(f"[FAIL] 缺少必需文件：{missing_required}", file=sys.stderr)
        return 1
    for name in OPTIONAL:
        p = src / name
        if not p.is_file() and fallback.is_dir():
            p = fallback / name
        if p.is_file():
            picked.append((name, p))

    picked_names = {n for n, _ in picked}
    skipped = [p.name for p in src.iterdir()
               if p.is_file() and p.name not in picked_names]
    wrongly_included = [n for n in picked_names
                        if n.startswith(EXCLUDED_PREFIXES)]
    if wrongly_included:
        print(f"[FAIL] 白名单里混入了训练状态文件：{wrongly_included}", file=sys.stderr)
        return 1

    # ---- 元数据 -----------------------------------------------------------
    data = G.verify_datasets()
    adapter_config = json.loads((src / "adapter_config.json").read_text(encoding="utf-8"))
    selection = None
    # 选择报告在 Control 目录，不在 Trainer 目录。显式传入优先，避免猜路径。
    if args.selection_dir:
        sel_path = Path(args.selection_dir) / "checkpoint-selection.json"
    else:
        sel_path = Path(cfg["output_dir"] + "-control") / "selection/checkpoint-selection.json"
    if sel_path.is_file():
        selection = json.loads(sel_path.read_text(encoding="utf-8"))

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    metadata = {
        "package_name": args.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_model": {
            "path": cfg.get("model_name_or_path"),
            "revision": cfg.get("model_revision"),
            "repo": "Qwen/Qwen3-8B",
        },
        "adapter": {
            "source_checkpoint": str(src),
            "peft_type": adapter_config.get("peft_type"),
            "r": adapter_config.get("r"),
            "lora_alpha": adapter_config.get("lora_alpha"),
            "target_modules": adapter_config.get("target_modules"),
        },
        "dataset_sha256": {
            k: v["sha256"] for k, v in data.items() if k != "_problems"
        },
        "dataset_counts": {
            k: v["count"] for k, v in data.items() if k != "_problems"
        },
        "train_config": {
            "path": str(G.CONFIG_PRODUCTION.relative_to(G.REPO_ROOT)),
            "sha256": G.config_sha256(),
            "template": cfg.get("template"),
            "cutoff_len": cfg.get("cutoff_len"),
            "quantization": f"{cfg.get('quantization_bit')}bit/{cfg.get('quantization_type')}",
        },
        "git": G.git_state(),
        "best_checkpoint": (selection or {}).get("best_model_checkpoint", str(src)),
        "best_eval_loss": (selection or {}).get("best_metric"),
        "selection_basis": "validation eval_loss（test-80 未参与 checkpoint 选择）",
        "reports": {
            "base_eval": args.base_eval_report,
            "adapter_eval": args.eval_report,
            "checkpoint_selection": str(sel_path) if sel_path.is_file() else None,
        },
        "excluded_from_package": sorted(skipped),
        "restore_commands": [
            f"tar -xzf {args.name}-{stamp}.tar.gz -C <目标目录>",
            "python3 - <<'PY'\n"
            "from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig\n"
            "from peft import PeftModel\n"
            "import torch\n"
            f"BASE = '{cfg.get('model_name_or_path')}'   # revision {cfg.get('model_revision')}\n"
            "ADAPTER = '<解压目录>'\n"
            "q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',\n"
            "                       bnb_4bit_use_double_quant=True,\n"
            "                       bnb_4bit_compute_dtype=torch.bfloat16)\n"
            "tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)\n"
            "m = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=q,\n"
            "        dtype=torch.bfloat16, device_map='auto', trust_remote_code=True)\n"
            "m = PeftModel.from_pretrained(m, ADAPTER); m.eval()\n"
            "PY",
            "python3 training/tools/adapter_reload_check.py --adapter-path <解压目录>",
        ],
    }

    # ---- 打包 -------------------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    stage = out_dir / f"{args.name}-{stamp}"
    if stage.exists():
        print(f"[FAIL] 暂存目录已存在，拒绝覆盖：{stage}", file=sys.stderr)
        return 1
    stage.mkdir(parents=True)

    file_list = []
    for name, path in picked:
        shutil.copy2(path, stage / name)
        file_list.append({"name": name, "bytes": path.stat().st_size,
                          "sha256": sha256(path), "source": str(path)})
    (stage / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (stage / "README.md").write_text(render_readme(metadata, file_list), encoding="utf-8")
    for extra in ("metadata.json", "README.md"):
        p = stage / extra
        file_list.append({"name": extra, "bytes": p.stat().st_size,
                          "sha256": sha256(p), "source": "generated"})

    tar_path = out_dir / f"{args.name}-{stamp}.tar.gz"
    if tar_path.exists():
        print(f"[FAIL] 归档已存在，拒绝覆盖：{tar_path}", file=sys.stderr)
        return 1
    with tarfile.open(tar_path, "w:gz") as tf:
        tf.add(stage, arcname=stage.name)
    tar_sha = sha256(tar_path)

    # ---- 解压回验 ---------------------------------------------------------
    verify_problems = []
    with tempfile.TemporaryDirectory(prefix="adapter-verify-") as tmp:
        with tarfile.open(tar_path, "r:gz") as tf:
            tf.extractall(tmp)
        root = Path(tmp) / stage.name
        for entry in file_list:
            p = root / entry["name"]
            if not p.is_file():
                verify_problems.append(f"解压后缺少 {entry['name']}")
                continue
            if sha256(p) != entry["sha256"]:
                verify_problems.append(f"解压后 SHA-256 不符：{entry['name']}")
        try:
            ac = json.loads((root / "adapter_config.json").read_text(encoding="utf-8"))
            if ac.get("peft_type") != "LORA":
                verify_problems.append(f"解压后 peft_type={ac.get('peft_type')}")
        except Exception as exc:
            verify_problems.append(f"解压后 adapter_config.json 不可解析：{exc}")

    manifest = {
        "archive": str(tar_path),
        "archive_sha256": tar_sha,
        "archive_bytes": tar_path.stat().st_size,
        "staging_dir": str(stage),
        "files": file_list,
        "metadata": metadata,
        "extract_verify": {
            "performed": True,
            "problems": verify_problems,
            "verdict": "FAIL" if verify_problems else "PASS",
        },
        "original_checkpoint_preserved": src.is_dir(),
    }
    manifest_path = out_dir / f"{args.name}-{stamp}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")

    print("=" * 78)
    print("Adapter 打包")
    print("=" * 78)
    print(f"  归档      : {tar_path}")
    print(f"  SHA-256   : {tar_sha}")
    print(f"  大小      : {round(tar_path.stat().st_size / (1024**2), 2)} MB")
    print(f"  文件数    : {len(file_list)}")
    for f in file_list:
        print(f"      {f['name']:<28} {f['bytes']:>12} B")
    print(f"  已排除    : {sorted(skipped)}")
    print(f"  解压回验  : {manifest['extract_verify']['verdict']}")
    print(f"  原 checkpoint 保留: {src}")
    print(f"  清单      : {manifest_path}")
    print("=" * 78)
    if verify_problems:
        for p in verify_problems:
            print(f"  [FAIL] {p}")
        return 1
    return 0


def render_readme(meta: dict, files: list) -> str:
    L = []
    A = L.append
    A(f"# {meta['package_name']}")
    A("")
    A("电商客服 QLoRA Adapter（PEFT LoRA）。本包只含重载所需文件，不含训练状态。")
    A("")
    A("## 绑定")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A(f"| 基础模型 | `{meta['base_model']['repo']}` |")
    A(f"| revision | `{meta['base_model']['revision']}` |")
    A(f"| Base 路径（训练时） | `{meta['base_model']['path']}` |")
    A(f"| PEFT | `{meta['adapter']['peft_type']}` r={meta['adapter']['r']} "
      f"alpha={meta['adapter']['lora_alpha']} |")
    A(f"| 训练配置 | `{meta['train_config']['path']}` |")
    A(f"| 训练配置 SHA-256 | `{meta['train_config']['sha256']}` |")
    A(f"| template | `{meta['train_config']['template']}` |")
    A(f"| git commit | `{meta['git'].get('commit')}` |")
    A(f"| 最佳 checkpoint | `{meta['best_checkpoint']}` |")
    A(f"| best eval_loss | `{meta['best_eval_loss']}` |")
    A(f"| 选择依据 | {meta['selection_basis']} |")
    A("")
    A("## 数据集 SHA-256")
    A("")
    A("| Split | 条数 | SHA-256 |")
    A("|---|---:|---|")
    for split, sha in meta["dataset_sha256"].items():
        A(f"| {split} | {meta['dataset_counts'][split]} | `{sha}` |")
    A("")
    A("## 文件清单")
    A("")
    A("| 文件 | 字节 |")
    A("|---|---:|")
    for f in files:
        A(f"| `{f['name']}` | {f['bytes']} |")
    A("")
    A("## 评测报告")
    A("")
    for k, v in meta["reports"].items():
        A(f"- {k}: `{v}`")
    A("")
    A("## 恢复 / 重载")
    A("")
    for cmd in meta["restore_commands"]:
        A("```bash" if not cmd.startswith("python3 - ") else "```python")
        A(cmd)
        A("```")
        A("")
    A("> 基础模型必须使用上表的 revision。revision 不一致时 tokenizer 或 chat template "
      "可能变化，会导致 Adapter 失配。")
    A("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
