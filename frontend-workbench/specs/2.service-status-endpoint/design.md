# service-status-endpoint — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |
| 2026-07-31 | v3 | 修正模块 1 探测器表：`localModel` 探测对象改为 FastAPI `:8000/health`（判定 `status==="ok"`），非字面意义的 llama-server `:8002`（与 requirements.md v3 同步；跳过 v2 编号以保持两文件版本号对齐） |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **route 层**、**探测层（新增）**、**契约层**、**客户端层**
- 不涉及: 前端 UI（由 feature 4 消费）、数据库、Python 服务

## 功能模块设计

### 模块 1: 探测层（新增）

**新文件**: `mastra-agent/src/mastra/health/probes.ts`

每个探测器统一签名，**自带超时且永不抛错**（异常一律归一为不可用）：

```ts
type ProbeResult = { ok: boolean };   // 对外只暴露布尔，错误细节只进日志

async function probe(name: string, fn: (signal: AbortSignal) => Promise<boolean>,
                     timeoutMs = 2000): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return { ok: await fn(ac.signal) };
  } catch (err) {
    logger.warn({ probe: name, err }, "健康探测失败");  // 细节只写日志
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
```

五个下游探测：

| 探测器 | 目标 | 判定 |
|---|---|---|
| `probeLlamaServer` | `[v3 修正]` **FastAPI 正式推理入口**（`services/app.py`，默认 `:8000`）的 `/health`，**不是** llama-server `:8002` 本身 | HTTP 200 **且**响应体 `status === "ok"`；`not_loaded`/`degraded`/其他值均判为不可用（FastAPI `/health` 在这些状态下仍返回 200，必须解析 body） |
| `probeQdrant` | Qdrant `:6333`（`rag/config.ts:57`） | 复用 `QdrantKnowledgeStore.health()`（REST `/readyz`） |
| `probeEmbedding` | Embedding `:11434/v1`（`rag/config.ts:59`） | 命中 Ollama 的 `/v1/models`，确认配置的 `embeddingModel` 已加载（按 base name 双向归一化比较，兼容 Ollama 返回带 `:tag` 后缀的模型名） |
| `probeReranker` | Reranker `:8787` | **复用现有 `LlamaCppReranker.health()`**（`rag/rerank.ts:110` 已实现 `/health`） |
| `probeOrderService` | 订单后端（Mock `:8001`） | 复用 `queryOrderTool` 所用的 base URL 的健康端点 |

> 复用 `rerank.ts` 既有 `RerankerHealth` 而非另写一套，避免两处判定不一致。

> `[v3]` ⛔ **`localModel` 绝不探测 `:8002`**：llama-server 只在 FastAPI 进程内部转发，
> 不应被任何客户端直连（既有架构约束，见 `agents/customer-service-agent.ts` 顶部注释）。
> 探测 `:8002` 既违反这条约束，也会给出误导性信号——即使 llama-server 存活，
> FastAPI 未加载模型/未通过 upstream 身份校验时，Agent 的真实生成请求依然会失败。
> `:8002` 仍然计入前端禁连端口扫描清单（`8.F-005`），本条修正不影响那份清单。

**并发执行**：

```ts
const [llama, qdrant, embedding, reranker, order] = await Promise.all([...]);
```

`Promise.all` + 每项自带超时 ⇒ 整体耗时 ≈ 最慢一项（≤2s），满足 F-007 的 3s 上限。

### 模块 2: 聚合规则

```ts
function aggregateKnowledgeBase(qdrant: ProbeResult, embedding: ProbeResult,
                                reranker: ProbeResult): ServiceState {
  const baseOk = qdrant.ok && embedding.ok;      // 基础检索能力
  if (!baseOk) return "error";                   // 基础检索挂 → 致命
  return reranker.ok ? "online" : "degraded";    // Reranker 仅为增强能力
}
```

**语义**：Reranker 是**增强**，失效降级但不致命；Qdrant/Embedding 是**基础**，失效即 `error`。
与 `search-knowledge-base-tool.ts` 现有的 `reranked:false + degraded:true` 降级语义完全对齐。

`unknown` 由**客户端**在探测未完成时使用（见 feature 4）；服务端探测完成后不会返回 `unknown`。

### 模块 3: route 层

**文件**: `mastra-agent/src/mastra/routes/customer-service.ts`（追加）+ `mastra/index.ts`（注册）

```ts
export const customerServiceStatusRoute = registerApiRoute("/customer-service/status", {
  method: "GET",
  handler: async (c) => c.json(await collectServiceStatus()),   // 恒 200
});
```

`mastra/index.ts:16` 的 `apiRoutes` 数组追加该 route。

**恒返回 200**：下游全挂也返回 200 + 三个 `error`，而非 5xx —— 让前端只需处理一种成功形态，
5xx 留给「status 端点自身故障」这一真正的异常。

### 模块 4: 客户端层

**文件**: `web-client/src/client.ts`（追加方法）+ `types.ts`（类型）

```ts
async status(): Promise<ServiceStatusBody> {
  return client.request<ServiceStatusBody>("/customer-service/status", { method: "GET" });
}
```

与现有 `chat()` 完全同构：同一个 `MastraClient` 实例、同样的 `apiPrefix: ""`、同样的 `request()`。
⛔ 不新建 client 实例，不使用裸 `fetch`。

## 接口契约

```ts
type ServiceState = "unknown" | "online" | "degraded" | "error";

interface ServiceStatusBody {
  localModel:    ServiceState;
  knowledgeBase: ServiceState;   // 聚合 Qdrant + Embedding + Reranker
  orderService:  ServiceState;
}
```

| 接口 | 方法 | 响应 |
|---|---|---|
| `/customer-service/status` | GET | 200 + `ServiceStatusBody` |

## 数据模型

无持久化。探测结果为瞬时值，不缓存（若后续加缓存需另行评审 TTL 与一致性）。

## 安全考虑

**基于需求 §5.5 B-3，脱敏为硬性要求：**

- 响应体**只含**三个四态枚举字段，无 URL / 端口 / IP / 主机名 / 堆栈 / 原始异常消息
- `ProbeResult` 刻意只保留 `{ ok: boolean }`，从类型层面杜绝错误细节外泄
- 错误细节**只写服务端日志**（`logger.warn`），不进响应
- 探测本身不携带凭据，不放大内部访问权限
- 端点无鉴权时仅暴露「三项服务是否健康」，不足以推断拓扑；如需进一步收敛可后续加鉴权

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 探测并发 vs 串行 | **并发 `Promise.all`** | 串行最坏 5×2s=10s，超出 3s 上限 |
| 超时粒度 | **每项独立 2s** | 全局超时无法区分是哪项慢，且一项挂起会拖垮全部 |
| 下游全挂返回 200 vs 5xx | **200** | 「服务不健康」是正常业务结果，非接口错误；5xx 会让前端误判端点本身故障 |
| Reranker 探测复用 vs 新写 | **复用 `LlamaCppReranker.health()`** | 避免与检索链路的判定标准不一致 |
| `ProbeResult` 携带错误信息 | **不携带，只留 `ok`** | 类型层面强制脱敏，比"记得别返回"可靠 |
| `unknown` 由谁产生 | **客户端**（探测未完成时） | 服务端探测完成后必有结论；`unknown` 表达的是"前端还没拿到" |
| 探测结果缓存 | **不缓存** | 状态需实时；缓存的 TTL 与一致性需单独评审 |
