# scenarios-and-degradation — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |
| 2026-07-31 | v2 | 订单详情改为读取类型化 `order.details`，移除泛型 toolCalls 解析方案 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **前端 UI 层**、**前端派生逻辑层**
- 不涉及: 服务端、数据库

## 功能模块设计

### 模块 1: 场景渲染分发

**新文件**: `src/app/scenarios/render-slots.ts`

feature 5 的 `<AssistantMessage />` 预留了插槽，本模块按 `route` 与结构化字段决定填充什么：

```ts
export function resolveSlots(body: ChatResponseBody) {
  return {
    safetyCard: body.route === "safety",                    // 仅 route 决定
    orderCard:  body.toolCalls.some(c => c.name === "queryOrderTool") && !!body.order,
    citations:  (body.sources ?? []).length > 0,
  };
}
```

> **注意 `orderCard` 的双条件**：既要有工具调用记录，也要有 `order` 字段。
> 只判 `route === "order"` 是错的 —— 无订单号的追问场景 `route` 同样是 `order`，
> 但没调用工具（F-002），此时不应渲染卡片。

### 模块 2: 订单卡片状态机

```ts
type OrderView =
  | { kind: "ok" }            // found && !partial
  | { kind: "partial"; missing: string[] }
  | { kind: "error"; text: string; retryable: boolean };

const ORDER_ERROR: Record<NonNullable<OrderStatus["error"]>,
                          { text: string; retryable: boolean }> = {
  not_found:     { text: "订单不存在，请核对订单号",     retryable: false },
  timeout:       { text: "订单服务响应超时",             retryable: true  },
  server_error:  { text: "订单服务异常，请稍后再试",     retryable: false },
  network_error: { text: "网络异常，无法连接订单服务",   retryable: true  },
};
```

**可重试的判定依据**：`timeout` 与 `network_error` 是**瞬时**故障，重试有意义；
`not_found` 是确定性结果（重试无用，应改订单号）；`server_error` 需服务端恢复。

**订单详情字段** `[v2 修正]`：

> v1 方案（从 `toolCalls[].result` 解析泛型记录）**已作废**。

契约层已提供类型化白名单 `order.details`（`1.T-007`），前端**只读它**：

```tsx
const d = body.order?.details;          // ✅ 唯一来源
// ⛔ 禁止：body.toolCalls.find(c => c.name === "queryOrderTool")?.result
```

**10 个可空字段的渲染规则**：

| 字段 | 展示 | 空值处理 |
|---|---|---|
| `orderId` | 订单号 | 隐藏该行 |
| `status` / `statusText` | 状态（优先展示 `statusText`，回落 `status`） | 两者皆空则隐藏 |
| `createdAt` | 下单时间 | 隐藏该行 |
| `carrier` / `trackingNumber` | 承运商 / 运单号 | 未发货时本就为 null → 隐藏物流区 |
| `latestLogistics` | 最新物流 | 隐藏该行 |
| `estimatedDelivery` | 预计送达 | 隐藏该行 |
| `canCancel` | 可取消（布尔） | `null` 时隐藏，⛔ 不得默认 false |
| `customerTip` | 坐席提示 | 隐藏该行 |

**三条硬约束**：
1. ⛔ 空值**隐藏该行或显示「—」**，绝不填默认值 —— 编造订单信息会让坐席误导客户
2. ⛔ `canCancel` 为 `null` 时**不得**当作 `false`（"不确定能否取消" ≠ "不能取消"）
3. `details` 为 `undefined`（`found: false`）→ 只渲染状态卡，不渲染详情区（F-002c）

> 为什么必须走 `details` 而非泛型解析：泛型 `Record<string, unknown>` 会迫使前端
> 猜键名与类型，且后端新增内部字段（成本价、供应商）会直接暴露给前端。
> 白名单在契约层就把边界划死了。

### 模块 3: 异常态

**error 卡**（F-008）：

```tsx
<div className="border border-safety-border bg-safety-bg p-3">
  <div className="flex items-center gap-2 text-safety-text font-bold">
    <Icon name="warning" /> 回复生成失败
  </div>
  <p className="text-[14px] text-safety-text">{message}</p>
  <p className="text-[12px] text-text-muted">{traceId}</p>
  <button onClick={retry}><Icon name="refresh" /> 重试</button>
</div>
```

