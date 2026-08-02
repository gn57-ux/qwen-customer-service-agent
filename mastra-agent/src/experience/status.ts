/**
 * `experience:status` 的核心逻辑——三项服务连通性 + 按 status 分组的
 * 经验数量统计。**巡检命令，任一服务不可用不应该让命令本身失败**，
 * 只在对应字段里标注"离线"，CLI 脚本据此决定始终以退出码 0 结束。
 *
 * status 统计按文档数量（Markdown 文件数），不是 Qdrant 向量点数——
 * 每份经验对应 9 个小节 chunk/点，直接数点会把统计放大 9 倍。
 */

import type { RagConfig } from "../rag/config.ts";
import { createEmbeddingClient, type EmbeddingClient } from "../rag/embedding.ts";
import type { Reranker } from "../rag/rerank.ts";
import { scanExperienceFiles } from "./scan.ts";
import type { ExperienceStore } from "./store.ts";

export type CreateEmbeddingClientFn = (cfg: RagConfig) => Promise<EmbeddingClient>;

export interface ServiceStatus {
  available: boolean;
  detail: string;
}

export interface ExperienceStatusReport {
  collection: string;
  qdrant: ServiceStatus;
  embedding: ServiceStatus;
  reranker: ServiceStatus;
  countsByStatus: { candidate: number; verified: number; deprecated: number };
  /** 无法解析 frontmatter 的文件数（不计入上面的 status 统计） */
  unparseableCount: number;
}

async function probeQdrant(store: ExperienceStore): Promise<ServiceStatus> {
  try {
    const detail = await store.health();
    return { available: true, detail };
  } catch (e) {
    return { available: false, detail: (e as Error).message };
  }
}

async function probeEmbedding(cfg: RagConfig, createEmbedder: CreateEmbeddingClientFn): Promise<ServiceStatus> {
  try {
    const client = await createEmbedder(cfg);
    return { available: true, detail: `${client.model}，${client.dimension} 维` };
  } catch (e) {
    return { available: false, detail: (e as Error).message };
  }
}

async function probeReranker(reranker: Reranker): Promise<ServiceStatus> {
  const health = await reranker.health();
  return { available: health.available, detail: health.detail };
}

export async function getExperienceStatus(
  cfg: RagConfig,
  store: ExperienceStore,
  reranker: Reranker,
  createEmbedder: CreateEmbeddingClientFn = createEmbeddingClient,
): Promise<ExperienceStatusReport> {
  const [qdrant, embedding, rerankerStatus] = await Promise.all([
    probeQdrant(store),
    probeEmbedding(cfg, createEmbedder),
    probeReranker(reranker),
  ]);

  const files = await scanExperienceFiles(cfg.knowledgeRoot);
  const countsByStatus = { candidate: 0, verified: 0, deprecated: 0 };
  let unparseableCount = 0;
  for (const file of files) {
    if (!file.frontmatter) {
      unparseableCount += 1;
      continue;
    }
    const status = file.frontmatter.status;
    if (status === "candidate" || status === "verified" || status === "deprecated") {
      countsByStatus[status] += 1;
    } else {
      unparseableCount += 1;
    }
  }

  return {
    collection: cfg.collection,
    qdrant,
    embedding,
    reranker: rerankerStatus,
    countsByStatus,
    unparseableCount,
  };
}
