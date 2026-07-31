# 开发计划索引

## 项目信息

- 项目名: `ai-kefu`（无根 package.json，取仓库目录名 `ai客服` 转 kebab-case）
- 架构类型: **多包单仓**（无 workspace 声明）
  - `mastra-agent/` — Node + TypeScript，Mastra Server（:4111），RAG / Tools / 自定义 route
  - `web-client/` — Node + TypeScript，唯一允许的客服客户端（本次在其内部扩展 React+Vite 应用层）
  - `services/`、`training/`、`datasets/`、`knowledge/`、`configs/`、`models/` — Python 侧，**本次冻结不改**
- 需求源: `frontend-workbench/docs/智修客服AI工作台-前端需求.md`（978 行，2026-07-31 评审决策已合入）
- 设计源: Stitch 项目 `10964917433981148706`，screen `af1a6fe2fa77400fbdf68dcd5d24e53f`

## 本次 PRD（2026-07-31）切分为 8 个 feature

| 序号 | feature | 说明 | 依赖 | 状态 |
| ---- | ------- | ---- | ---- | ---- |
| 1 | `contract-retrieval-counts` | 契约新增 `retrievedCount`/`returnedCount` + 类型化 `OrderStatus.details` 白名单，经 `buildContractExtras()` 带出至 route 层两处组装点 | - | ✅ 已完成（commit `7a1dd20`） |
| 2 | `service-status-endpoint` | 新增 `GET /customer-service/status` 与 `client.status()`，三项服务四态聚合探测 | 1 | 待开发 |
| 3 | `workbench-app-scaffold` | web-client 内部搭建 Vite+React+TS+Tailwind，移植 screen 内联设计令牌 | - | 待开发 |
| 4 | `workbench-shell-layout` | 三栏骨架 + 顶栏服务状态 + 左侧会话列表 | 2, 3 | 待开发 |
| 5 | `chat-stream-conversation` | 中间对话区 + 底部输入区 + 流式 5 类事件 + 取消 | 3 | 待开发 |
| 6 | `evidence-panel` | 右侧处理依据（执行链路/回答模式/引用来源/trace） | 1, 3 | 待开发 |
| 7 | `scenarios-and-degradation` | 四类业务场景、订单 6 态（详情只读 `order.details`）、degraded/error、响应式抽屉降级 | 5, 6, **1** | 待开发 (v2) |
| 8 | `quality-gates-and-design-review` | 8 项门禁脚本（直连扫描 **6 端口**）、组件与 status 测试、设计还原复核 | 1-7 | 待开发 (v2) |

> `[v2]` 依赖变化：**7 新增对 1 的直接依赖**（`7.T-002` 需要 `1.T-007` 的 `order.details`）。
> 原「7 依赖 5,6」间接经由 3 依赖 1，现为显式直接依赖。执行顺序不变（1 本就在最前）。

**推荐执行顺序**：

```
1 ──► 2 ──┐
          ├─► 4 ──┐
3 ────────┤       ├─► 7 ──► 8
          ├─► 5 ──┤
1 + 3 ────┴─► 6 ──┘
```

- **可并行**：`1` 与 `3` 无依赖，可同时开工（分属服务端 / 前端，不同目录）
- **串行关键路径**：`1 → 2 → 4 → 7 → 8`
- `5` 只依赖 `3`，可与 `2`/`4` 并行
- `8` 必须最后执行（横切验收）

## 范围约束（来自需求文档 §11.3）

**允许改动**：

| 路径 | 归属 feature |
|---|---|
| `mastra-agent/src/mastra/contract.ts` | 1, 2 |
| `mastra-agent/src/mastra/tools/search-knowledge-base-tool.ts` | 1 |
| ~~`mastra-agent/src/mastra/orchestration.ts`~~ | **⛔ `[v2]` 移出可改范围** —— 契约组装不在此文件，禁止为 specs 而重构 |
| `mastra-agent/src/mastra/routes/customer-service.ts` | 1（两处组装点）, 2 |
| `mastra-agent/src/mastra/index.ts`（注册新 route） | 2 |
| `web-client/src/types.ts` | 1, 2 |
| `web-client/src/client.ts` | 2 |
| `web-client/`（新增 React+Vite 应用层） | 3-8 |

**⛔ 冻结不改**：`services/**`、`datasets/**`、`training/**`、`configs/**`、`knowledge/**`、`models/**`、已冻结评测报告。

## ID 编号约定

- 功能需求 / 任务 / 验收标准 ID **在单个 feature 内编号**，跨 feature 用 `{序号}.` 前缀区分。
- 例：`2.T-001` = 序号 2 这个 feature 的 T-001；`6.F-003` = 序号 6 的 F-003。
- **跨 feature 依赖**写全限定 ID，如 `2.T-001 依赖 1.T-002`。

## 关键前置事实（已通过读码核实，供各 feature 复用）

| 事实 | 位置 |
|---|---|
| **`ChatResponseBody` 在 route 层组装，共两处**：chat `:58`、stream `:105`；`orchestration.ts` 只返回 `AgentRunResult`，⛔ 不得为契约字段改动它 | `routes/customer-service.ts:58,105` `[v2 修正]` |
| `buildContractExtras(toolCalls)` 是两处组装点的共用出口，新字段从这里带出可消除漂移 | `contract.ts:60` `[v2]` |
| `queryOrderTool` 的 `order` 为 `z.record(z.string(), z.unknown()).optional()` 泛型记录，且当前被 `buildContractExtras()` **完全丢弃** | `tools/query-order-tool.ts:50` `[v2]` |
| 订单源数据为 **snake_case**（`order_id`/`status_text`/`created_at`…），工具层原样透传不转换 —— 白名单映射须显式转 camelCase | `services/mock_backend.py:12` `[v2]` |
| 前端禁连端口共 **6 个**：8000 / 8001 / 8002 / 6333 / 8787 / 11434 | `8.F-005` `[v2]` |
| `hits = await store.query(vector, RECALL_TOP_N)` → `retrievedCount` 取 `hits.length` | `search-knowledge-base-tool.ts:87` |
| `results` 数组即最终返回 → `returnedCount` 取 `results.length` | 同上 `:110` / `:116` |
| 空召回早退分支（`hits.length === 0`）需补两个计数为 0 | 同上 `:89-90` |
| Reranker 已有 `RerankerHealth` 与 `/health` 探测，可复用于 status | `rag/rerank.ts:46,110` |
| Reranker 默认 `http://127.0.0.1:8787` | `rag/rerank.ts:75` |
| Qdrant 默认 `http://127.0.0.1:6333` | `rag/config.ts:57` |
| Embedding 默认 `http://127.0.0.1:11434/v1`（Ollama） | `rag/config.ts:59` |
| route 通过 `registerApiRoute()` 注册，挂根路径（`/api` 为保留前缀） | `routes/customer-service.ts:17,44,73` |
| `server.apiRoutes` 数组需登记新 route | `mastra/index.ts:15-16` |
