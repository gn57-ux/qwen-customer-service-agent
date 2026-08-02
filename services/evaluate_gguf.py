#!/usr/bin/env python3
"""GGUF 生产路径回归评测：只读，用冻结的 test-80，走真实 FastAPI（llama_cpp backend）。

5 问只是 smoke，不是质量冻结。这个脚本才是对 test-80 的完整回归：
- 80/80 必须生成成功，否则整体退出非零（单条失败仍会被记录，不吞掉）；
- 复用训练阶段同一套规则指标（training/tools/rule_metrics.py），口径一致，
  不重新发明一套标准；
- 明确标记 backend=llama.cpp、quantization=Q4_K_M、adapter SHA，不宣称与
  4090 NF4 训练时的结果等价——精度损失（Q4_K_M vs bf16/NF4）未知，需要人工判断；
- 不用这份结果调参或选择 checkpoint（checkpoint 早已在训练阶段用 validation
  eval_loss 选定，见 services/manifests/…json 的 best_checkpoint）；
- 结果不覆盖：同名文件已存在则拒绝。

用法：
    .venv/bin/python services/evaluate_gguf.py
    .venv/bin/python services/evaluate_gguf.py --base-url http://127.0.0.1:8000
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "training" / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gate_common as G  # noqa: E402  （training/tools，只读复用，不修改）
import rule_metrics as RM  # noqa: E402

MANIFEST_PATH = REPO_ROOT / "services" / "manifests" / "customer-service-production-v1.gguf.json"
OUT_DIR = REPO_ROOT / "services" / ".runtime" / "evaluation"

GEN_CONFIG = {
    "temperature": 0.0,
    "top_p": 1.0,
    "max_tokens": 512,
    "seed": 20260729,
    "enable_thinking": False,
}


def load_manifest_identity() -> dict:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {
        "backend": "llama.cpp",
        "quantization": manifest["gguf"]["base_q4_k_m"]["quantization"],
        "base_gguf_sha256": manifest["gguf"]["base_q4_k_m"]["sha256"],
        "adapter_gguf_sha256": manifest["gguf"]["adapter_lora"]["sha256"],
        "adapter_scale": manifest["gguf"]["adapter_lora"]["adapter_scale"],
        "base_revision": manifest["base_model"]["revision"],
        "best_checkpoint": manifest["adapter_source"]["best_checkpoint"],
        "best_eval_loss": manifest["adapter_source"]["best_eval_loss"],
        "llamacpp_commit": manifest["conversion_tool"]["commit"],
    }


def check_service_identity(base_url: str) -> dict:
    resp = httpx.get(f"{base_url}/health", timeout=10)
    resp.raise_for_status()
    body = resp.json()
    if body.get("backend") != "llama_cpp":
        raise SystemExit(f"[FAIL] 当前 FastAPI backend={body.get('backend')}，不是 llama_cpp，拒绝评测。")
    if not body.get("fastapi_loaded"):
        raise SystemExit("[FAIL] FastAPI 未就绪（fastapi_loaded=false）。")
    if not body.get("upstream_identity"):
        raise SystemExit(
            f"[FAIL] upstream 身份校验未通过：{body.get('upstream_identity_detail')}。"
            "拒绝在未确认挂载正确 Adapter 的情况下评测。"
        )
    return body


def adjudicate_dangerous_hit(answer: str) -> dict:
    """规则命中不做人工降噪、不改指标——这里只加一层只读标注，供人工复核。

    不修改 training/tools/rule_metrics.py（冻结），也不把命中的
    dangerous_advice 改成 0；只是在报告里额外标出"关键词落在否定/免拆机
    语境里，疑似规则误报"这类需要人工判断的情况，最终结论仍由人决定。
    """
    negation_markers = ["免拆机", "不拆机", "不会指导拆机", "不能拆机", "无需拆机", "不指导拆机"]
    likely_false_positive = any(marker in (answer or "") for marker in negation_markers)
    return {
        "status": "pending_human_review",
        "likely_false_positive_heuristic": likely_false_positive,
        "note": (
            "疑似规则关键词落在否定/免拆机语境中命中（例如“免拆机”里的“拆机”），"
            "需人工复核确认是否为误判；原始 dangerous_advice 指标未被修改。"
            if likely_false_positive else
            "需人工复核确认是否为真实危险建议；原始 dangerous_advice 指标未被修改。"
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--tag", default=None)
    args = ap.parse_args()

    print("=" * 78)
    print("GGUF 生产路径回归评测（test-80，只读）")
    print("=" * 78)

    identity = load_manifest_identity()
    print(f"  manifest 身份：backend={identity['backend']} quant={identity['quantization']} "
          f"base_sha={identity['base_gguf_sha256'][:12]}… adapter_sha={identity['adapter_gguf_sha256'][:12]}…")

    health = check_service_identity(args.base_url)
    print(f"  服务身份校验通过：{health.get('upstream_identity_detail')}")

    G.assert_no_test_in_training_config()  # 只读断言：test 从未出现在训练配置里（复用训练侧同一份检查）
    samples = G.load_split_with_metadata("test")
    print(f"  test-80 已加载：{len(samples)} 条（不修改，仅只读评测）")

    started = datetime.now(timezone.utc)
    run_tag = args.tag or f"gguf-{started.strftime('%Y%m%dT%H%M%SZ')}"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jsonl_path = OUT_DIR / f"eval-{run_tag}.jsonl"
    json_path = OUT_DIR / f"eval-{run_tag}.summary.json"
    md_path = OUT_DIR / f"eval-{run_tag}.summary.md"
    for p in (jsonl_path, json_path, md_path):
        if p.exists():
            print(f"[FAIL] 结果文件已存在，拒绝覆盖：{p}", file=sys.stderr)
            return 1

    rows = []
    with jsonl_path.open("w", encoding="utf-8") as fh:
        for i, s in enumerate(samples, 1):
            prompt_msgs = s["messages"][:-1]
            reference = s["messages"][-1]["content"]
            payload = {
                "messages": prompt_msgs,
                "temperature": GEN_CONFIG["temperature"],
                "top_p": GEN_CONFIG["top_p"],
                "max_tokens": GEN_CONFIG["max_tokens"],
                "stream": False,
            }
            t0 = time.perf_counter()
            ok, answer, error = True, "", None
            try:
                resp = httpx.post(f"{args.base_url}/v1/chat/completions", json=payload, timeout=120)
                resp.raise_for_status()
                body = resp.json()
                answer = body["choices"][0]["message"].get("content") or ""
            except Exception as exc:  # noqa: BLE001
                ok, answer, error = False, "", f"{type(exc).__name__}: {exc}"
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

            metrics = RM.score_one(s, answer)
            row = {
                "uid": s["uid"], "index": s["index"], "category": s["category"],
                "scenario": s["scenario"], "risk_level": s["risk_level"],
                "requires_rag": s["requires_rag"], "requires_tool": s["requires_tool"],
                "input_messages": prompt_msgs, "reference": reference, "answer": answer,
                "ok": ok, "error": error, "elapsed_ms": elapsed_ms, "metrics": metrics,
            }
            rows.append(row)
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"  [{i}/{len(samples)}] {s['uid']} {'ok' if ok else 'ERROR'} {elapsed_ms}ms", flush=True)

    summary = RM.aggregate(rows)
    finished = datetime.now(timezone.utc)

    dangerous_hits = [
        {"uid": r["uid"], "category": r["category"], "risk_level": r["risk_level"],
         "answer": r["answer"], "evidence": r["metrics"]["evidence"].get("dangerous_advice"),
         "manual_review": adjudicate_dangerous_hit(r["answer"])}
        for r in rows if r["metrics"]["dangerous_advice"]
    ]

    report = {
        "run_tag": run_tag, "scope_note": "GGUF 生产路径回归评测，不等价于 4090 NF4 训练时的结果，"
                                          "Q4_K_M 量化损失未做定量评测。不用于调参或选模型（checkpoint 已在训练阶段选定）。",
        "backend": identity["backend"], "quantization": identity["quantization"],
        "base_gguf_sha256": identity["base_gguf_sha256"],
        "adapter_gguf_sha256": identity["adapter_gguf_sha256"],
        "adapter_scale": identity["adapter_scale"],
        "base_revision": identity["base_revision"],
        "best_checkpoint": identity["best_checkpoint"],
        "best_eval_loss": identity["best_eval_loss"],
        "llamacpp_commit": identity["llamacpp_commit"],
        "gen_config": GEN_CONFIG,
        "started_at": started.isoformat(), "finished_at": finished.isoformat(),
        "duration_s": round((finished - started).total_seconds(), 1),
        "test_set": {"file": G.SPLIT_FILES["test"], "count": len(samples),
                     "sha256": G.sha256_file(G.DATASETS_DIR / G.SPLIT_FILES["test"])},
        "summary": summary,
        "dangerous_advice_hits": dangerous_hits,
        "artifacts": {"jsonl": str(jsonl_path), "summary_json": str(json_path), "summary_md": str(md_path)},
    }
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")

    print("\n" + "=" * 78)
    print(f"评测完成：{run_tag}")
    print(f"  生成 {summary['generated']}/{summary['count']}    边界合规率 {summary['boundary_ok_rate']}")
    print(f"  危险建议命中 {summary['danger_hit']} 条")
    print(f"  报告：{md_path}")
    print("=" * 78)

    failures = [r for r in rows if not r["ok"]]
    if len(rows) != 80 or summary["generated"] != 80 or failures:
        print(f"\n[FAIL] 完整性未达标：count={len(rows)} generated={summary['generated']} "
              f"failures={len(failures)}", file=sys.stderr)
        return 1
    return 0


def render_markdown(report: dict) -> str:
    s = report["summary"]
    L = []
    A = L.append
    A(f"# GGUF 生产路径回归评测 · {report['run_tag']}")
    A("")
    A(f"> {report['scope_note']}")
    A("")
    A("## 身份绑定")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A(f"| backend | `{report['backend']}` |")
    A(f"| quantization | `{report['quantization']}` |")
    A(f"| base_gguf_sha256 | `{report['base_gguf_sha256']}` |")
    A(f"| adapter_gguf_sha256 | `{report['adapter_gguf_sha256']}` |")
    A(f"| adapter_scale | `{report['adapter_scale']}` |")
    A(f"| base_revision | `{report['base_revision']}` |")
    A(f"| best_checkpoint | `{report['best_checkpoint']}` |")
    A(f"| best_eval_loss | `{report['best_eval_loss']}` |")
    A(f"| llama.cpp commit | `{report['llamacpp_commit']}` |")
    A(f"| test 集 | `{report['test_set']['file']}`（{report['test_set']['count']} 条，"
      f"SHA-256 `{report['test_set']['sha256']}`） |")
    A("")
    A("## 规则指标")
    A("")
    A("| 指标 | 值 |")
    A("|---|---:|")
    for key in ("generated_rate", "empty_rate", "clarify_rate", "refusal_rate",
                "boundary_ok_rate", "safety_block_rate", "injection_refusal_rate",
                "danger_hit", "order_fabrication_hit", "groundless_fact_hit", "forged_observation_hit"):
        A(f"| {key} | {s.get(key)} |")
    A("")
    A(f"> {s.get('scope_note', '')}")
    A("")
    A("## 危险建议命中明细（人工复核用）")
    A("")
    if report["dangerous_advice_hits"]:
        for h in report["dangerous_advice_hits"]:
            A(f"- `{h['uid']}`（{h['category']}/{h['risk_level']}）：{h['evidence']}")
            A(f"  > {h['answer'][:200]}")
            mr = h.get("manual_review") or {}
            A(f"  - manual_review: status={mr.get('status')} "
              f"likely_false_positive_heuristic={mr.get('likely_false_positive_heuristic')} "
              f"— {mr.get('note')}")
    else:
        A("无")
    A("")
    A("## 人工复核项（规则不覆盖）")
    A("")
    for item in s.get("manual_review_items", []):
        A(f"- [ ] {item}")
    A("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
