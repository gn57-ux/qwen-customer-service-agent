# Mac 本地推理服务

`services/app.py` 是唯一、跨平台、环境变量驱动的正式入口，支持两个 backend：

| Backend | 用途 | 是否 Mac 默认 |
|---|---|---|
| `llama_cpp` | Qwen3-8B Q4_K_M GGUF + 正式 LoRA Adapter（`--lora` 挂载，不融合），FastAPI 只做网关，真正推理在独立的 `llama-server` 进程里 | **是**（未设置 `LLM_BACKEND` 时的默认值） |
| `pytorch_peft` | PyTorch + Transformers + PEFT，仅用于课程代码验收与未来 CUDA 机器 | 否，必须显式设置 `LLM_BACKEND=pytorch_peft` |

**为什么 Mac 默认改成 llama_cpp**：受控探测证明 PyTorch+PEFT 全精度 MPS 推理在本机
（32GB 统一内存）会在生成阶段触发 critical 内存压力并被看门狗强制终止 —— 完整证据见
[`MPS-FAILURE-REPORT.md`](MPS-FAILURE-REPORT.md)。pytorch_peft backend 的代码与测试全部保留，
只是不再在 Mac 上默认真实加载。

不做：Embedding 接口（由 Ollama `bge-m3` 负责）、RAG、Tool 路由（由后续 Mastra
Agent 负责）。响应结构里保留 `tool_calls` 字段，但本服务不会主动解析/路由工具调用
到真实执行 —— 那属于下一阶段。

## 目录与产物

```text
services/manifests/customer-service-production-v1.gguf.json  # 受控、可提交的 GGUF 身份证据（唯一证据源）

models/                                          # .gitignore 忽略，权重/工具不入库
├── Qwen3-8B/                                     # 基础模型（huggingface-cli download）
├── adapters/customer-service-production-v1/      # 正式 Adapter（safetensors，services/restore_adapter.py 恢复）
│   └── RESTORE-VERIFICATION.json                 # 恢复时的 SHA-256 校验报告
├── gguf/qwen3-8b-production-v1/
│   ├── qwen3-8b-production-v1-f16.gguf           # 中间产物（量化前，不自动删除）
│   ├── qwen3-8b-production-v1-Q4_K_M.gguf        # llama_cpp backend 实际加载的 Base
│   ├── customer-service-production-v1-lora.gguf  # llama_cpp backend 实际加载的 Adapter（--lora）
│   └── gguf-manifest.candidate.json              # convert-gguf.sh 生成的候选文件（未经人工核对，不是证据源）
└── tools/llama.cpp-<短commit>/                    # 与已安装 llama-server 同 commit 的转换脚本（GitHub 源码包）
```

`services/manifests/customer-service-production-v1.gguf.json` 是**唯一证据源**——
换机器 `git clone` 后即使 `models/` 完全空也能看到这份身份记录；`models/gguf/` 下的
文件只是本机的实际权重，必须与受控 manifest 的 SHA-256 一致才允许启动。

## llama_cpp backend（Mac 默认）

### 一次性准备：转换 GGUF

前提：已用 `huggingface-cli download` 拿到固定 revision 的 `models/Qwen3-8B`，
已用 `services/restore_adapter.py` 恢复 `models/adapters/customer-service-production-v1`
（生成 `RESTORE-VERIFICATION.json`，`verdict` 必须是 `PASS`）。

