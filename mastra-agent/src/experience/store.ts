/**
 * 工作流经验的独立向量存储层。
 *
 * 接口形状对齐 `rag/store.ts` 的 `KnowledgeStore`（同名方法签名），但是
 * **独立实现**（不 extends/import `QdrantKnowledgeStore`）——两边独立
 * 演进比强行抽象共享基类更安全，客服知识库的行为不该因为经验库的需求
 * 变化而被动调整。构造函数用独立的 Mastra vector id
 * （"claude-workflow-experience"，区别于 `QdrantKnowledgeStore` 的
 * "customer-service-knowledge"），避免 Mastra 内部按 id 索引 vector
 * store 实例时互相覆盖。
 */

import { QdrantVector } from "@mastra/qdrant";

import type { RagConfig } from "../rag/config.ts";
import type {
  ExistingPoint,
  IndexDescription,
  KnowledgeStore,
  ScopeFilter,
  StoreHit,
  StorePoint,
} from "../rag/store.ts";

export interface ExperienceQueryFilter {
  stage?: string;
  taskType?: string;
  /** OR 语义：命中其一即可，用于"当前项目 + global"这类多值匹配 */
  projectScopeIn?: string[];
  riskLevel?: string;
  status?: string;
}

/**
 * 把 `ExperienceQueryFilter` 翻译成 `QdrantVector.query()` 期望的
 * MongoDB 风格扁平 filter 对象——同一对象内的多个字段自动 AND，
 * `projectScopeIn` 用 `$in` 表达 OR/any-of 语义，由
 * `QdrantFilterTranslator` 翻译为 Qdrant 原生 REST 的 `match: { any }`。
 * **不要在这里手写 Qdrant 原生 REST 的 `must`/`match` 数组直接传给
 * filter 参数**——那是翻译器的输出形状，不是输入形状，会被翻译器当成
 * 字段名 `must` 去匹配，静默匹配不到任何结果，还会破坏
 * `knowledge_set` 隔离保险（已通过检查本机 `@mastra/qdrant` 源码确认）。
 * 独立导出这个纯函数是为了不依赖真实 Qdrant/QdrantVector 就能单元测试
 * 过滤条件构造是否正确——这是本模块唯一区别于 `QdrantKnowledgeStore`
 * 的正确性关键逻辑，其余方法都是常规 CRUD 转发。
 */
export function buildExperienceFilter(
  knowledgeSet: string,
  extraFilter?: ExperienceQueryFilter,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { knowledge_set: knowledgeSet };
  if (extraFilter?.stage) filter.stage = extraFilter.stage;
  if (extraFilter?.taskType) filter.task_type = extraFilter.taskType;
  if (extraFilter?.riskLevel) filter.risk_level = extraFilter.riskLevel;
  if (extraFilter?.status) filter.status = extraFilter.status;
  if (extraFilter?.projectScopeIn?.length) {
    filter.project_scope = { $in: extraFilter.projectScopeIn };
  }
  return filter;
}

const TIMEOUT_MS = 30_000;

function scopeCondition(filter: ScopeFilter): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [
    { key: "knowledge_set", match: { value: filter.knowledgeSet } },
  ];
  if (filter.scope !== undefined) {
    must.push({ key: "ingestion_scope", match: { value: filter.scope } });
  }
  return { must };
}

export class ExperienceStore implements KnowledgeStore {
  readonly indexName: string;
  readonly knowledgeSet: string;
  private readonly vector: QdrantVector;
  private readonly baseUrl: string;

  constructor(cfg: RagConfig) {
    this.indexName = cfg.collection;
    this.knowledgeSet = cfg.knowledgeSet;
    this.baseUrl = cfg.qdrantUrl.replace(/\/$/, "");
    this.vector = new QdrantVector({ id: "claude-workflow-experience", url: this.baseUrl });
  }

