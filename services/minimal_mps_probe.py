#!/usr/bin/env python3
"""受控 MPS 最小验证：单进程、单条问题、max_new_tokens=32，带内存看门狗。

只调用正式 model_runtime.load_model() 与 app.generate_reply_sync()，
不启动 FastAPI 常驻服务，不并发。

看门狗独立线程，每 2 秒采样一次，触发条件（任一即发）：
  - kern.memorystatus_vm_pressure_level 进入 critical（4）；
  - 可用内存连续 2 次采样（间隔 2 秒，即持续 ~4 秒）低于 2GB；
  - swap 已用量相对启动前快照新增超过 8GB。
触发后：先把已采集的全部快照与"看门狗触发"记录写盘，再对本进程发 SIGTERM。
只触发一次（thread 用 Event 上锁，不重复触发、不自动重试）。

加载策略维持 device_map={"": "mps"} + low_cpu_mem_usage=True，不改为
"先完整 CPU 加载再 .to('mps')"（后者会导致 CPU 与 MPS 权重同时存在，峰值更危险）。
"""

from __future__ import annotations

import json
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import psutil  # noqa: E402

QUESTION = "我的订单怎么还没到？"
MAX_NEW_TOKENS = 32
AVAILABLE_MEM_CRITICAL_BYTES = 2 * 1024 ** 3
SWAP_GROWTH_CRITICAL_BYTES = 8 * 1024 ** 3
WATCHDOG_INTERVAL_S = 2.0
LOW_MEM_SUSTAIN_CHECKS = 2  # 连续 2 次（间隔 2s，约持续 4s）才判定"持续低于 2GB"

REPORT_PATH = Path(__file__).resolve().parent / ".runtime" / "minimal-mps-probe-report.json"


def prepare_probe_messages():
    """构造本次探测要发送的消息，**必须**先经过 app.ensure_system_prompt()。

    独立成函数是为了能在不加载模型的情况下单测：受控真实推理也不能绕过
    服务端不可替换的安全 Prompt。本探测不提供调用方 system，因此最终第一条
    消息就是 DEFAULT_SYSTEM_PROMPT 本身。
    """
    from app import ChatMessage, ensure_system_prompt

    raw_messages = [ChatMessage(role="user", content=QUESTION)]
    return ensure_system_prompt(raw_messages)


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception as exc:
        return f"<命令失败: {exc}>"


def _swap_used_bytes() -> float:
    out = _run(["sysctl", "-n", "vm.swapusage"])
    # 形如：total = 20480.00M  used = 19175.56M  free = 1304.44M  (encrypted)
    try:
        used_part = [p for p in out.split() if p.startswith("used")]
        idx = out.split().index("used")
        val = out.split()[idx + 2]  # "19175.56M"
        return float(val.rstrip("M")) * 1024 * 1024
    except Exception:
        return -1.0


def _pressure_level() -> int:
    out = _run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"])
    try:
        return int(out.strip())
    except Exception:
        return -1


def top_processes(n: int = 15) -> list[dict]:
    procs = []
    for p in psutil.process_iter(["pid", "name", "username", "memory_info"]):
        try:
            info = p.info
            rss = info["memory_info"].rss if info["memory_info"] else 0
            procs.append({"pid": info["pid"], "name": info["name"], "rss_bytes": rss})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: x["rss_bytes"], reverse=True)
    return procs[:n]


def snapshot(label: str) -> dict:
    vm = psutil.virtual_memory()
    proc = psutil.Process()
    return {
        "label": label,
        "at": datetime.now(timezone.utc).isoformat(),
        "vm_stat": _run(["vm_stat"]),
        "swapusage_raw": _run(["sysctl", "vm.swapusage"]),
        "swap_used_bytes": _swap_used_bytes(),
        "memory_pressure_level_raw": _pressure_level(),
        "memory_pressure_free_pct": _run(["memory_pressure"]),
        "available_bytes": vm.available,
        "available_gb": round(vm.available / (1024 ** 3), 3),
        "percent_used": vm.percent,
        "process_rss_bytes": proc.memory_info().rss,
        "process_rss_gb": round(proc.memory_info().rss / (1024 ** 3), 3),
        "top_processes": top_processes(15),
    }


def mps_memory_snapshot() -> dict:
    try:
        import torch

        if not torch.backends.mps.is_available():
            return {"available": False}
        return {
            "available": True,
            "current_allocated_bytes": torch.mps.current_allocated_memory(),
            "driver_allocated_bytes": torch.mps.driver_allocated_memory(),
        }
    except Exception as exc:
        return {"available": False, "error": str(exc)}