```bash
# 转换脚本必须与已安装 llama-server/llama-quantize 同一 commit（Homebrew 只装二进制，
# 不带 convert_*.py），从 GitHub 按固定 commit 取源码，放 models/tools/（已 gitignore）：
LLAMACPP_COMMIT=11b068d06605288ce7917534b46d52b47823dc13   # 与已安装 llama-server 的 commit 一致
curl -sL -o /tmp/llamacpp.tar.gz \
  "https://github.com/ggml-org/llama.cpp/archive/${LLAMACPP_COMMIT}.tar.gz"
mkdir -p /tmp/llamacpp-extract
tar -xzf /tmp/llamacpp.tar.gz -C /tmp/llamacpp-extract \
  "llama.cpp-${LLAMACPP_COMMIT}/convert_hf_to_gguf.py" \
  "llama.cpp-${LLAMACPP_COMMIT}/convert_lora_to_gguf.py" \
  "llama.cpp-${LLAMACPP_COMMIT}/gguf-py" \
  "llama.cpp-${LLAMACPP_COMMIT}/conversion" \
  "llama.cpp-${LLAMACPP_COMMIT}/requirements/requirements-convert_hf_to_gguf.txt" \
  "llama.cpp-${LLAMACPP_COMMIT}/requirements/requirements-convert_lora_to_gguf.txt" \
  "llama.cpp-${LLAMACPP_COMMIT}/LICENSE"
mv "/tmp/llamacpp-extract/llama.cpp-${LLAMACPP_COMMIT}" \
   "models/tools/llama.cpp-${LLAMACPP_COMMIT:0:9}"

.venv/bin/pip install -r requirements-gguf-convert.txt   # 精确锁定的 sentencepiece==0.2.2

bash services/convert-gguf.sh
```

`convert-gguf.sh` 会先做六项前置校验（commit 一致、转换脚本已就绪、sentencepiece
已装、Base revision 通过、Adapter 恢复报告 `verdict=PASS`、输出目录不存在或为空），
**任一不满足即 exit 1，不跳过**。转换成功后只生成
`models/gguf/qwen3-8b-production-v1/gguf-manifest.candidate.json`，**不会自动覆盖**
`services/manifests/customer-service-production-v1.gguf.json`——人工核对候选文件内容
无误后再手动合并进受控 manifest。不自动删除 F16 中间产物。

只测试拒绝分支、不真正跑转换：`bash services/convert-gguf.selftest.sh`。

### 启动

```bash
bash services/llama-server-up.sh     # 内部推理进程，只监听 127.0.0.1:8002
bash services/start.sh               # FastAPI 网关，127.0.0.1:8000（唯一对外入口）

bash services/llama-server-status.sh
bash services/llama-server-down.sh
bash services/stop.sh
```

`llama-server-up.sh` 与 `start.sh` 的"已运行实例识别"与"就绪判定"都不止查 HTTP 200：

1. 启动前先跑 manifest 硬校验（`services/check_llama_server_identity.py --mode manifest`）：
   manifest 缺失/不可解析/字段缺失/SHA 不符/revision 不符/`adapter_scale≠1.0`
   —— 任一失败 `exit 1`，不允许跳过。
2. `llama-server` 健康后，进一步做 **upstream 身份校验**
   （`--mode upstream`：`GET /health` → `GET /lora-adapters` 确认挂载的正是这份
   Adapter 且 `scale=1.0` → `GET /props` 确认 `reasoning_format=none`）——
   证明 8002 上跑的不是"健康但没挂对 LoRA"的实例。**这项校验刚启动完成时要跑一次，
   识别"已在运行的实例"时也要重新跑一次，不是只看 PID/端口/health。**
3. `start.sh` 同理：不只看 HTTP 200，用 `services/check_fastapi_ready.py` 解析
   `/health` 并核对 `backend`/`fastapi_loaded`/`upstream_health`/`upstream_identity`/
   `adapter_scale`，再拿 manifest 文件独立复核 `/health` 上报的两个 SHA-256
   （不只信任 FastAPI 自己的内存状态）。

`llama-server-down.sh` 与 `stop.sh` 停止前都要求命令行**同时**匹配多项身份标识
（`llama-server`/uvicorn 关键词 + Base/LoRA basename 或 app 标识 + 端口），
manifest 存在但解析失败时直接拒绝停止（不会静默退化成弱校验）；
SIGTERM 超时后的 SIGKILL 会重新做一次身份校验才执行，防止等待期间 PID 被复用。
不使用 `pkill -f` 之类宽泛方式误杀无关进程。

沙箱自检（不碰真实 8000/8002 端口与真实 PID 文件）：

```bash
bash services/llama-server-up.selftest.sh
bash services/stop-scripts.selftest.sh
```

### llama-server 启动参数

`--model <Q4_K_M> --lora <lora.gguf> --host 127.0.0.1 --port 8002 --ctx-size 4096
--parallel 1 --reasoning off`（`--reasoning off` 对应 `enable_thinking=false`，与训练态
qwen3_nothink 一致）。`--lora` 默认 scale=1.0，与 manifest 记录一致，运行时用
`GET /lora-adapters` 复核。

