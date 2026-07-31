/**
 * searchKnowledgeBase：向量召回 Top20 → 独立 Reranker 重排 Top5。
 *
 * 复用 src/rag/{config,embedding,store,rerank}.ts 的现成实现（与 rag:search /
 * rerank.test.ts 同一套逻辑），不重新实现召回/重排——这里只是把它包装成一个
 * Agent 可调用的 Tool。
 *
 * 硬性口径：
 * - 只检索 knowledge_set=customer-service（QdrantKnowledgeStore 已固定过滤，
 *   这里不做任何额外放宽）；
 * - vectorScore / rerankScore 分别保留，不合成综合分；
 * - Reranker 不可用（unavailable）或显式关闭（disabled）时，明确标记
 *   `reranked: false` + `degraded: true` + `degradedReason`，返回向量顺序
 *   Top5 并把 rerankScore 设为 null——不静默冒充已完成 Rerank。
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { loadConfig, type RagConfig } from "../../rag/config.ts";
import { createEmbeddingClient, type EmbeddingClient } from "../../rag/embedding.ts";
import { createReranker, loadRerankerConfig, type RerankDocument } from "../../rag/rerank.ts";
import { QdrantKnowledgeStore, type StoreHit } from "../../rag/store.ts";

const RECALL_TOP_N = Number(process.env.RAG_RECALL_TOP_N || 20);
const FINAL_TOP_K = Number(process.env.RAG_FINAL_TOP_K || 5);

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : String(value ?? "");
}

// 懒加载并缓存 embedder/store：两者构造时都会对真实服务做一次实测校验，
// 每次调用工具都重建会白白多打一次探测请求。
let clientsPromise: Promise<{ cfg: RagConfig; embedder: EmbeddingClient; store: QdrantKnowledgeStore }> | null =
  null;

async function getClients() {
  if (!clientsPromise) {
    clientsPromise = (async () => {
      const cfg = loadConfig();
      const embedder = await createEmbeddingClient(cfg);
      const store = new QdrantKnowledgeStore(cfg);
      return { cfg, embedder, store };
    })().catch((error) => {
      // 校验失败不缓存失败态，下次调用允许重试（例如 Ollama 刚重启完）
      clientsPromise = null;
      throw error;
    });
  }
  return clientsPromise;
}

/** 仅测试使用：重置缓存的 embedder/store，避免测试之间互相污染配置 */
export function __resetSearchKnowledgeBaseClientsForTest(): void {
  clientsPromise = null;
}

const resultItemSchema = z.object({
  title: z.string(),
  section: z.string(),
  sourceFile: z.string(),
  documentVersion: z.string(),
  vectorScore: z.number(),
  rerankScore: z.number().nullable(),
  text: z.string(),
});

export interface SearchResultItem {
  title: string;
  section: string;
  sourceFile: string;
  documentVersion: string;
  vectorScore: number;
  rerankScore: number | null;
  text: string;
}

export interface SearchKnowledgeBaseResult {
  reranked: boolean;
  degraded: boolean;
  degradedReason?: string;
  retrievedCount: number;
  returnedCount: number;
  results: SearchResultItem[];
}

/**
 * 纯结果组装函数：接收已经召回的 hits，决定 reranked/degraded/retrievedCount/
 * returnedCount/results 四类分支的最终形状。retrievedCount 恒等于 hits.length
 * （调用方传入的真实召回数组长度），returnedCount 恒等于最终 results.length——
 * 不引用 RECALL_TOP_N/FINAL_TOP_K 配置值。
 *
 * 从 execute() 中提取出来是为了让 hits=[]（空召回）等分支可以在测试里直接传入
 * 一个真实的空数组触发，而不必依赖真实 Qdrant 返回空结果这种不可控条件——
 * 不改变召回（store.query）与重排（reranker.rerank）本身的调用方式或行为。
 */
export async function assembleSearchResult(query: string, hits: StoreHit[]): Promise<SearchKnowledgeBaseResult> {
  if (hits.length === 0) {
    return { reranked: false, degraded: false, retrievedCount: 0, returnedCount: 0, results: [] };
  }

  const byId = new Map(hits.map((h) => [h.id, h]));
  const docs: RerankDocument[] = hits.map((h) => ({ id: h.id, text: str(h.payload, "text") }));

  const reranker = createReranker(loadRerankerConfig());
  const rr = await reranker.rerank(query, docs, FINAL_TOP_K);

  const toItem = (hit: StoreHit, rerankScore: number | null): SearchResultItem => ({
    title: str(hit.payload, "title"),
    section: str(hit.payload, "section"),
    sourceFile: str(hit.payload, "source_file"),
    documentVersion: str(hit.payload, "document_version"),
    vectorScore: hit.score,
    rerankScore,
    text: str(hit.payload, "text"),
  });

  if (rr.status === "ok") {
    const results = rr.ranked.map((item) => toItem(byId.get(item.id)!, item.rerankScore));
    return { reranked: true, degraded: false, retrievedCount: hits.length, returnedCount: results.length, results };
  }

  // unavailable / disabled：明确降级，返回向量顺序 Top{FINAL_TOP_K}，
  // rerankScore 全部为 null，绝不用向量名次冒充已完成的 Rerank。
  const results = hits.slice(0, FINAL_TOP_K).map((hit) => toItem(hit, null));
  return {
    reranked: false,
    degraded: true,
    degradedReason:
      rr.reason ?? (rr.status === "disabled" ? "RERANK_ENABLED=false，本次未执行 Rerank" : "Reranker 不可用"),
    retrievedCount: hits.length,
    returnedCount: results.length,
    results,
  };
}

export const searchKnowledgeBaseTool = createTool({
  id: "search-knowledge-base",
  description:
    "在客服知识库（knowledge_set=customer-service）中检索维修/售后事实性内容：先向量召回 Top20，" +
    "再由独立 Reranker 交叉编码重排取 Top5。用于回答涉及故障排查步骤、安全边界、升级条件等" +
    "需要引用资料依据的问题，不用于订单实时状态查询。",
  inputSchema: z.object({
    query: z.string().min(1).describe("用户的原始问题或改写后的检索 query"),
  }),
  outputSchema: z.object({
    reranked: z.boolean().describe("true 表示结果已经过独立 Reranker 重排"),
    degraded: z.boolean().describe("true 表示 Reranker 不可用或被显式关闭，结果只是向量召回顺序"),
    degradedReason: z.string().optional(),
    retrievedCount: z.number().int().min(0).describe("向量检索实际命中数，等于 store.query() 返回的 hits.length"),
    returnedCount: z.number().int().min(0).describe("最终返回条数，等于 results.length"),
    results: z.array(resultItemSchema),
  }),
  execute: async ({ query }) => {
    const { embedder, store } = await getClients();
    const [vector] = await embedder.embed([query]);
    const hits = await store.query(vector!, RECALL_TOP_N);
    return assembleSearchResult(query, hits);
  },
});
