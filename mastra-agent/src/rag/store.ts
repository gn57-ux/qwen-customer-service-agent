/**
 * 知识库存储层。
 *
 * 分工（Review 要求的核心）：
 * - **Mastra `QdrantVector`** 负责所有常规向量操作：
 *   createIndex / describeIndex / upsert / query / deleteVectors / createPayloadIndex。
 * - **原生 REST** 只保留 QdrantVector **没有暴露** 的三类管理操作：
 *   1) `/readyz` 服务健康探活；
 *   2) `points/scroll` 按 payload 过滤翻页列点 ID（QdrantVector 无 scroll，
 *      而 stale 识别与"文档被删除"检测必须拿到库里现存的点 ID 及其 document_id）；
 *   3) `points/count` 带 filter 的精确计数（describeIndex 只给 Collection 总数，
 *      无法回答"当前 knowledge_set / scope 有多少点"）。
 *   4) Collection 是否存在的 404 判定（describeIndex 在缺失时抛错，
 *      需要区分"不存在"与"真实故障"）。
 *
 * 通过 KnowledgeStore 接口注入，测试可以替换实现来模拟 upsert 失败等场景。
 */

import { QdrantVector } from "@mastra/qdrant";

import type { RagConfig } from "./config.ts";

export interface StorePoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface StoreHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface ExistingPoint {
  id: string;
  documentId: string;
}

export interface ScopeFilter {
  knowledgeSet: string;
  /** 省略表示不限制 scope（用于统计整个 knowledge_set） */
  scope?: string;
}

export interface IndexDescription {
  exists: boolean;
  dimension?: number;
  metric?: string;
  count?: number;
}

export interface KnowledgeStore {
  readonly indexName: string;
  /** 服务健康（REST /readyz） */
  health(): Promise<string>;
  /** Collection 描述；不存在时 exists=false（REST 判 404 + QdrantVector.describeIndex） */
  describe(): Promise<IndexDescription>;
  /** 创建 Collection（QdrantVector.createIndex） */
  createIndex(dimension: number, metric: "cosine"): Promise<void>;
  /** 删除 Collection（QdrantVector.deleteIndex），仅 --recreate 调用 */
  deleteIndex(): Promise<void>;
  /** payload 字段索引（QdrantVector.createPayloadIndex） */
  createPayloadIndexes(fields: string[]): Promise<void>;
  /** 写入向量（QdrantVector.upsert） */
  upsert(points: StorePoint[]): Promise<void>;
  /**
   * 相似检索（QdrantVector.query）。
   * 始终按 knowledge_set 过滤，避免同 Collection 内其他知识集串库；
   * 默认不限制 ingestion_scope —— 客服查询需要同时覆盖 repair 与将来的 policies。
   */
  query(vector: number[], topK: number): Promise<StoreHit[]>;
  /** 按 ID 删除（QdrantVector.deleteVectors） */
  deletePoints(ids: string[]): Promise<void>;
  /** 按 scope 过滤列出现存点及其 document_id（REST scroll） */
  listPoints(filter: ScopeFilter): Promise<ExistingPoint[]>;
  /** 精确计数；不传 filter 表示整个 Collection（REST count） */
  countPoints(filter?: ScopeFilter): Promise<number>;
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

export class QdrantKnowledgeStore implements KnowledgeStore {
  readonly indexName: string;
  /** 本实例归属的知识集合；所有 query 都会按它过滤 */
  readonly knowledgeSet: string;
  private readonly vector: QdrantVector;
  private readonly baseUrl: string;

  constructor(cfg: RagConfig) {
    this.indexName = cfg.collection;
    this.knowledgeSet = cfg.knowledgeSet;
    this.baseUrl = cfg.qdrantUrl.replace(/\/$/, "");
    // Mastra 的 Qdrant 向量库客户端：常规 upsert / query / index 管理都走它
    this.vector = new QdrantVector({ id: "customer-service-knowledge", url: this.baseUrl });
  }

  // ---- 以下 4 个方法走原生 REST（QdrantVector 未暴露对应能力）----------------

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

  /** REST：/readyz 返回纯文本，QdrantVector 没有健康探活接口 */
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

  /** REST 判存在（404 与真实故障要分开），存在时用 QdrantVector.describeIndex 取统计 */
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

  /** REST：scroll 分页列点，QdrantVector 无 scroll 能力 */
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

  /** REST：带 filter 的精确计数，describeIndex 只能给 Collection 总数 */
  async countPoints(filter?: ScopeFilter): Promise<number> {
    const { result } = await this.rest<{ count?: number }>(
      "POST",
      `/collections/${encodeURIComponent(this.indexName)}/points/count`,
      filter ? { exact: true, filter: scopeCondition(filter) } : { exact: true },
    );
    return result?.count ?? 0;
  }

  // ---- 以下全部通过 Mastra QdrantVector -------------------------------------

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

  async query(vector: number[], topK: number): Promise<StoreHit[]> {
    // 按 knowledge_set 隔离：同一个 Collection 里可能并存其他知识集
    // （例如将来的其他业务线），不加这层过滤会串库。
    // 不限制 ingestion_scope —— 客服查询要同时覆盖 repair 与将来的 policies。
    // filter 走 QdrantVector 的 MongoDB 风格语法，由 QdrantFilterTranslator
    // 翻译为 { must: [{ key, match: { value } }] }。
    const results = await this.vector.query({
      indexName: this.indexName,
      queryVector: vector,
      topK,
      filter: { knowledge_set: this.knowledgeSet },
    });
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.metadata ?? {},
    }));
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
