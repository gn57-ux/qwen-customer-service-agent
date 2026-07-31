# service-status-endpoint — 需求规格

## 概述

新增 `GET /customer-service/status` 自定义 route 与 `client.status()`，对本地模型、知识库（聚合 Qdrant + Embedding + Reranker）、订单服务三项做带超时的脱敏探测，返回四态枚举，取代「由最近一次聊天请求推断服务在线」的旧方案。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §5.5 需求 B、§4.1、§5.1

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求（由 2026-07-31 评审决策 B 升级而来） |
| 2026-07-31 | v2 | 关闭 Embedding 端口开放问题（11434 已纳入禁连清单，门禁 5→6 个端口） |

## 用户故事

- 作为客服坐席，我想在顶栏看到三项服务的真实状态，以便在知识库降级时知道回答质量可能下降。
- 作为运维，我想要一个不泄露内部拓扑的健康端点，以便前端安全地展示服务状态。

## 功能需求

1. [F-001] Mastra 服务新增 `GET /customer-service/status`，挂在**根路径**（`/api` 为 Mastra 内置保留前缀，禁止占用），并登记进 `server.apiRoutes`。
2. [F-002] 响应体为 `ServiceStatusBody`，含三个字段：`localModel`、`knowledgeBase`、`orderService`。
3. [F-003] 状态值枚举为 `ServiceState = "unknown" | "online" | "degraded" | "error"`，四态之外的值不合法。
4. [F-004] `knowledgeBase` 为**聚合**状态，聚合 Qdrant、Embedding、Reranker 三个下游：
   - 三者均可用 → `online`
   - **Reranker 不可用但基础检索（Qdrant + Embedding）可用 → `degraded`**
   - Qdrant 或 Embedding 不可用（基础检索不可用）→ `error`
   - 探测未完成 / 无法判定 → `unknown`
5. [F-005] `localModel` 探测本地推理服务（llama-server），可用 `online`，不可用 `error`。
6. [F-006] `orderService` 探测订单后端，可用 `online`，不可用 `error`。
7. [F-007] 每个下游探测**独立超时**（≤ 2s），并发执行，`/status` 整体响应 ≤ 3s；任一下游挂起不得阻塞整体响应。
8. [F-008] 响应体**必须脱敏**：只返回四态枚举，禁止透出下游 URL、端口、IP、主机名、堆栈、原始异常消息；详细错误只写服务端日志。
9. [F-009] `web-client/src/client.ts` 新增 `status(): Promise<ServiceStatusBody>`，**必须**通过 `MastraClient.request()` 调用并沿用 `apiPrefix: ""`，禁止裸 `fetch`/`axios`。
10. [F-010] `ServiceStatusBody` / `ServiceState` 类型在 `contract.ts` 与 `types.ts` 两侧镜像同步。

## 非功能需求

- **性能**: `/status` 整体 ≤ 3s；下游探测并发而非串行。
- **安全**: F-008 脱敏为硬性要求；探测端点不得成为内部拓扑的信息泄露面。
- **健壮性**: 任一下游异常不得导致 `/status` 返回 5xx —— 应以该项为 `error` 正常返回 200。
- **兼容性**: 不改动现有两个 route 的任何行为。

## 验收标准

- [ ] [AC-001] `GET /customer-service/status` 返回 200 与三字段结构体，字段值均为四态之一。
- [ ] [AC-002] 三下游全可用 → `knowledgeBase === "online"`。
- [ ] [AC-003] 仅 Reranker 不可用 → `knowledgeBase === "degraded"`（**关键分支**）。
- [ ] [AC-004] Qdrant 或 Embedding 不可用 → `knowledgeBase === "error"`。
- [ ] [AC-005] 某下游挂起不响应时，`/status` 仍在 3s 内返回，该项为 `error`。
- [ ] [AC-006] 响应体全文不含 URL、端口号、IP、主机名、堆栈关键字（脱敏断言）。
- [ ] [AC-007] `client.status()` 可真实往返 :4111 并返回类型正确的对象。
- [ ] [AC-008] `client.ts` 中 `status()` 实现不含裸 `fetch(`，经 `MastraClient.request()` 调用。
- [ ] [AC-009] 下游全部不可用时 `/status` 仍返回 200（而非 5xx）。

## 依赖

- feature `1.contract-retrieval-counts`（契约文件同源改动，避免冲突）
- 现有 `LlamaCppReranker.health()` 与 `/health` 探测（`rag/rerank.ts:46,110`，可复用）
- Qdrant `:6333`、Reranker `:8787`、Embedding `:11434`、llama-server `:8002`、订单后端（`:8000`/`:8001`）

## 开放问题

- ~~Embedding 端口未列入禁连清单~~ `[v2 已解决]`
  原问题：Embedding 默认在 `http://127.0.0.1:11434/v1`（Ollama，见 `rag/config.ts:59`），
  未列入前端禁连清单。
  **解决方案**：`11434` 已正式纳入禁连清单，门禁端口由 5 个扩为 **6 个**
  （`8000`/`8001`/`8002`/`6333`/`8787`/`11434`），见 `8.F-005`。
  注：本 feature 的 `probeEmbedding` 位于 `mastra-agent/**` 服务端，
  门禁扫描范围为 `web-client/src`，二者不冲突。
