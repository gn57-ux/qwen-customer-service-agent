# contract-retrieval-counts — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |
| 2026-07-31 | v2 | 修正组装位置（route 层而非编排层）；新增模块 4 订单白名单映射 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **契约层**（contract.ts / types.ts）、**工具层**（search-knowledge-base-tool.ts）、**route 层**（routes/customer-service.ts）
- 不涉及: 前端 UI、数据库、Python 服务、**`orchestration.ts`（v2 明确排除）**

> 项目当前无 `.claude/CLAUDE.md` 与 `.claude/rules/`。本设计遵循代码库内既有约定：
> `types.ts` 顶部明文要求「改动服务端契约时必须同步改这里，两边字段名/可选性必须一致」。

## 功能模块设计

### 模块 1: 工具层计数产出

**文件**: `mastra-agent/src/mastra/tools/search-knowledge-base-tool.ts`

现有三个返回分支（已读码确认）：

| 行 | 分支 | 现状 |
|---|---|---|
| `:89-90` | 空召回早退 | `return { reranked: false, degraded: false, results: [] }` |
| `:110-111` | 重排成功 | `return { reranked: true, degraded: false, results }` |
| `:116-122` | 重排降级 | `return { reranked: false, degraded: true, degradedReason, results }` |

**设计**：三个分支**全部**补齐两个计数，取值只允许来自运行时变量。

```ts
// outputSchema 扩展
outputSchema: z.object({
  reranked: z.boolean()...,
  degraded: z.boolean()...,
  degradedReason: z.string().optional(),
  retrievedCount: z.number().int().min(0)
    .describe("向量检索实际命中数，等于 store.query() 返回的 hits.length"),
  returnedCount: z.number().int().min(0)
    .describe("最终返回条数，等于 results.length"),
  results: z.array(resultItemSchema),
})
```

分支取值：

| 分支 | `retrievedCount` | `returnedCount` |
|---|---|---|
| 空召回 | `hits.length`（即 0） | `0` |
| 重排成功 | `hits.length` | `results.length` |
| 重排降级 | `hits.length` | `results.length`（`hits.slice(0, FINAL_TOP_K)` 后的长度） |

⛔ **禁止**写成 `RECALL_TOP_N` / `FINAL_TOP_K` —— 这两个是配置期望值，与实际命中数无关
（例：知识库不足时 `hits.length < RECALL_TOP_N`）。

### 模块 2: 契约层字段扩展

**文件**: `mastra-agent/src/mastra/contract.ts` + `web-client/src/types.ts`（镜像）

```ts
export interface ChatResponseBody {
  reply: string;
  route: RouteCategory;
  toolCalls: ToolCallRecord[];
  sources?: KnowledgeSourceItem[];
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  order?: OrderStatus;
  retrievedCount: number;   // 新增，必填
  returnedCount: number;    // 新增，必填
  traceId: string;
  latencyMs: number;
}
```

**必填而非可选的理由**：可选字段会诱导前端写 `?? 0` 兜底，从而掩盖服务端漏传；
必填让缺失在类型检查阶段即暴露。

`contract.ts:68` 附近已有从 `toolCalls` 反查工具结果的 `extras` 提取逻辑
（`reranked` / `degraded` / `degradedReason` 就是这么取的），两个计数**沿用同一路径**提取，
保持代码风格一致。

**无工具调用时的取值**（如 `route === "general"` 未检索）：两个计数均为 `0`。

### 模块 3: route 层双路径透传 `[v2 修正]`

> **v1 的描述是错的**，已作废：v1 称组装发生在 `orchestration.ts`。
> 经读码核实（见下），实际组装点在 **`routes/customer-service.ts`**。

**已核实的真实结构**：

