/**
 * 独立 Reranker：对向量召回结果做 query/document 逐对交叉编码重排。
 *
 * 硬性口径（Review 要求）：
 * - 这是**真正的 cross-encoder**：query 与 document 拼成一条序列走同一次前向，
 *   由 bge-reranker-v2-m3 直接输出相关性分数。**不是**向量分数加权。
 * - `vectorScore` 与 `rerankScore` **分别保留**，绝不合成"综合分"。
 * - Reranker 不可用时返回 `unavailable`，**不静默退回向量顺序**；
 *   只有显式 `RERANK_ENABLED=false` 才是 `disabled`。
 * - `risk_level` 不参与打分。安全规则属于后续 System Prompt / 安全路由，
 *   不混进 Rerank 分数里。
 *
 * 可插拔：实现 `Reranker` 接口即可替换（例如换成别的模型或托管服务），
 * 调用方只依赖接口，不依赖 llama.cpp。
 */

export type RerankStatus = "ok" | "unavailable" | "disabled";

export interface RerankDocument {
  /** 调用方的稳定标识，用于把 Reranker 返回的下标映射回原始文档 */
  id: string;
  text: string;
}

export interface RerankScored {
  id: string;
  /** Reranker 给出的相关性分数；unavailable / disabled 时为 null */
  rerankScore: number | null;
  /** 重排后的名次，从 1 开始；unavailable / disabled 时为 null */
  rerankRank: number | null;
}

export interface RerankResult {
  status: RerankStatus;
  /** status=ok 时按 rerankScore 降序、已截断到 topK；否则为空数组 */
  ranked: RerankScored[];
  /** 非 ok 时说明原因，供上层如实展示 */
  reason?: string;
  /** Reranker 端到端耗时（毫秒），未执行时为 null */
  elapsedMs: number | null;
  /** 实际送进 Reranker 的候选数量 */
  candidateCount: number;
  rerankerName: string;
}

export interface RerankerHealth {
  available: boolean;
  detail: string;
}

export interface Reranker {
  readonly name: string;
  /** 可用性探测，不抛错，把结果放进返回值 */
  health(): Promise<RerankerHealth>;
  /**
   * 对 documents 逐对打分并返回前 topK。
   * 实现必须保证返回的 id 全部来自入参，且不重复、不越界。
   */
  rerank(query: string, documents: RerankDocument[], topK: number): Promise<RerankResult>;
}

export interface RerankerConfig {
  enabled: boolean;
  baseUrl: string;
  /** 连接 + 读取总超时 */
  requestTimeoutMs: number;
  /** 健康检查超时，比请求短 */
  healthTimeoutMs: number;
}

export function loadRerankerConfig(): RerankerConfig {
  const enabledRaw = (process.env.RERANK_ENABLED ?? "true").trim().toLowerCase();
  return {
    enabled: !["false", "0", "no", "off"].includes(enabledRaw),
    baseUrl: (process.env.RERANK_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, ""),
    requestTimeoutMs: Number(process.env.RERANK_TIMEOUT_MS || 60_000),
    healthTimeoutMs: Number(process.env.RERANK_HEALTH_TIMEOUT_MS || 3_000),
  };
}

/** 错误信息只保留可操作的部分，不回显环境变量、路径等无关信息 */
function safeReason(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.split("\n")[0]!.slice(0, 160);
  return `${prefix}：${trimmed}`;
}

interface LlamaRerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>;
  error?: { message?: string } | string;
}

/**
 * llama.cpp（llama-server --reranking）实现。
 * 一次批量请求把全部候选送过去，**不逐条发 N 次请求**。
 */
export class LlamaCppReranker implements Reranker {
  readonly name = "llama.cpp/bge-reranker-v2-m3";
  private readonly cfg: RerankerConfig;

  constructor(cfg: RerankerConfig) {
    this.cfg = cfg;
  }

