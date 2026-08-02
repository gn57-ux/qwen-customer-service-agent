---
title: ChatResponseBody 组装点在 routes/customer-service.ts，不在 orchestration.ts
feature: 1.contract-retrieval-counts
type: decision
tags: [contract, orchestration, routes, buildContractExtras, mastra-agent]
date: 2026-07-31
---

**问题/场景**：需要给 `ChatResponseBody` 新增字段（本次是 `retrievedCount`/`returnedCount`/`order.details`）时，容易凭直觉以为响应体是在 `orchestration.ts`（`runAgentTurn`/`streamAgentTurn`）里组装的——因为那里是"业务逻辑"发生的地方。

**解法/结论**：实际组装点是 `mastra-agent/src/mastra/routes/customer-service.ts` 里的两处（chat 分支约 `:58`，stream 分支约 `:105`），且两处都调用同一个 `buildContractExtras(result.toolCalls)`（定义在 `contract.ts`）。`orchestration.ts` 的 `runAgentTurn`/`streamAgentTurn` 只返回 `AgentRunResult`（`reply`/`toolCalls`/`route`），不知道、也不应该知道 HTTP/SSE 契约长什么样——这是职责分层：编排层产出业务结果，route 层负责传输契约组装。

**复用方式**：任何 feature 要给 `ChatResponseBody`（或 SSE `done` 事件）加字段，改动落点是：
1. 让底层工具（如 `searchKnowledgeBaseTool`/`queryOrderTool`）的 `outputSchema` 产出新字段；
2. 在 `contract.ts` 的 `buildContractExtras()` 里把新字段从工具结果提取出来，加进它的返回值；
3. **不需要碰 `routes/customer-service.ts`**——两处组装点已经 `...buildContractExtras(result.toolCalls)` 展开式引用，新字段自动透传到两条路径；
4. **绝不碰 `orchestration.ts`**——它的返回值形状（`AgentRunResult`）是稳定契约，不应该为响应体字段变化而改。

这个设计天然保证 chat 与 stream 两条路径字段一致（同一个函数、同一份 `toolCalls` 输入），不需要在两处分别维护。