  private async rest<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; result: T }> {
    const url = `${this.baseUrl}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(
        `无法连接 Qdrant ${url}：${(cause as Error).message}\n` +
          `请先启动：npm run rag:qdrant:up（或确认 QDRANT_URL 配置正确）。`,
        { cause },
      );
    }
    const text = await response.text();
    let payload: { result?: T; status?: unknown } = {};
    if (text) {
      try {
        payload = JSON.parse(text) as { result?: T; status?: unknown };
      } catch {
        throw new Error(`Qdrant 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
      }
    }
    if (!response.ok && response.status !== 404) {
      const detail =
        typeof payload.status === "object" && payload.status !== null
          ? JSON.stringify(payload.status)
          : text.slice(0, 300);
      throw new Error(`Qdrant 请求失败 ${method} ${pathname}（HTTP ${response.status}）：${detail}`);
    }
    return { status: response.status, result: payload.result as T };
  }

  async health(): Promise<string> {
    const url = `${this.baseUrl}/readyz`;
    let ready: Response;
    try {
      ready = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new Error(
        `无法连接 Qdrant ${url}：${(cause as Error).message}\n` +
          `请先启动：npm run rag:qdrant:up（或确认 QDRANT_URL 配置正确）。`,
        { cause },
      );
    }
    const readyText = (await ready.text()).trim();
    if (!ready.ok) {
      throw new Error(`Qdrant 未就绪（HTTP ${ready.status}）：${readyText.slice(0, 200)}`);
    }
    let version = "unknown";
    try {
      const root = (await (
        await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      ).json()) as { version?: string };
      version = root.version ?? version;
    } catch {
      // 根路径不可解析不影响健康判定
    }
    return `qdrant ${version}（readyz: ${readyText || "ok"}）`;
  }

  async describe(): Promise<IndexDescription> {
    const { status } = await this.rest<unknown>(
      "GET",
      `/collections/${encodeURIComponent(this.indexName)}`,
    );
    if (status === 404) return { exists: false };
    const stats = await this.vector.describeIndex({ indexName: this.indexName });
    return {
      exists: true,
      dimension: stats.dimension,
      metric: stats.metric,
      count: stats.count,
    };
  }

  async listPoints(filter: ScopeFilter): Promise<ExistingPoint[]> {
    const out: ExistingPoint[] = [];
    let offset: unknown = undefined;
    do {
      const { result } = await this.rest<{
        points?: Array<{ id: string | number; payload?: Record<string, unknown> }>;
        next_page_offset?: unknown;
      }>("POST", `/collections/${encodeURIComponent(this.indexName)}/points/scroll`, {
        filter: scopeCondition(filter),
        limit: 256,
        with_payload: ["document_id"],
        with_vector: false,
        offset,
      });
      for (const point of result?.points ?? []) {
        out.push({
          id: String(point.id),
          documentId: String(point.payload?.document_id ?? ""),
        });
      }
      offset = result?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return out;
  }

  async countPoints(filter?: ScopeFilter): Promise<number> {
    const { result } = await this.rest<{ count?: number }>(
      "POST",
      `/collections/${encodeURIComponent(this.indexName)}/points/count`,
      filter ? { exact: true, filter: scopeCondition(filter) } : { exact: true },
    );
    return result?.count ?? 0;
  }

  /**
   * 局部更新已存在向量点的 payload 字段（Qdrant 原生 REST 的
   * `points/payload` "set payload"，合并写入，不影响未列出的字段/
   * 向量本身）——供 `experience:finalize` 更新 `status` 字段用，不需要
   * 重新 embedding 正文（status 变化不影响语义）。QdrantVector 没有
   * 暴露这个能力，与本类其余"原生 REST 补充"操作同类。传入的 id 若
   * 在 Collection 里不存在，Qdrant 静默忽略，不报错——调用方若需要
   * "确认更新命中"，应自行先 `describe()`/`listPoints()` 核实。
   */
  async updatePayload(ids: string[], payload: Record<string, unknown>): Promise<void> {
    if (ids.length === 0) return;
    await this.rest("POST", `/collections/${encodeURIComponent(this.indexName)}/points/payload`, {
      payload,
      points: ids,
    });
  }

  /**
   * 确认给定 id 是否**全部**已存在于 Collection 里（Qdrant 原生 REST 的
   * "retrieve points by id"，只返回真实存在的点）——供 `experience:finalize`
   * 在调用 `updatePayload()` 前核实，因为后者对不存在的 id 静默忽略、不
   * 报错，单靠它的返回值无法判断"晋升"是否真的让向量变得可检索
   * （Codex Review 指出：`experience:write` 曾因 Embedding/Qdrant 不可用
   * 而降级为只写 Markdown 时，finalize 若不做这层核实，会在向量完全
   * 缺失的情况下依然报告 `promoted`/`already_verified`）。空数组视为
   * "全部存在"（无需检查）。
   */
  async pointsExist(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const { result } = await this.rest<{ id: string | number }[]>(
      "POST",
      `/collections/${encodeURIComponent(this.indexName)}/points`,
      { ids, with_payload: false, with_vector: false },
    );
    const foundIds = new Set((result ?? []).map((point) => String(point.id)));
    return ids.every((id) => foundIds.has(id));
  }

  async createIndex(dimension: number, metric: "cosine"): Promise<void> {
    await this.vector.createIndex({ indexName: this.indexName, dimension, metric });
  }

  async deleteIndex(): Promise<void> {
    await this.vector.deleteIndex({ indexName: this.indexName });
  }

  async createPayloadIndexes(fields: string[]): Promise<void> {
    for (const fieldName of fields) {
      await this.vector.createPayloadIndex({
        indexName: this.indexName,
        fieldName,
        fieldSchema: "keyword",
      });
    }
  }

  async upsert(points: StorePoint[]): Promise<void> {
    if (points.length === 0) return;
    const BATCH = 64;
    for (let i = 0; i < points.length; i += BATCH) {
      const slice = points.slice(i, i + BATCH);
      await this.vector.upsert({
        indexName: this.indexName,
        vectors: slice.map((p) => p.vector),
        metadata: slice.map((p) => p.payload),
        ids: slice.map((p) => p.id),
      });
    }
  }

  /**
   * 与 `KnowledgeStore.query()` 签名兼容（第三参数可选）；传入
   * `extraFilter` 时，在同一次 Qdrant query 请求里把 stage/taskType/
   * projectScopeIn/riskLevel/status 一并作为过滤条件下推，保证返回的
   * Top-K 本身就是"满足全部过滤条件的前 K 条"，不是"全库前 K 条里凑巧
   * 满足条件的子集"（应用层再过滤会让明明存在的匹配记录因为被挤出
   * 向量相似度前 K 而漏检，是正确性 bug，不是性能取舍）。
   */
  async query(vector: number[], topK: number, extraFilter?: ExperienceQueryFilter): Promise<StoreHit[]> {
    const filter = buildExperienceFilter(this.knowledgeSet, extraFilter);
    const results = await this.vector.query({
      indexName: this.indexName,
      queryVector: vector,
      topK,
      // `@mastra/qdrant` 的 `QdrantVectorFilter` 是为字面量对象设计的
      // 复杂条件类型，只在 filter 以内联字面量传入时才能做正确的分布式
      // 类型收窄——`rag/store.ts` 的既有代码正是靠"内联字面量"绕开了
      // 这个问题；这里把过滤条件构造独立成 `buildExperienceFilter()`
      // 是为了不依赖真实 Qdrant 就能单元测试构造逻辑本身（见函数顶部
      // 说明），因此改用类型断言。运行期真实形状与 rag/store.ts 现有
      // 用法完全一致（同为 MongoDB 风格扁平对象，`$in` 语义已通过检查
      // 本机安装的 QdrantFilterTranslator 源码确认），只是 TS 类型层面
      // 的已知限制，不代表运行期行为不确定。
      filter: filter as Parameters<QdrantVector["query"]>[0]["filter"],
    });
    return results.map((r) => ({ id: r.id, score: r.score, payload: r.metadata ?? {} }));
  }

  async deletePoints(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const BATCH = 256;
    for (let i = 0; i < ids.length; i += BATCH) {
      await this.vector.deleteVectors({
        indexName: this.indexName,
        ids: ids.slice(i, i + BATCH),
      });
    }
  }
}