  async health(): Promise<RerankerHealth> {
    if (!this.cfg.enabled) {
      return { available: false, detail: "RERANK_ENABLED=false，已显式关闭" };
    }
    try {
      const response = await fetch(`${this.cfg.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.cfg.healthTimeoutMs),
      });
      if (!response.ok) {
        return { available: false, detail: `健康检查返回 HTTP ${response.status}` };
      }
      return { available: true, detail: `${this.cfg.baseUrl} 健康` };
    } catch (error) {
      return { available: false, detail: safeReason("无法连接 Reranker 服务", error) };
    }
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    topK: number,
  ): Promise<RerankResult> {
    const base = {
      candidateCount: documents.length,
      rerankerName: this.name,
    };

    if (!this.cfg.enabled) {
      return {
        ...base,
        status: "disabled",
        ranked: [],
        reason: "RERANK_ENABLED=false，本次未执行 Rerank",
        elapsedMs: null,
      };
    }
    // topK 必须是大于 0 的有限整数；非法 topK 不允许产生伪成功结果
    if (typeof topK !== "number" || !Number.isFinite(topK) || !Number.isInteger(topK) || topK <= 0) {
      return {
        ...base,
        status: "unavailable",
        ranked: [],
        reason: `topK 非法：${String(topK)}，必须是大于 0 的有限整数`,
        elapsedMs: null,
      };
    }
    if (documents.length === 0) {
      return { ...base, status: "ok", ranked: [], elapsedMs: 0 };
    }

    const started = Date.now();
    let payload: LlamaRerankResponse;
    try {
      // 一次请求送全部候选（批量），而不是每个文档发一次
      const response = await fetch(`${this.cfg.baseUrl}/v1/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "reranker",
          query,
          documents: documents.map((d) => d.text),
          top_n: documents.length, // 先全量打分，截断由本地做，便于记录完整名次
        }),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });

      const text = await response.text();
      if (!response.ok) {
        return {
          ...base,
          status: "unavailable",
          ranked: [],
          reason: `Reranker 返回 HTTP ${response.status}`,
          elapsedMs: Date.now() - started,
        };
      }
      payload = JSON.parse(text) as LlamaRerankResponse;
    } catch (error) {
      return {
        ...base,
        status: "unavailable",
        ranked: [],
        reason: safeReason("Reranker 请求失败", error),
        elapsedMs: Date.now() - started,
      };
    }

    const elapsedMs = Date.now() - started;
    const results = payload.results;
    if (!Array.isArray(results) || results.length === 0) {
      return {
        ...base,
        status: "unavailable",
        ranked: [],
        reason: "Reranker 响应中没有 results",
        elapsedMs,
      };
    }

    // 下标映射校验：必须落在入参范围内且不重复，否则视为不可用而非将错就错
    const seen = new Set<number>();
    const scored: Array<{ id: string; rerankScore: number }> = [];
    for (const item of results) {
      const index = item.index;
      const score = item.relevance_score;
      if (typeof index !== "number" || !Number.isInteger(index)) {
        return {
          ...base,
          status: "unavailable",
          ranked: [],
          reason: `Reranker 返回了非法 index：${String(index)}`,
          elapsedMs,
        };
      }
      if (index < 0 || index >= documents.length) {
        return {
          ...base,
          status: "unavailable",
          ranked: [],
          reason: `Reranker 返回的 index 越界：${index}（候选 ${documents.length} 个）`,
          elapsedMs,
        };
      }
      if (seen.has(index)) {
        return {
          ...base,
          status: "unavailable",
          ranked: [],
          reason: `Reranker 返回了重复 index：${index}`,
          elapsedMs,
        };
      }
      // 必须是有限数：NaN、Infinity、-Infinity 都不可用于排序
      if (typeof score !== "number" || !Number.isFinite(score)) {
        return {
          ...base,
          status: "unavailable",
          ranked: [],
          reason: `Reranker 返回了非法 relevance_score：${String(score)}`,
          elapsedMs,
        };
      }
      seen.add(index);
      scored.push({ id: documents[index]!.id, rerankScore: score });
    }

    scored.sort((a, b) => b.rerankScore - a.rerankScore);
    const ranked: RerankScored[] = scored
      .slice(0, topK)
      .map((item, i) => ({ id: item.id, rerankScore: item.rerankScore, rerankRank: i + 1 }));

    return { ...base, status: "ok", ranked, elapsedMs };
  }
}

export function createReranker(cfg: RerankerConfig = loadRerankerConfig()): Reranker {
  return new LlamaCppReranker(cfg);
}
