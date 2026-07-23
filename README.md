# 基于 Qwen QLoRA 与 Mastra 的电商客服智能体

这是一个本地运行的电商客服 AI 课程项目，完成了 Qwen3 QLoRA 微调、FastAPI + PyTorch 推理接口、Mastra Agent，以及订单查询 Mock Tool 的端到端闭环。

## 已实现功能

- 使用 LLaMA Factory 对 Qwen3-4B-Instruct-2507 进行 4-bit NF4 QLoRA 微调
- 加载基础模型与 LoRA Adapter
- 提供 OpenAI 兼容的 `/v1/chat/completions` 接口
- 支持普通响应、流式响应和 Tool Call
- Mastra Agent 接入本地 QLoRA API
- Mock 订单后端与 `queryOrderTool`
- 覆盖正常运输、物流延误、订单不存在和缺少订单号等边界场景

## 系统架构

```text
用户
  → Mastra Studio（4111）
  → 电商客服 Agent
      ├─ QLoRA FastAPI（8000）
      └─ queryOrderTool
           → Mock Backend（8001）
```

## 项目目录

```text
.
├─ adapters/                 # 最终 QLoRA Adapter（不包含训练 checkpoint）
├─ configs/                  # LLaMA Factory 训练与推理配置
├─ datasets/                 # 课程冒烟训练数据
├─ services/
│  ├─ app.py                 # QLoRA OpenAI 兼容 API
│  ├─ mock_backend.py        # Mock 订单接口
│  └─ test-model-load.py
├─ mastra-agent/
│  └─ src/mastra/
│     ├─ agents/
│     ├─ tools/
│     └─ index.ts
└─ start-*.bat               # Windows 启动脚本
```

## 环境

- Windows 10
- Python 3.11
- NVIDIA GeForce RTX 5070 12GB
- PyTorch 2.9.1 + CUDA 12.8
- Transformers 4.56.2
- LLaMA Factory 0.9.6.dev0
- Node.js 24
- Mastra 1.20.1

## 启动

需要先自行下载基础模型到：

```text
C:\AI\models\Qwen3-4B-Instruct-2507
```

最终 Adapter 默认位于：

```text
C:\AI\adapters\qwen3-4b\customer-service-smoke
```

依次运行：

```text
start-model-api.bat
start-mock-backend.bat
start-mastra-studio.bat
```

打开 Mastra Studio：

```text
http://localhost:4111/agents
```

## 验证场景

```text
请帮我查询订单 ORD1001 为什么还没发货？
订单 ORD1002 到哪里了？
订单 ORD1003 的物流为什么一直不更新？
帮我查询订单 ORD9999
我的物流怎么还没有更新？
```

## 当前范围

本项目是课程用最小可运行闭环。当前训练集为 20 条冒烟数据，主要用于验证 QLoRA 训练流程。RAG、向量数据库、Rerank、正式评估集和持久化记忆属于后续扩展。