## pytorch_peft backend（显式配置，Mac 上不建议真实启用）

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-mac.txt   # 不要用 requirements.txt，含 bitsandbytes（CUDA-only）

LLM_BACKEND=pytorch_peft bash services/start.sh
```

Adapter 恢复、Base 下载、revision 核验命令与 llama_cpp backend 共用同一份
`models/Qwen3-8B`、`models/adapters/customer-service-production-v1`：

```bash
.venv/bin/python services/restore_adapter.py \
    --tar /path/to/customer-service-production-v1-*.tar.gz \
    --manifest /path/to/customer-service-production-v1-*.manifest.json \
    --dest models/adapters/customer-service-production-v1 \
    --expect-base-revision b968826d9c46dd6066d109eabc6255188de91218

.venv/bin/huggingface-cli download Qwen/Qwen3-8B \
    --revision b968826d9c46dd6066d109eabc6255188de91218 \
    --local-dir models/Qwen3-8B

.venv/bin/python training/tools/verify_model_revision.py \
    --model-dir models/Qwen3-8B \
    --expect b968826d9c46dd6066d109eabc6255188de91218 \
    --json-out /tmp/base-revision-verify.json
```

诊断脚本（人工运行，不是 pytest 用例）：

```bash
.venv/bin/python services/test-model-load.py       # 完整加载 + 一次最小生成
.venv/bin/python services/minimal_mps_probe.py     # 单条问题、带内存看门狗的受控探测
```

## 配置（环境变量，见 `.env.example`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BACKEND` | `llama_cpp` | `llama_cpp`（Mac 默认）或 `pytorch_peft`（必须显式设置） |
| `LLAMA_CPP_BASE_URL` | `http://127.0.0.1:8002` | llama_cpp backend 转发目标 |
| `GGUF_DIR` | `models/gguf/qwen3-8b-production-v1` | GGUF 权重文件目录 |
| `GGUF_MANIFEST_PATH` | `services/manifests/customer-service-production-v1.gguf.json` | 受控 manifest（唯一证据源） |
| `ADAPTER_SCALE` | `1.0` | LoRA 挂载比例，manifest 与 upstream 均会校验等于此值 |
| `BASE_MODEL_PATH` / `ADAPTER_PATH` | `models/Qwen3-8B` / `models/adapters/...` | pytorch_peft backend 使用 |
| `EXPECTED_BASE_REVISION` | `b968826d9c46dd6066d109eabc6255188de91218` | 固定 revision，不接受 latest，两个 backend 共用 |
| `DEVICE` / `DTYPE` | `auto` / `auto` | 仅 pytorch_peft；`auto` 会先实测 bf16，不可用才显式降级 `float16` |
| `MAX_TOKENS_CEILING` | `1024` | 单请求生成上限 |
| `MAX_INPUT_TOKENS` | `4096` | 输入 prompt token 上限（仅 pytorch_peft，需要真实 tokenizer 计数） |
| `MAX_MESSAGES` | `64` | 单请求消息条数上限 |
| `ENABLE_THINKING` | `false` | qwen3_nothink 非思考模式，与训练态一致 |
| `APP_ENV` + `CS_SKIP_MODEL_LOAD` | — | 两者都设置才跳过真实加载；生产环境单独设 `CS_SKIP_MODEL_LOAD` 无效 |

## 接口（两个 backend 共用同一套路由）

- `GET /health` —
  - 两者共有：`backend`、`fastapi_loaded`、`load_error`、`model_name`、`best_checkpoint`、
    `best_eval_loss`、`enable_thinking`
  - `llama_cpp`：额外有 `upstream_health`、`upstream_identity`、
    `upstream_identity_detail`、`upstream_url`、`base_gguf_sha256`、
    `adapter_gguf_sha256`、`adapter_gguf_basename`、`adapter_scale`、`base_revision`。
    `status` 只有在 `fastapi_loaded` 且 `upstream_identity` 都为真时才是 `ok`，
    身份校验不过是 `degraded`。
  - `pytorch_peft`：额外有 `device`、`dtype`、`dtype_reason`、`mps_available`、
    `peak_rss_gb`、`peak_device_memory_gb`、`mps_status_note`（固定标注
    `full_precision_mps_unsupported_due_to_memory`）
