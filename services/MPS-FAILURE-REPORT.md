# PyTorch + PEFT + MPS bf16 推理失败证据报告

## 结论

**PyTorch + PEFT 全精度（bf16）推理在本机（Apple M5，32GB 统一内存）不能安全运行。**
加载能成功，但加载完成后系统立即从充裕可用内存跌到个位数 GB，生成阶段内存压力升至
critical，探测进程被看门狗强制终止。**没有完成任何一次生成，不能宣称 PyTorch/MPS
推理成功。**

这不是偶发波动：受控探测在后台环境干净（已停 Reranker/Ollama）、启动前可用内存
21.977GB 的条件下复现了同一结果，说明问题来自加载路径本身的内存开销，而不是背景应用
争抢内存。

## 探测方法

- 脚本：`services/minimal_mps_probe.py`
- 单进程、单条问题、`max_new_tokens=32`、`temperature=0`、`enable_thinking=false`、不并发
- 只调用正式 `model_runtime.load_model()` 与 `app.generate_reply_sync()`，不启动 FastAPI 常驻服务
- 加载策略：`device_map={"": "mps"}` + `low_cpu_mem_usage=True`（**未**使用
  "先完整 CPU 加载再 `.to('mps')`" 的方式，避免两份权重同时驻留）
- 独立看门狗线程每 2 秒采样一次，触发条件（任一即发）：内存压力等级进入 critical；
  可用内存连续两次采样（约 4 秒）低于 2GB；swap 相对启动前新增超过 8GB。
  触发后**先落盘报告再发送 SIGTERM**，只触发一次，不自动重试

## 关键数据

| 阶段 | 可用内存 | 内存压力等级 | 说明 |
|---|---:|---|---|
| 启动前（baseline） | 21.977 GB | normal | 满足门槛，后台环境干净 |
| 加载完成后 | 5.959 GB | warn | 骤降约 16GB，与 16GB bf16 权重量级吻合 |
| 看门狗触发时 | 3.055 GB | **critical** | 生成刚开始不久即触发 |

| 指标 | 数值 |
|---|---:|
| swap 相对启动前新增 | 7.95 GB |
| `torch.mps.current_allocated_memory()`（加载后） | ≈0.18 GB |
| `torch.mps.driver_allocated_memory()`（加载后） | **≈29.75 GB** |
| 加载耗时 | 11.47 秒 |
| device / dtype | `mps` / `bfloat16`（启动探测通过，未降级 fp16） |

**`driver_allocated_bytes`（≈29.75GB）远大于 `current_allocated_bytes`（≈0.18GB）**，
也远大于 16GB 权重本身——MPS 驱动层为这次加载预留/缓存的统一内存开销接近权重体积的
两倍。这是本机 32GB 统一内存下触发 critical 压力的直接原因。

## 判定

| 指标 | 结果 |
|---|---|
| 模型能否加载 | 能，11.47 秒 |
| 能否完成一次真实生成 | **否** |
| verdict | `ABORTED_BY_WATCHDOG` |
| 是否重试 | 否，按指令只执行一次 |
| 是否改用 `.to("mps")` | 否 |
| 是否改用纯 CPU 推理 | 否 |
| 是否删除已有 PyTorch/FastAPI 实现与测试 | 否，全部保留 |

## 后续方向

PyTorch/PEFT backend 保留在代码库中，用于：

- 课程代码验收；
- 未来接入 CUDA 机器时的兼容路径；
- Mac 上显式标记为 `full_precision_mps_unsupported_due_to_memory`，**不再真实加载**。

Mac 上的默认长期推理路径改为 **llama.cpp + Qwen3-8B Q4_K_M GGUF + 独立 LoRA Adapter
（`--lora` 挂载，不融合）**，见 `services/README.md` 的 llama_cpp backend 章节。
