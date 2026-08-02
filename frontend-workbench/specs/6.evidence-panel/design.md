# evidence-panel — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **前端 UI 层**、**前端派生逻辑层（纯函数）**
- 不涉及: 服务端、数据库

## 功能模块设计

### 模块 1: 推导层（纯函数，可单测）

**新文件**: `src/app/evidence/derive.ts`

**设计核心**：所有「从契约推导 UI」的逻辑集中为**无副作用纯函数**，
输入 `ChatResponseBody`，输出视图模型。这样规则可被单测逐条覆盖，
也从结构上杜绝在组件里顺手写正则。

```ts
export interface EvidenceView {
  steps: Array<{ label: string; tone: "success" | "brand" | "safety"; bold?: boolean }>;
  modes: Array<{ label: string; tone: "neutral" | "safety"; icon?: string }>;
  degradedReason?: string;
  sources: Array<{ title: string; meta: string; highlighted: boolean; tone: "brand" | "safety" }>;
  traceId: string;
  latencyText: string;
}

export function deriveEvidence(body: ChatResponseBody): EvidenceView { ... }
```

**执行链路推导**（对应 F-005，⛔ 全部基于字段，零文本解析）：

```ts
const ROUTE_LABEL = {
  safety: "安全咨询", order: "订单查询", repair: "维修排查", general: "一般咨询",
} as const;
const TOOL_LABEL = {
  searchKnowledgeBase: "维修知识库", queryOrderTool: "订单服务",
} as const;

steps.push({ label: `已识别 · ${ROUTE_LABEL[body.route]}`, tone: "success" });
for (const c of body.toolCalls)
  steps.push({ label: `已调用 · ${TOOL_LABEL[c.name] ?? c.name}`, tone: "success" });
if (body.retrievedCount > 0)
  steps.push({ label: `已召回 · ${body.retrievedCount} 个候选片段`, tone: "brand" });
if (body.reranked === true)
  steps.push({ label: `重排完成 · Top ${body.returnedCount}`, tone: "brand" });
steps.push({ label: "已生成", tone: "brand" });
if (body.route === "safety")
  steps.push({ label: "已触发 · 安全策略", tone: "safety", bold: true });
```

**「高优」判定**（F-010，结构化而非猜测）：

```ts
const maxRerank = body.reranked === true
  ? Math.max(...(body.sources ?? []).map(s => s.rerankScore ?? -Infinity))
  : -Infinity;
const highlighted = body.reranked === true
  && s.rerankScore !== null && s.rerankScore === maxRerank;
```

> 边界：`reranked === false` 时 `rerankScore` 全为 `null` → `maxRerank = -Infinity`
> → 无任何项被标为高优，符合 AC-007。

**左边框色**（F-011）：`route === "safety" && highlighted` → `safety`，否则 `brand`。

### 模块 2: 面板组件

```tsx
<aside className="hidden min-[1100px]:flex w-[300px] xl:w-[320px] bg-sidebar-right-bg
                  border-l border-border-color flex-col h-full flex-shrink-0">
```

| 子组件 | 职责 |
|---|---|
| `<EvidenceHeader />` | `memory` 图标 + 标题 + 副标题 |
| `<StepTimeline />` | 竖线 + 节点圆点（`absolute -left-[21px]`） |
| `<ModeCard />` | 回答模式 chips + degraded 原因 |
| `<SourceList />` | 引用来源 + 高优标记 + 左边框色 |
| `<EvidenceFooter />` | traceId + 耗时 |

内容区 `font-code text-code`（JetBrains Mono 14px/1.5）由容器统一施加。

### 模块 3: 流式与最终态的衔接

```
meta        ──► traceId 显示，进入处理中态
tool-result ──► 实时 append 链路节点（临时视图，仅 label）
done        ──► deriveEvidence(body) 全量覆盖重建
```

**为什么 `done` 要覆盖而非增量合并**：流式期间的节点是**不完整推断**
（拿不到 `retrievedCount`/`reranked`/`sources`）；`done` 的结构化对象才是真源。
覆盖重建保证最终展示 100% 可追溯（需求 §5.4）。

**防闪烁**：覆盖时保持 DOM 结构与 key 稳定（按 label 生成 key），
让 React 复用节点而非整体卸载重建。

### 模块 4: 空状态

```ts
if (!body) return <Empty text="暂无处理记录，发送问题后展示执行链路" />;
if (!body.sources?.length) → 引用区显示「本次回答未引用知识库」
footer: traceId ?? "—" / latency ?? "—"
```

`route === "general"` 是验证「右栏不臆造内容」的关键回归场景：
应只有「已识别 · 一般咨询」+「已生成」两个节点，模式仅 `本地QLoRA`，引用区为空态。

## 接口契约

**消费**（不新增）：`ChatResponseBody`，其中本 feature 强依赖：

| 字段 | 用途 |
|---|---|
| `route` | 已识别节点、安全节点、边框色 |
| `toolCalls[].name` | 已调用节点 |
| `retrievedCount` | 已召回节点（feature 1 产出） |
| `returnedCount` | 重排完成节点（feature 1 产出） |
| `reranked` | 是否渲染重排节点、是否启用高优 |
| `sources[]` | 引用来源列表 |
| `degraded` / `degradedReason` | 降级 chip 与原因 |
| `traceId` / `latencyMs` | 底部栏 |

## 数据模型

无持久化。`EvidenceView` 为纯派生视图模型，不入 store。

## 安全考虑

- **⛔ 铁律：禁止对 `reply` 做正则/关键词匹配**（需求 §5.3）。
  结构保障：推导逻辑全在 `derive.ts`，其函数签名只接受 `ChatResponseBody`，
  **不接受字符串正文** —— 从类型层面让"解析正文"写不出来。
- `degradedReason` 由服务端提供，按纯文本渲染，不使用 `dangerouslySetInnerHTML`
- 不渲染 `sources[].sourceFile` 之外的路径信息，不暴露绝对路径
- 未在契约中定义的字段一律不展示

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 推导逻辑位置 | **独立纯函数 `derive.ts`** | 可单测；签名不收正文，结构上杜绝正则解析 |
| `done` 处理 | **全量覆盖重建** | 流式期间是不完整推断，结构化才是真源 |
| 覆盖防闪烁 | **稳定 key 复用 DOM** | 整体卸载重建会有可见闪烁 |
| 「高优」判定 | **`rerankScore` 最大值** | 唯一结构化依据；文件名猜测不可靠且违反铁律 |
| `retrievedCount === 0` | **不渲染该节点** | 展示「已召回 · 0」无信息量且易误解为故障 |
| degraded 与顶栏 | **只触发 refresh，不直改** | 聊天级降级 ≠ 服务级健康度（需求 §6.2） |
| 引用点击行为 | **滚动定位到正文角标** | 设计稿未定义具体动作；外链跳转超出本期范围 |
