/**
 * GET /customer-service/status 的下游探测层。
 *
 * 硬性口径（需求 §5.5 需求 B）：
 * - 每项探测独立超时（默认 2s），并发执行，任一下游挂起不得阻塞整体响应；
 * - 探测结果对外只暴露 `{ ok: boolean }`——错误细节（URL/端口/堆栈/原始异常
 *   消息）只写服务端日志，从类型层面杜绝脱敏泄露；
 * - Reranker 探测复用现有 `LlamaCppReranker.health()`（rag/rerank.ts），
 *   不另写一套判定逻辑，避免和检索链路（search-knowledge-base-tool.ts）的
 *   降级语义不一致；
 * - `localModel` 探测的是 FastAPI 正式推理入口（`services/app.py`，默认
 *   `:8000`）的 `/health`，**不是** llama-server（`:8002`）本身——`:8002`
 *   只在 FastAPI 进程内部转发，Mastra/web-client 均不允许直连（见下方
 *   `parseFastApiHealthStatus()` 注释与 requirements.md F-005）。
 */

import { loadConfig } from "../../rag/config.ts";
import { createReranker, loadRerankerConfig } from "../../rag/rerank.ts";
import { QdrantKnowledgeStore } from "../../rag/store.ts";
import { LOCAL_LLM_BASE_URL } from "../agents/customer-service-agent.ts";
import type { ServiceStatusBody } from "../contract.ts";

