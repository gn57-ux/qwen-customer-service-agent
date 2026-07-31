# contract-retrieval-counts — 需求规格

## 概述

为检索链路补上可验证的计数字段：`retrievedCount`（向量检索实际命中数）与 `returnedCount`（最终返回条数），并在 chat 响应体与 SSE `done` 事件中同步暴露，使前端「已召回 · N 个候选片段 / 重排完成 · Top N」有真实数据来源。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓（mastra-agent + web-client + Python 服务）
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §5.5 需求 A、§5.2、§5.3

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求（由 2026-07-31 评审决策 A 升级而来） |
| 2026-07-31 | v2 | 修正组装位置为 routes/customer-service.ts；新增类型化 `OrderStatus.details` 白名单映射 |

## 用户故事

- 作为客服坐席，我想在右栏看到真实的召回与重排数量，以便判断这次回答的知识覆盖程度是否充分。
- 作为开发者，我想让前端展示的计数可追溯到结构化字段，以便杜绝硬编码与文本猜测。

## 功能需求

1. [F-001] `searchKnowledgeBase` 工具的 `outputSchema` 新增 `retrievedCount: number`，取值为向量检索实际命中数，即 `store.query()` 返回的 `hits.length`。
2. [F-002] 同一 `outputSchema` 新增 `returnedCount: number`，取值为最终返回的 `results` 数组长度。
3. [F-003] 两个计数必须取自**运行时真实数据**，禁止使用 `RECALL_TOP_N` / `FINAL_TOP_K` 等配置常量代替。
4. [F-004] 空召回分支（`hits.length === 0` 早退）也必须返回 `retrievedCount: 0` 与 `returnedCount: 0`，不得缺省为 `undefined`。
5. [F-005] `ChatResponseBody` 新增 `retrievedCount: number` 与 `returnedCount: number`（必填，非可选）。
6. [F-006] `POST /customer-service/chat` 的响应体与 SSE `done` 事件的 data **必须携带完全相同的两个字段**，两条路径不得出现字段差异。
   `[v2 修改]` 两处组装点均位于 **`routes/customer-service.ts`**（chat `:58`、stream `:105`），
   ⛔ 不在 `orchestration.ts` —— 后者只返回 `AgentRunResult`（`reply`/`toolCalls`/`route`）。
7. [F-007] `mastra-agent/src/mastra/contract.ts` 与 `web-client/src/types.ts` 两侧类型镜像同步，字段名与可选性完全一致。
8. [F-008] `[v2 新增]` ⛔ **禁止为满足 v1 的错误描述而重构 `orchestration.ts`** —— 其现有职责边界（只产出 `AgentRunResult`）是正确的，不得为"让组装发生在 orchestration"而改动它。
9. [F-009] `[v2 新增]` `OrderStatus` 新增可选字段 `details?: OrderDetails`，由 `buildContractExtras()` 从 `queryOrderTool` 返回的 `order` 记录中映射产生。
10. [F-010] `[v2 新增]` `OrderDetails` 为**类型化白名单**，只映射以下 10 个字段，**全部可空**：
    `orderId`、`status`、`statusText`、`createdAt`、`carrier`、`trackingNumber`、
    `latestLogistics`、`estimatedDelivery`、`canCancel`、`customerTip`。
    - ⛔ 白名单之外的键一律**丢弃**，不得透传
    - ⛔ 缺失字段一律为 `null`/`undefined`，**不得臆造**任何默认值或占位文案
11. [F-011] `[v2 新增]` 源数据键名为 **snake_case**（`order_id`/`status_text`/`created_at`/`tracking_number`/`latest_logistics`/`estimated_delivery`/`can_cancel`/`customer_tip`），映射时须显式转换为 camelCase 目标名（依据见 design.md 模块 4）。
12. [F-012] `[v2 新增]` `order` 记录缺失或非对象时，`details` 为 `undefined`，不得构造空壳对象。

## 非功能需求

- **正确性**: `retrievedCount >= returnedCount` 恒成立（重排只做截断与重排序，不新增候选）。
- **性能**: 计数为已有数组的 `.length` 读取，不得引入额外查询或网络往返。
- **兼容性**: 字段为新增，不改动任何现有字段的名称、类型与可选性。
- **安全**: 计数为纯数字，不携带任何文档内容或内部路径。

## 验收标准

- [ ] [AC-001] 正常召回场景：`retrievedCount === hits.length`，`returnedCount === results.length`，且前者 ≥ 后者。
- [ ] [AC-002] 重排可用场景（`reranked: true`）：`returnedCount` 等于重排后返回条数。
- [ ] [AC-003] 重排降级场景（`reranked: false, degraded: true`）：两个计数仍正确返回，`returnedCount` 等于向量顺序截断后的条数。
- [ ] [AC-004] 空召回场景：两个计数均为 `0`，且字段存在（非 `undefined`）。
- [ ] [AC-005] 同一次提问分别走 `chat` 与 `stream`，两条路径返回的两个计数值一致。
- [ ] [AC-006] `contract.ts` 与 `types.ts` 字段定义逐字段比对一致。
- [ ] [AC-007] 单元测试覆盖 AC-001～AC-004 四个分支。
- [ ] [AC-008] `[v2 新增]` 计数字段的修改仅落在 `routes/customer-service.ts` 的两处组装点；`git diff` 显示 `orchestration.ts` **无改动**。
- [ ] [AC-009] `[v2 新增]` 完整订单（如 ORD1002）→ `details` 10 个字段全部正确映射，snake_case 源键正确转为 camelCase。
- [ ] [AC-010] `[v2 新增]` 部分字段为 null 的订单（如 ORD1001 的 `carrier`/`tracking_number` 为 `None`）→ 对应字段为 `null`，**未被填充**任何默认值。
- [ ] [AC-011] `[v2 新增]` 源记录含白名单外的键 → 该键不出现在 `details` 中。
- [ ] [AC-012] `[v2 新增]` `found: false`（not_found/timeout 等）→ `details` 为 `undefined`，不构造空壳。
- [ ] [AC-013] `[v2 新增]` `details` 的类型定义在 `contract.ts` 与 `types.ts` 两侧一致。

## 依赖

- 现有 `store.query()`（Qdrant）与 `LlamaCppReranker`
- 现有 `queryOrderTool` 的 `order` 输出（`z.record(z.string(), z.unknown()).optional()`）
- 无新增第三方依赖

## 开放问题

- `[v2 已解决]` 订单详情字段来源：经核实 `queryOrderTool` 的 `order` 为泛型记录且被
  `buildContractExtras()` 完全丢弃；v2 通过类型化白名单 `OrderStatus.details` 解决，
  feature 7 的同名开放问题一并关闭。