**关键：已生成正文不清空**（F-008）。错误卡**追加**在部分正文之后，而非替换——
用户已读到的内容突然消失是更糟的体验，且部分内容往往仍有参考价值。

**三种收尾的 UI 差异**（易混淆，明确区分）：

| 收尾 | 正文 | 提示 | 右栏 |
|---|---|---|---|
| `aborted`（用户取消） | 保留 | **无任何错误提示** | 保留已有节点 |
| `error` | 保留 | 错误卡 + 重试 | 追加「已中断 · 生成失败」 |
| `degraded`（仍成功） | 正常完整 | 无错误，右栏 chip | 正常 + 降级 chip |

### 模块 4: 响应式与抽屉

**断点**（逐字来自 `docs/assets/workbench-stitch.html`，⛔ 不得改写为常规 lg/xl）：

| Tailwind 类 | 阈值 | 作用对象 |
|---|---|---|
| `md:` | 768 | 左栏、顶栏状态、顶栏副标题、清空会话文字、对话头部方向 |
| `min-[1100px]:` | 1100 | 右栏显隐 |
| `xl:` | 1280 | 右栏 300→320px |

**抽屉设计**（F-012/F-013）：

```tsx
<Drawer side="right" open={open} onClose={close}>
  <EvidencePanelContent />   {/* 复用 feature 6 的内容组件，非复制一份 */}
</Drawer>
```

**关键：复用而非复制**。抽屉与右栏共用同一套内容组件，
仅容器不同 —— 否则两处会随迭代逐渐不一致（F-012 要求「100% 一致」）。

抽屉规格：0 圆角、`bg` 同原栏位、`transition 200ms ease-out`、遮罩 `rgba(36,49,66,0.4)`（= `#243142` 40%）。
可访问性：Esc 关闭、打开时焦点移入、关闭后焦点归还触发按钮。

**无横向滚动**（F-015）：根容器 `overflow-hidden`；所有可能超宽的内容
（快捷 chips、长引用标题）用 `overflow-x-auto no-scrollbar` 或 `truncate` 内部消化。

## 接口契约

**消费**（不新增）：`ChatResponseBody.order`、`.toolCalls`、`.route`、`.sources`、
`.degraded`、`.degradedReason`，以及 `queryOrderTool` 的 `result` 结构。

## 数据模型

无持久化。`OrderView` 为纯派生视图模型。

## 安全考虑

- 错误卡只展示服务端 `message` 与 `traceId`，⛔ 不展示堆栈、URL、端口
- 安全话术**全部来自服务端正文**，前端不硬编码任何安全建议
  （避免前端话术与服务端安全策略不一致，产生误导性维修指导）
- `[v2]` 订单详情只读契约层白名单 `order.details`，前端不接触泛型工具结果 ——
  后端订单记录新增内部字段（成本价、供应商、内部备注）不会流向 UI
- 抽屉不改变数据可见性，仅改变布局

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 订单卡渲染条件 | **工具调用 + `order` 双条件** | 只判 `route` 会在追问场景误渲染空卡 |
| 可重试范围 | **仅 timeout / network_error** | 瞬时故障重试有意义；not_found 应改单号 |
| error 时正文 | **保留并追加错误卡** | 已读内容消失体验更差，且部分内容仍有价值 |
| 取消是否提示 | **不提示** | 用户主动行为不是故障 |
| 抽屉内容 | **复用右栏组件** | 复制会随迭代不一致，违反"100% 一致"要求 |
| 断点数值 | **照抄 HTML（1100 非 1024）** | 改写为常规断点会偏离设计稿 |
| `[v2]` 订单详情来源 | **只读 `order.details` 白名单** | 泛型解析迫使前端猜结构，且无安全边界（v1 方案已作废） |
| `[v2]` 空值渲染 | **隐藏行 / 显示「—」** | 填默认值等于编造订单信息，会误导坐席与客户 |
| `[v2]` `canCancel` 为 null | **隐藏，不当作 false** | "不确定" ≠ "不能"，误判会导致坐席拒绝合法取消请求 |
| 安全话术来源 | **服务端正文** | 前端硬编码可能与安全策略不一致 |