| 文件 | 职责 | 是否改动 |
|---|---|---|
| `orchestration.ts` | `runAgentTurn` / `streamAgentTurn` 只返回 `AgentRunResult`（`reply` / `toolCalls` / `route`），**不产出 `ChatResponseBody`** | ⛔ **不改动** |
| `contract.ts` | `buildContractExtras(toolCalls)` 从工具结果结构化提取 `sources`/`reranked`/`degraded`/`order` | ✅ 改动（模块 2、模块 4） |
| `routes/customer-service.ts` | **两处**组装 `ChatResponseBody`：chat 分支 `:58`、stream 分支 `:105` | ✅ 改动 |

**两处组装点现状**（结构相同）：

```ts
const body: ChatResponseBody = {
  reply: result.reply,
  ...buildContractExtras(result.toolCalls),   // ← 计数从这里带出最自然
  traceId,
  latencyMs: Date.now() - started,
};
```

**设计选择**：把两个计数放进 `buildContractExtras()` 的返回值，
则**两处组装点无需各自赋值**，天然消除字段漂移风险 —— 这与 v1「唯一出口」的
意图一致，只是正确的落点是 `buildContractExtras()` 而非 orchestration。

```ts
// contract.ts
export function buildContractExtras(toolCalls): {
  ...;
  retrievedCount: number;   // kbCall ? r.retrievedCount : 0
  returnedCount: number;    // kbCall ? r.returnedCount  : 0
}
```

无 `searchKnowledgeBase` 调用时（如 `route === "general"`）两者为 `0`。

> ⛔ **禁止为满足 v1 的错误描述而重构 `orchestration.ts`**（F-008）。
> 其职责边界正确：编排产出业务结果，route 层负责 HTTP/SSE 契约组装。
> 把契约组装下沉到 orchestration 会让编排层耦合传输层，是倒退。

### 模块 4: 订单详情白名单映射 `[v2 新增]`

**文件**: `contract.ts` 的 `buildContractExtras()` 中 `orderCall` 分支

**问题**：`queryOrderTool` 的 `outputSchema` 中 `order` 为
`z.record(z.string(), z.unknown()).optional()` —— 泛型记录、无类型约束；
且当前 `buildContractExtras()` **完全丢弃**了它（只映射 `found`/`partial`/`missingFields`/`error`），
导致前端拿不到任何订单详情，只能去解析泛型 `toolCalls[].result`。

**⚠️ 关键实测事实：源数据是 snake_case**

`query-order-tool.ts` 对 `order` 是**原样透传**（`order: body.data`，无键名转换），
而 mock 后端 `services/mock_backend.py:12` 的记录为 snake_case。故必须显式映射：

| 源键（snake_case） | 目标键（camelCase） | 类型 |
|---|---|---|
| `order_id` | `orderId` | `string \| null` |
| `status` | `status` | `string \| null` |
| `status_text` | `statusText` | `string \| null` |
| `created_at` | `createdAt` | `string \| null` |
| `carrier` | `carrier` | `string \| null` |
| `tracking_number` | `trackingNumber` | `string \| null` |
| `latest_logistics` | `latestLogistics` | `string \| null` |
| `estimated_delivery` | `estimatedDelivery` | `string \| null` |
| `can_cancel` | `canCancel` | `boolean \| null` |
| `customer_tip` | `customerTip` | `string \| null` |

> 若不做转换，10 个字段会**全部为 null** 而测试仍"通过"（因为字段可空）——
> 这是最隐蔽的失败模式，故 AC-009 必须用真实完整订单（ORD1002）断言值非空。

**类型定义**：

```ts
export interface OrderDetails {
  orderId?: string | null;
  status?: string | null;
  statusText?: string | null;
  createdAt?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  latestLogistics?: string | null;
  estimatedDelivery?: string | null;
  canCancel?: boolean | null;
  customerTip?: string | null;
}

export interface OrderStatus {
  found: boolean;
  partial?: boolean;
  missingFields?: string[];
  error?: "not_found" | "timeout" | "server_error" | "network_error";
  details?: OrderDetails;      // v2 新增
}
```

**映射实现要点**：

