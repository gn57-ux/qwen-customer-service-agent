# 基于 Qwen QLoRA 与 Mastra 的电商客服智能体

这是一个本地运行的电商客服 AI 项目：Qwen3 QLoRA 微调、FastAPI + PyTorch 推理
接口、RAG 知识库（Qdrant + Rerank）、Mastra Agent（确定性路由 + 强制工具 +
安全策略），以及一个完整的 React + Vite 客服工作台前端，端到端闭环。

## 已实现功能

- 使用 LLaMA Factory 对 Qwen3-8B 进行 4-bit NF4 QLoRA 微调
- 加载基础模型与 LoRA Adapter；OpenAI 兼容的 `/v1/chat/completions` 接口，
  支持普通响应、流式响应和 Tool Call
- Mastra Agent：`classifyRoute()` 确定性路由（安全/订单/维修/普通）+
  按路由强制工具调用，不依赖模型自己判断要不要检索/查订单
- RAG 知识库：Qdrant 向量检索 + Reranker 重排，降级语义完整（Reranker 不可用
  时显式标记 `degraded`，不静默吞掉）
- Mock 订单后端与 `queryOrderTool`，覆盖正常运输、物流延误、订单不存在和
  缺少订单号等边界场景；`order.details` 类型化白名单，前端不接触泛型工具结果
- 服务状态聚合探测（`GET /customer-service/status`）：本地模型/知识库/订单
  服务四态（unknown/online/degraded/error），脱敏返回，不暴露内部地址
- **`web-client/`**：完整的 React + Vite + Tailwind 客服工作台 UI（三栏布局、
  流式对话、处理依据面板、四类业务场景差异化渲染、响应式抽屉），详见
  [`web-client/README.md`](web-client/README.md)

## 系统架构

完整的逻辑架构、请求时序、训练流水线、数据职责边界、端口和模型资产说明见
[`docs/项目完整架构.md`](docs/项目完整架构.md)。

```text
坐席
  → web-client（React/Vite 工作台，本地开发默认 :5173）
  → Mastra Studio / 自定义 route（:4111）
  → 电商客服 Agent（确定性路由 + 强制工具）
      ├─ QLoRA FastAPI（:8000）→ llama-server（:8002，内部转发，前端不可直连）
      ├─ searchKnowledgeBaseTool → Qdrant（:6333）+ Ollama Embedding（:11434）+ Reranker（:8787）
      └─ queryOrderTool → Mock Backend（:8001）
```

前端只允许访问 Mastra 服务（:4111），不得直连上述任何下游端口——由
`web-client/scripts/gate-no-direct.sh` 门禁强制。

## 项目目录

```text
.
├─ adapters/                 # 最终 QLoRA Adapter（不包含训练 checkpoint）
├─ configs/                  # LLaMA Factory 训练与推理配置
├─ datasets/                 # 正式 640/80/80 数据、manifest 与审计报告
├─ knowledge/                # RAG 知识库源文档
├─ services/
│  ├─ app.py                 # QLoRA OpenAI 兼容 API（FastAPI，:8000）
│  ├─ mock_backend.py        # Mock 订单接口（:8001）
│  └─ test-model-load.py
├─ mastra-agent/              # Mastra Server（:4111）：RAG / Tools / 自定义 route
│  └─ src/
│     ├─ mastra/
│     │  ├─ agents/           # customerServiceAgent
│     │  ├─ tools/            # searchKnowledgeBaseTool / queryOrderTool
│     │  ├─ routes/           # /customer-service/{chat,stream,status}
│     │  ├─ health/           # 服务状态聚合探测
│     │  └─ contract.ts       # 前后端共享契约的权威定义
│     └─ rag/                 # Qdrant 检索 + Reranker
├─ web-client/                # 客服工作台前端（React + Vite + Tailwind）
│  └─ src/app/                # 详见 web-client/README.md
├─ frontend-workbench/        # Stitch 资产、前端需求/设计/验收文档
├─ training/                  # 4090 八阶段训练与评测流水线
└─ docs/                      # 实施方案与完整架构
```

## 环境

- 训练：Ubuntu 22.04、RTX 4090 24GB、PyTorch 2.7.1+cu126、LLaMA Factory 0.9.5
- 长期运行：Apple Silicon Mac 32GB、llama.cpp Metal、Qwen3-8B Q4_K_M + LoRA GGUF
- 应用：Python 3.11、FastAPI、Node.js、Mastra 1.20.1、React/Vite
- RAG：Qdrant、Ollama bge-m3（1024 维）、bge-reranker-v2-m3

## 启动

完整运行需要按依赖顺序启动 Qdrant、Ollama/bge-m3、Reranker、Mock 后端、
llama-server、FastAPI、Mastra 与前端。模型身份与服务启停必须使用仓库中的
受控脚本，详见：

- [`services/README.md`](services/README.md)
- [`mastra-agent/README-RAG.md`](mastra-agent/README-RAG.md)
- [`mastra-agent/README-AGENT.md`](mastra-agent/README-AGENT.md)
- [`web-client/README.md`](web-client/README.md)

### 启动前端工作台

```bash
cd web-client
npm install
npm run dev   # http://localhost:5173
```

完整联调（聊天、订单查询、知识库检索）需要 Mastra Server 与上述下游服务全部
在线；仅查看界面结构不需要。详见 [`web-client/README.md`](web-client/README.md)。

## 验证场景

```text
请帮我查询订单 ORD1001 为什么还没发货？
订单 ORD1002 到哪里了？
订单 ORD1003 的物流为什么一直不更新？
帮我查询订单 ORD9999
我的物流怎么还没有更新？
```

## 当前范围

课程主链路已经完成：Qwen3-8B 正式 QLoRA 数据集与训练、FastAPI 推理、Mastra
Agent、Mock Tools、维修 RAG、Cross-Encoder Reranker、Mastra Client 与 React
工作台均有自动测试和真实端到端验收证据。多 Agent、复杂工作流、持久化会话
记忆和额外管理后台不在本次必做范围内。