class Watchdog:
    def __init__(self, baseline_swap_used: float, report: dict):
        self.baseline_swap_used = baseline_swap_used
        self.report = report
        self._stop = threading.Event()
        self._triggered = threading.Event()
        self._low_mem_streak = 0
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self._stop.set()
        self.thread.join(timeout=5)

    def triggered(self) -> bool:
        return self._triggered.is_set()

    def _run(self):
        while not self._stop.is_set():
            time.sleep(WATCHDOG_INTERVAL_S)
            if self._triggered.is_set():
                return

            vm = psutil.virtual_memory()
            pressure = _pressure_level()
            swap_used = _swap_used_bytes()
            swap_growth = (swap_used - self.baseline_swap_used) if swap_used >= 0 else -1

            reason = None
            if pressure == 4:
                reason = f"memory_pressure_level={pressure}（critical）"
            elif vm.available < AVAILABLE_MEM_CRITICAL_BYTES:
                self._low_mem_streak += 1
                if self._low_mem_streak >= LOW_MEM_SUSTAIN_CHECKS:
                    reason = (
                        f"可用内存连续 {self._low_mem_streak} 次采样低于 2GB"
                        f"（当前 {vm.available / (1024**3):.2f} GB）"
                    )
            else:
                self._low_mem_streak = 0

            if reason is None and swap_growth > SWAP_GROWTH_CRITICAL_BYTES:
                reason = f"swap 相对启动前新增 {swap_growth / (1024**3):.2f} GB（>8GB 阈值）"

            if reason:
                self._triggered.set()
                self.report["watchdog_triggered"] = {
                    "reason": reason,
                    "at": datetime.now(timezone.utc).isoformat(),
                    "snapshot": snapshot("watchdog-trigger"),
                }
                self.report["verdict"] = "ABORTED_BY_WATCHDOG"
                REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
                REPORT_PATH.write_text(
                    json.dumps(self.report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                print(f"\n[WATCHDOG] 触发：{reason}，已保存报告到 {REPORT_PATH}，发送 SIGTERM", flush=True)
                import os

                os.kill(os.getpid(), signal.SIGTERM)
                return


def main() -> int:
    report: dict = {
        "question": QUESTION,
        "max_new_tokens": MAX_NEW_TOKENS,
        "temperature": 0.0,
        "enable_thinking": False,
        "device_strategy": "device_map={'': device} + low_cpu_mem_usage=True（未改用 .to('mps')）",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    print("=" * 78)
    print("受控 MPS 最小验证：单条问题，max_new_tokens=32")
    print("=" * 78)

    baseline = snapshot("baseline-before-load")
    report["snapshot_baseline"] = baseline
    print(f"启动前可用内存: {baseline['available_gb']} GB")
    print(f"启动前 swap: {baseline['swapusage_raw']}")
    print(f"启动前内存压力等级: {baseline['memory_pressure_level_raw']}（1=normal 2=warn 4=critical）")
    print("启动前后台进程内存前 15 名：")
    for p in baseline["top_processes"]:
        print(f"    pid={p['pid']:>7} rss={p['rss_bytes']/(1024**2):>9.1f}MB  {p['name']}")

    watchdog = Watchdog(baseline_swap_used=baseline["swap_used_bytes"], report=report)
    watchdog.start()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from config import get_settings
        import model_runtime

        settings = get_settings()
        print(f"\n加载模型：base={settings.base_model_path} adapter={settings.adapter_path}")
        load_result = model_runtime.load_model(
            base_model_path=settings.base_model_path,
            adapter_path=settings.adapter_path,
            expected_base_revision=settings.expected_base_revision,
            device_preference="mps",
            dtype_preference="auto",
        )
        if watchdog.triggered():
            report["verdict"] = "ABORTED_BY_WATCHDOG_DURING_LOAD"
            return 1

        report["device"] = load_result.device
        report["dtype"] = load_result.dtype_name
        report["dtype_reason"] = load_result.dtype_reason
        report["load_seconds"] = load_result.load_seconds

        post_load = snapshot("post-load-pre-generate")
        post_load["mps_memory"] = mps_memory_snapshot()
        report["snapshot_post_load"] = post_load
        print(f"\n加载完成：device={load_result.device} dtype={load_result.dtype_name} "
              f"耗时={load_result.load_seconds:.2f}s")
        print(f"加载后可用内存: {post_load['available_gb']} GB")
        print(f"加载后 MPS 内存: {post_load['mps_memory']}")

        if watchdog.triggered():
            report["verdict"] = "ABORTED_BY_WATCHDOG_AFTER_LOAD"
            return 1

        from app import DEFAULT_SYSTEM_PROMPT, build_prompt, generate_reply_sync

        prepared_messages = prepare_probe_messages()
        report["system_prompt_used"] = prepared_messages[0].content
        report["system_prompt_is_default"] = (
            prepared_messages[0].role == "system"
            and prepared_messages[0].content == DEFAULT_SYSTEM_PROMPT
        )

        prompt = build_prompt(load_result.tokenizer, prepared_messages, enable_thinking=False)

        print(f"\n已经过 ensure_system_prompt()：system_prompt_is_default="
              f"{report['system_prompt_is_default']}")
        print(f"\n开始生成（max_new_tokens={MAX_NEW_TOKENS}, temperature=0, 不并发）...")
        t0 = time.perf_counter()
        content, prompt_tokens, completion_tokens = generate_reply_sync(
            load_result.tokenizer, load_result.model, prompt,
            temperature=0.0, top_p=1.0, max_tokens=MAX_NEW_TOKENS,
        )
        elapsed = time.perf_counter() - t0

        if watchdog.triggered():
            report["verdict"] = "ABORTED_BY_WATCHDOG_DURING_GENERATE"
            return 1

        report["generation"] = {
            "elapsed_s": elapsed,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "answer": content,
            "answer_empty": len(content) == 0,
        }

        post_gen = snapshot("post-generate")
        post_gen["mps_memory"] = mps_memory_snapshot()
        report["snapshot_post_generate"] = post_gen

        print(f"\n生成完成：耗时={elapsed:.2f}s prompt_tokens={prompt_tokens} "
              f"completion_tokens={completion_tokens}")
        print(f"回答是否为空: {len(content) == 0}")
        print(f"回答: {content}")
        print(f"生成后可用内存: {post_gen['available_gb']} GB")
        print(f"生成后 MPS 内存: {post_gen['mps_memory']}")
        print(f"生成后进程 RSS: {post_gen['process_rss_gb']} GB")

        report["verdict"] = "PASS"
        return 0

    except Exception as exc:  # noqa: BLE001
        report["verdict"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
        print(f"\n[FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        watchdog.stop()
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n完整报告：{REPORT_PATH}")
        print(f"结论：{report.get('verdict')}")


if __name__ == "__main__":
    sys.exit(main())