export interface ProbeResult {
  ok: boolean;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * 统一探测包装器：`Promise.race` 对抗超时，而不是给 check() 塞一个它未必支持的
 * AbortSignal——本文件复用的 `QdrantKnowledgeStore.health()` 与
 * `LlamaCppReranker.health()` 都是内部自带超时、不接受外部 signal 的实现，
 * 强行传信号既做不到真正取消，也徒增复杂度。`Promise.race` 保证 probe() 本身
 * 总能在 timeoutMs 内返回——即便被包装的 check() 仍在后台跑（不会造成未处理的
 * rejection，因为下面已经内联 `.catch`），这就满足了"任一下游挂起不得阻塞整体
 * 响应"的要求。
 *
 * 异常永不外抛，一律归一为 `{ ok: false }`；细节只写日志，绝不进返回值。
 */
export async function probe(name: string, check: () => Promise<boolean>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const guardedCheck = check().catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[health] ${name} 探测失败：${detail}`); // 细节只进日志，不进返回值
    return false;
  });
  try {
    const ok = await Promise.race([guardedCheck, timeout]);
    return { ok };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 本地模型：探测的是 FastAPI（services/app.py，默认 :8000）的正式推理入口，
 * 不是 llama-server（:8002）本身，且**不允许** Mastra 或 web-client 直连
 * :8002。原因见 agents/customer-service-agent.ts 顶部注释——"生成模型必须走
 * FastAPI 的 OpenAI 兼容接口，不允许直连内部 llama-server，8002 只在 FastAPI
 * 进程内部转发，不应该被任何客户端直接访问"。这是本 feature 权威口径（见
 * specs/2.service-status-endpoint/requirements.md F-005、design.md 模块 1），
 * 不是 tasks.md 里的临时偏差记录。
 *
 * 判定标准是 FastAPI `/health` 响应体里的 `status === "ok"`，而不仅仅是
 * HTTP 2xx——FastAPI 的 `/health` 在 `not_loaded`/`degraded` 时也返回 200，
 * 只有 body 里的 status 字段能反映真实可用性（见 services/app.py，本 feature
 * 不改这个文件，只读它的响应契约）。
 */
export function parseFastApiHealthStatus(httpOk: boolean, body: unknown): boolean {
  if (!httpOk) return false;
  const status = (body as { status?: unknown } | null)?.status;
  return status === "ok";
}

async function checkLocalModel(): Promise<boolean> {
  const base = LOCAL_LLM_BASE_URL.replace(/\/v1\/?$/, "");
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
  const body = res.ok ? await res.json() : null;
  return parseFastApiHealthStatus(res.ok, body);
}

export async function probeLlamaServer(): Promise<ProbeResult> {
  return probe("localModel", checkLocalModel);
}

/** 复用 QdrantKnowledgeStore.health()（REST /readyz），不另写一套探测。 */
async function checkQdrant(): Promise<boolean> {
  const store = new QdrantKnowledgeStore(loadConfig());
  await store.health(); // 失败时抛错，由 probe() 统一捕获归一
  return true;
}

export async function probeQdrant(): Promise<ProbeResult> {
  return probe("qdrant", checkQdrant);
}

/**
 * Embedding：轻量检查——命中 Ollama 的 OpenAI 兼容 `/v1/models`，确认配置的
 * embeddingModel 确实在服务端已加载，而不是发起一次真实 embedding 推理
 * （createEmbeddingClient() 那种重量级校验留给摄取/检索路径自己做）。
 *
 * 实测发现：Ollama 的 `/v1/models` 返回的 id 带 tag 后缀（如 `bge-m3:latest`），
 * 而 `EMBEDDING_MODEL` 配置通常不带 tag（如 `bge-m3`，Ollama 隐式当作
 * `:latest`）。两边**都**要先按 `:` 拆出 base name 再比较——只归一化 id 一侧
 * 会漏掉"配置本身就带 tag"的情况（如配置写成 `bge-m3:latest`，id 也是
 * `bge-m3:latest`，两边不做归一化直接比较其实凑巧能过，但配置写
 * `bge-m3:v1`、id 是 `bge-m3:v2` 这类场景就会得到不一致的判断）。
 * 当前需求只是"确认配置的模型确实存在"，不校验具体 tag/版本是否一致，因此
 * 按 base name 精确比较（不做 includes/startsWith 之类的模糊匹配，避免
 * "bge-m3-v2" 误命中 "bge-m3" 这类假阳性）。
 */
function modelBaseName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.split(":")[0];
}

export function matchesModelName(id: unknown, target: string): boolean {
  const actual = modelBaseName(id);
  const expected = modelBaseName(target);
  return actual !== undefined && expected !== undefined && actual === expected;
}

async function checkEmbedding(): Promise<boolean> {
  const cfg = loadConfig();
  const url = `${cfg.embeddingBaseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) return false;
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = Array.isArray(body.data) ? body.data : [];
  return ids.some((m) => matchesModelName(m?.id, cfg.embeddingModel));
}

export async function probeEmbedding(): Promise<ProbeResult> {
  return probe("embedding", checkEmbedding);
}

/** 复用 LlamaCppReranker.health()，避免和检索链路的降级判定标准不一致。 */
async function checkReranker(): Promise<boolean> {
  const reranker = createReranker(loadRerankerConfig());
  const health = await reranker.health();
  return health.available;
}

export async function probeReranker(): Promise<ProbeResult> {
  return probe("reranker", checkReranker);
}

/**
 * 订单服务：base URL 与健康端点复用 tools/query-order-tool.ts 里的同一份配置
 * （`MOCK_BACKEND_URL` 环境变量，默认 `http://127.0.0.1:8001`，健康端点
 * `/health`，见 services/mock_backend.py）——这里不新增环境变量，只是读取同一个
 * 既有变量；query-order-tool.ts 不在本 feature 允许改动的文件范围内，因此不
 * 从那边导出符号，而是在此处显式重复同一表达式。两处一旦哪边改了默认值/变量名
 * 都要同步改，这是为了不越权修改订单工具文件而做的取舍。
 */
async function checkOrderService(): Promise<boolean> {
  const mockBackendUrl = process.env.MOCK_BACKEND_URL ?? "http://127.0.0.1:8001";
  const res = await fetch(`${mockBackendUrl}/health`, { signal: AbortSignal.timeout(1500) });
  return res.ok;
}

export async function probeOrderService(): Promise<ProbeResult> {
  return probe("orderService", checkOrderService);
}

/**
 * 知识库聚合语义：Reranker 是**增强**能力，失效只降级不致命；Qdrant/Embedding
 * 是**基础检索**能力，任一失效即致命——与 search-knowledge-base-tool.ts 现有的
 * `reranked:false + degraded:true`（Reranker 挂但仍返回向量顺序结果）降级语义
 * 完全对齐，不是另一套独立标准。
 */
export function aggregateKnowledgeBase(
  qdrant: ProbeResult,
  embedding: ProbeResult,
  reranker: ProbeResult,
): "online" | "degraded" | "error" {
  const baseOk = qdrant.ok && embedding.ok;
  if (!baseOk) return "error";
  return reranker.ok ? "online" : "degraded";
}

/**
 * 四项探测并发执行（`Promise.all` + 每项独立超时 ⇒ 整体耗时 ≈ 最慢一项，
 * 满足 ≤3s 上限），聚合为最终的三字段响应体。服务端探测完成后必有确定结论，
 * 不会返回 `unknown`——那是客户端在探测尚未完成时的展示态，不由这里产生。
 */
export async function collectServiceStatus(): Promise<ServiceStatusBody> {
  const [llamaServer, qdrant, embedding, reranker, orderService] = await Promise.all([
    probeLlamaServer(),
    probeQdrant(),
    probeEmbedding(),
    probeReranker(),
    probeOrderService(),
  ]);

  return {
    localModel: llamaServer.ok ? "online" : "error",
    knowledgeBase: aggregateKnowledgeBase(qdrant, embedding, reranker),
    orderService: orderService.ok ? "online" : "error",
  };
}
