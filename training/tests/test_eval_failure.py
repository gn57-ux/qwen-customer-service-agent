#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模拟评测中途单条抛异常：报告必须照常落盘，进程必须非零退出。

做法：把 evaluate.generate 换成"第 N 条抛异常"的桩函数，同时绕开真实模型加载
（monkeypatch load_model / build_prompt），因此本测试不需要 CUDA 或权重。
"""
import json
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import evaluate as EV  # noqa: E402

FAILED = []


def check(name, cond, detail=""):
    print(f"    {'ok  ' if cond else 'FAIL'} {name}" + (f" :: {detail}" if detail and not cond else ""))
    if not cond:
        FAILED.append(name)


FAIL_AT = 37          # 第 37 条抛异常
CALLS = {"n": 0}


def fake_load_model(mode, adapter_path):
    return object(), object(), {"base_path": "/fake/Qwen3-8B", "revision": "deadbeef",
                                "adapter_path": adapter_path, "adapter_config": None}


def fake_build_prompt(tok, messages):
    return "PROMPT"


def fake_generate(tok, model, prompt):
    CALLS["n"] += 1
    if CALLS["n"] == FAIL_AT:
        raise RuntimeError("模拟：CUDA out of memory")
    if CALLS["n"] == 5:
        return ""          # 空回答：必须如实记入指标，但不算"异常"
    return "好的，请提供订单号，我核对后告诉您。"


EV.load_model = fake_load_model
EV.build_prompt = fake_build_prompt
EV.generate = fake_generate

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "eval"
    sys.argv = ["evaluate.py", "--mode", "base", "--output-dir", str(out), "--tag", "faultsim"]
    rc = EV.main()

    check("单条异常时退出码非零", rc != 0, f"rc={rc}")

    jsonl = out / "eval-faultsim.jsonl"
    summary = out / "eval-faultsim.summary.json"
    md = out / "eval-faultsim.summary.md"
    check("JSONL 仍然生成", jsonl.is_file())
    check("summary.json 仍然生成", summary.is_file())
    check("summary.md 仍然生成", md.is_file())

    if jsonl.is_file():
        rows = [json.loads(l) for l in jsonl.read_text(encoding="utf-8").splitlines()]
        check("明细条数为 80", len(rows) == 80, str(len(rows)))
        errs = [r for r in rows if not r["ok"]]
        check("异常条目被如实记录", len(errs) == 1, str(len(errs)))
        check("异常原因写入报告",
              bool(errs) and "out of memory" in (errs[0]["error"] or ""),
              str(errs[:1]))

    if summary.is_file():
        rep = json.loads(summary.read_text(encoding="utf-8"))
        s = rep["summary"]
        check("count=80", s["count"] == 80, str(s["count"]))
        check("generated=79（异常未被吞掉）", s["generated"] == 79, str(s["generated"]))
        check("空回答如实计入 empty_rate", s["empty_rate"] > 0, str(s["empty_rate"]))
        check("单条异常时 usable_for_comparison=false", rep["usable_for_comparison"] is False)

# ---- 全部成功时必须返回 0 -------------------------------------------------
CALLS["n"] = 0
FAIL_AT = -1


def fake_generate_ok(tok, model, prompt):
    CALLS["n"] += 1
    return "好的，请提供订单号，我核对后告诉您。"


EV.generate = fake_generate_ok
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "eval"
    sys.argv = ["evaluate.py", "--mode", "base", "--output-dir", str(out), "--tag", "allok"]
    rc = EV.main()
    check("全部成功时退出码为 0", rc == 0, f"rc={rc}")
    rep = json.loads((out / "eval-allok.summary.json").read_text(encoding="utf-8"))
    check("generated=80", rep["summary"]["generated"] == 80)
    check("全部成功时 usable_for_comparison=true", rep["usable_for_comparison"] is True)

    # 不覆盖既有结果
    sys.argv = ["evaluate.py", "--mode", "base", "--output-dir", str(out), "--tag", "allok"]
    rc2 = EV.main()
    check("同名结果拒绝覆盖", rc2 == 1, f"rc={rc2}")

print(f"\n    小结：{'全部通过' if not FAILED else f'{len(FAILED)} 项失败 {FAILED}'}")
sys.exit(1 if FAILED else 0)