```ts
const FIELD_MAP = {
  order_id: "orderId", status: "status", status_text: "statusText",
  created_at: "createdAt", carrier: "carrier", tracking_number: "trackingNumber",
  latest_logistics: "latestLogistics", estimated_delivery: "estimatedDelivery",
  can_cancel: "canCancel", customer_tip: "customerTip",
} as const;

function toOrderDetails(order: unknown): OrderDetails | undefined {
  if (!order || typeof order !== "object") return undefined;   // F-012
  const src = order as Record<string, unknown>;
  const out: OrderDetails = {};
  for (const [from, to] of Object.entries(FIELD_MAP))
    if (from in src) out[to] = src[from] ?? null;              // 缺失即 null，不臆造
  return out;
}
```

**三条硬约束**：
1. 白名单之外的键**丢弃**（不透传，避免后端新增字段意外外泄）
2. 缺失字段为 `null`，⛔ 不填默认值、不编占位文案
3. `order` 缺失或非对象 → `details` 为 `undefined`，不构造空壳（F-012）

**类型收窄**：`canCancel` 需按 boolean 处理，其余按 string；
非预期类型（如 `can_cancel` 返回字符串）应落为 `null` 而非强转。

## 接口契约

**变更接口**：

| 接口 | 变更 |
|---|---|
| `POST /customer-service/chat` | 响应体新增 `retrievedCount`、`returnedCount`、`order.details` |
| `POST /customer-service/stream` → SSE `done` | data 新增同样字段 |
| `searchKnowledgeBase` tool output | 新增两个计数字段 |
| `queryOrderTool` | ⛔ **不变**（其 outputSchema 保持原样，映射在 contract 层做） |

**不变**：请求体、路由路径、其他所有字段、SSE 事件种类与顺序、`orchestration.ts`。

## 数据模型

无持久化变更。两个计数与 `order.details` 均为**运行时派生值**，不入库、不缓存。

## 安全考虑

- 计数为整数，不含文档内容、文件路径、向量或内部主机信息，无泄露风险。
- **`order.details` 白名单是一道安全边界**：后端订单记录未来若新增内部字段
  （成本价、供应商、内部备注等），白名单保证它们**不会自动流向前端**。
  这正是「白名单而非黑名单」的价值 —— 默认拒绝，显式放行。
- 缺失字段落 `null` 而非编造，避免向客服坐席呈现假订单信息导致误导客户。
- 不改变现有鉴权与错误处理路径。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 字段必填 vs 可选 | **必填** | 可选会诱导 `?? 0` 兜底掩盖漏传；必填让缺失在 typecheck 暴露 |
| 计数放工具输出 vs 编排层重算 | **放工具输出** | 编排层拿不到 `hits`，重算不可能；工具层是唯一真源 |
| 复用 `extras` 提取路径 | **复用** | 与 `reranked`/`degraded` 同源同风格，减少认知负担 |
| 空召回是否省略字段 | **不省略，返回 0** | 省略会让前端无法区分「0 条」与「服务端漏传」 |
| 命名 `retrievedCount`/`returnedCount` | 采用评审裁定 | 语义明确，避免 `total`/`count` 这类含糊词 |
| `[v2]` 组装点落在哪 | **`buildContractExtras()`** | 两处 route 组装点共用它，天然消除字段漂移；无需改 orchestration |
| `[v2]` 是否重构 orchestration | **否，明令禁止** | 其职责边界正确；把契约组装下沉会让编排层耦合传输层 |
| `[v2]` 订单详情传递方式 | **类型化白名单 `details`** | 泛型 `Record<string, unknown>` 迫使前端解析未知结构，且无安全边界 |
| `[v2]` 白名单 vs 黑名单 | **白名单** | 默认拒绝、显式放行；后端新增内部字段不会自动外泄 |
| `[v2]` 缺失字段处理 | **落 `null`，不臆造** | 编造订单信息会误导坐席进而误导客户 |
| `[v2]` 键名转换位置 | **contract 层显式映射表** | 源为 snake_case，工具层原样透传；在契约层集中转换可单测 |
| `[v2]` 是否改 queryOrderTool | **否** | 工具层保持原样透传，映射职责归契约层，改动面最小 |