- `GET /v1/models`
- `POST /v1/chat/completions` — OpenAI 兼容，非流式与流式（`stream: true`）
- `POST /chat` — 简化协议：`{"message": str, "history"?: [...]}` → `{"reply": str, "usage": {...}}`

### 流式说明

- `llama_cpp`：`services/llama_cpp_backend.py:open_stream_chat_completion()` **先建立
  并验证上游响应状态**——非 2xx 直接让路由返回 `502`，不会先给客户端 200 再在流里才报错；
  成功后用 `httpx` 的异步流式请求逐块透明转发 `llama-server` 自己的 SSE 输出，
  **不在 FastAPI 侧攒完整段再切块**。客户端断开或消费完毕时，底层
  `httpx.Response`/`AsyncClient` 都会被关闭，不泄漏连接。
- `pytorch_peft`：用 `transformers.TextIteratorStreamer` 在后台线程跑 `model.generate()`，
  主协程通过 `asyncio.Queue` 桥接逐个 token 片段转发为 SSE —— 是真正的逐 token 流式，
  不是整段生成后按字符/句子切块冒充流式。

`/health` 的 `streaming_mode` 字段如实标注当前 backend 实际使用的流式实现。

## 加载/请求失败必须明确失败

**启动时一次性校验**（失败即拒绝启动，不吞异常）：
- `llama_cpp`：`services/llama_cpp_backend.py:load_llama_cpp_backend()` 校验受控
  manifest（`GGUF_MANIFEST_PATH`）存在且可解析、`base_model.revision` 等于期望值、
  `adapter_lora.adapter_scale` 等于期望值、Base/Adapter GGUF 文件存在、SHA-256 与
  manifest 一致——**manifest 里必须有 `adapter_lora` 字段**，没有 Adapter 就不允许
  启动并自称 production（不存在 Base-only 冒充路径）。
- `pytorch_peft`：`services/model_runtime.py:load_model()` 依次校验 revision
  （`revision_check.py`）→ Adapter（`adapter_check.py`，同样拒绝 `smoke` 路径）→
  才会调用 `transformers`/`peft` 加载真实权重。

**运行时状态**（不影响 FastAPI 自身是否已启动）：
- `llama_cpp`：每个请求处理前都会重新做一次 `check_upstream_identity()`——不只是
  `llama-server` 可达，还要证明它挂载的确实是这份 Adapter、`scale=1.0`、
  `reasoning` 已关闭。任一不符，`/v1/chat/completions` 与 `/chat` 都返回 `503`，
  绝不会把请求转发给一个"健康但没挂对 LoRA"的实例。`/health` 的 `status` 同步
  变成 `degraded`。

**没有任何"找不到就换个目录试试"的自动回退逻辑**——两个 backend 的加载函数源码里都不存在。

## 测试

```bash
.venv/bin/python -m pytest services/tests/ -v          # 全部不需要真实模型/真实 llama-server
bash services/llama-server-up.selftest.sh               # llama-server-up.sh 沙箱化 PID/命令行/SHA 自检
bash services/stop-scripts.selftest.sh                   # down.sh/stop.sh 的 PID 复用/部分匹配自检
bash services/convert-gguf.selftest.sh                    # convert-gguf.sh 的拒绝分支自检（不真正转换）
```

真实验证（需要先完成 GGUF 转换或 Base+Adapter 恢复）：

```bash
bash services/llama-server-up.sh && bash services/start.sh   # llama_cpp backend 真实启动
.venv/bin/python services/test-model-load.py                  # pytorch_peft 真实加载诊断（人工运行）
.venv/bin/python services/minimal_mps_probe.py                 # pytorch_peft 受控探测（人工运行）
```

## GGUF 生产路径回归评测（test-80）

```bash
.venv/bin/python services/evaluate_gguf.py
```

只读评测冻结的 `datasets/customer-service-test-80.json`，走真实 FastAPI（llama_cpp
backend），产物写入 `services/.runtime/evaluation/`，不覆盖既有结果，失败条目仍会
保存但整体退出非零。详见脚本内说明与 Review 报告里的危险建议命中明细。
