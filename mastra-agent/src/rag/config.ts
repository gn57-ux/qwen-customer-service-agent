/**
 * RAG 阶段的运行配置。
 *
 * 所有值都从环境变量读取，缺省值与 .env.example 保持一致。
 * 这里不做任何"静默回退"：Embedding 模型和维度必须显式，
 * 运行期再由 embedding.ts 对真实服务做实测校验。
 */

export interface RagConfig {
  qdrantUrl: string;
  collection: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  /** 期望向量维度；实际维度由 createEmbeddingClient() 实测并比对 */
  embeddingDimension: number;
  /** 语义距离，本阶段固定 Cosine */
  distance: "Cosine";
  /**
   * 知识集合标识，写进每个 chunk 的 payload。
   * 同一个 Qdrant Collection 里可以并存多个 knowledge_set；
   * 本阶段的客服知识统一是 customer-service。
   * `~/.claude` 工作流经验属于另一条线，使用独立 Collection，不在这里。
   */
  knowledgeSet: string;
  /** 知识库根目录（相对仓库根） */
  knowledgeRoot: string;
  /**
   * 要摄取的 glob 集合。默认只含 repair；
   * 将来加 policies 只需改这里或设置 KNOWLEDGE_GLOBS，不动核心代码。
   * 每个文件的 ingestion_scope 由它在 knowledgeRoot 下的第一层目录名决定，
   * 因此 "repair/*.md" → scope=repair，"policies/*.md" → scope=policies。
   */
  globs: string[];
  chunk: {
    /** 目标 chunk 上限（中文字符） */
    maxChars: number;
    /** 低于该长度的相邻同章节片段会被合并 */
    minChars: number;
    /** 重叠字符数 */
    overlapChars: number;
  };
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${name} 必须是正数，当前值：${raw}`);
  }
  return parsed;
}

export function loadConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  const globsRaw = process.env.KNOWLEDGE_GLOBS?.trim();
  const base: RagConfig = {
    qdrantUrl: process.env.QDRANT_URL || "http://127.0.0.1:6333",
    collection: process.env.QDRANT_COLLECTION || "customer_service_knowledge",
    embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:11434/v1",
    embeddingModel: process.env.EMBEDDING_MODEL || "bge-m3",
    embeddingDimension: num("EMBEDDING_DIMENSION", 1024),
    distance: "Cosine",
    knowledgeSet: process.env.KNOWLEDGE_SET || "customer-service",
    knowledgeRoot: process.env.KNOWLEDGE_ROOT || "knowledge",
    globs: globsRaw ? globsRaw.split(",").map((s) => s.trim()).filter(Boolean) : ["repair/*.md"],
    chunk: {
      maxChars: num("CHUNK_MAX_CHARS", 800),
      minChars: num("CHUNK_MIN_CHARS", 400),
      overlapChars: num("CHUNK_OVERLAP_CHARS", 100),
    },
  };
  return { ...base, ...overrides, chunk: { ...base.chunk, ...(overrides.chunk ?? {}) } };
}

/** 供报告与日志使用的可读摘要（不含任何密钥） */
export function describeConfig(cfg: RagConfig): Record<string, unknown> {
  return {
    qdrantUrl: cfg.qdrantUrl,
    collection: cfg.collection,
    distance: cfg.distance,
    knowledgeSet: cfg.knowledgeSet,
    embeddingBaseUrl: cfg.embeddingBaseUrl,
    embeddingModel: cfg.embeddingModel,
    embeddingDimensionExpected: cfg.embeddingDimension,
    knowledgeRoot: cfg.knowledgeRoot,
    globs: cfg.globs,
    chunk: cfg.chunk,
  };
}
