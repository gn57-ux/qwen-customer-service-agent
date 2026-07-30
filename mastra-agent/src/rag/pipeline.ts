/**
 * 摄取流水线（与 CLI 解耦，便于测试注入假的 store / embedder）。
 *
 * 更新顺序（Review 修正的核心，写坏知识库的风险点就在这里）：
 *   1. 解析 + 分块 + 全量 Embedding —— 任一步失败则整轮中止，库里一个字节都不动；
 *   2. 快照当前 scope 内的已有点（id + document_id）；
 *   3. **按文档逐个 upsert**，记录每个文档成功与否；
 *   4. **回读校验**：确认本次期望的 chunk ID 全部已落库；
 *   5. 只有在第 3、4 步都通过的文档，才允许删除它的 stale 旧点；
 *      任一文档 upsert 失败 → 该文档旧点原样保留，知识库仍可用。
 *
 * scope 同步：
 * - 清理只在本次运行覆盖到的 scope 内进行，且必须同时匹配 knowledge_set；
 * - 库里存在、但本次文件里已消失的 document_id（文档被删除）也会被清理；
 * - 其他 scope（将来的 policies）与其他 knowledge_set 的点完全不受影响。
 */

import type { RagConfig } from "./config.ts";
import type { EmbeddingClient } from "./embedding.ts";
import { embedInBatches } from "./embedding.ts";
import { loadAndChunk, type Chunk, type ParsedDocument } from "./markdown.ts";
import type { KnowledgeStore, StorePoint } from "./store.ts";

export interface DocumentStat {
  sourceFile: string;
  documentId: string;
  documentVersion: string;
  domain: string;
  ingestionScope: string;
  chunkCount: number;
  charsMin: number;
  charsMax: number;
  charsAvg: number;
  upsertOk: boolean;
  upsertError?: string;
}

export interface ScopeStat {
  scope: string;
  expectedScopeChunkCount: number;
  currentScopePointCount: number;
  stalePointsDeleted: number;
  /** 当前 scope 的点 ID 集合是否与本次期望 chunk ID 集合完全一致 */
  idempotent: boolean;
  protectedDocuments: string[];
}

export interface IngestionReport {
  generatedAt: string;
  stage: string;
  config: Record<string, unknown>;
  qdrant: {
    version: string;
    collection: string;
    distance: string;
    createdThisRun: boolean;
    dimension: number;
  };
  embedding: { model: string; dimensionActual: number; verified: boolean };
  documents: DocumentStat[];
  scopes: ScopeStat[];
  counts: {
    documentCount: number;
    collectionTotalPointCount: number;
    currentKnowledgeSetPointCount: number;
    currentScopePointCount: number;
    expectedScopeChunkCount: number;
    stalePointsDeleted: number;
    idempotent: boolean;
  };
  failures: string[];
  notes: string[];
}

export interface PipelineDeps {
  embedder: EmbeddingClient;
  store: KnowledgeStore;
  repoRoot: string;
  log?: (message: string) => void;
}

export const PAYLOAD_INDEX_FIELDS = [
  "knowledge_set",
  "ingestion_scope",
  "document_id",
  "domain",
  "risk_level",
  "source_file",
];

export function toPayload(chunk: Chunk): Record<string, unknown> {
  return {
    knowledge_set: chunk.knowledgeSet,
    ingestion_scope: chunk.ingestionScope,
    document_id: chunk.documentId,
    document_version: chunk.documentVersion,
    title: chunk.title,
    section: chunk.section,
    domain: chunk.domain,
    source: chunk.source,
    updated_at: chunk.updatedAt,
    risk_level: chunk.riskLevel,
    text: chunk.text,
    chunk_index: chunk.chunkIndex,
    content_hash: chunk.contentHash,
    source_file: chunk.sourceFile,
  };
}

function statOf(doc: ParsedDocument, own: Chunk[]): Omit<DocumentStat, "upsertOk"> {
  const lengths = own.map((c) => c.text.length);
  return {
    sourceFile: doc.sourceFile,
    documentId: doc.frontmatter.document_id,
    documentVersion: doc.frontmatter.document_version,
    domain: doc.frontmatter.domain,
    ingestionScope: doc.ingestionScope,
    chunkCount: own.length,
    charsMin: lengths.length ? Math.min(...lengths) : 0,
    charsMax: lengths.length ? Math.max(...lengths) : 0,
    charsAvg: lengths.length
      ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
      : 0,
  };
}

/**
 * 确保 Collection 可用。
 * 维度或距离不一致时抛错，绝不擅自重建；只有 recreate=true 才删除重建。
 */
export async function ensureIndex(
  cfg: RagConfig,
  store: KnowledgeStore,
  actualDimension: number,
  options: { recreate: boolean },
  log: (m: string) => void,
): Promise<{ created: boolean }> {
  let info = await store.describe();

  if (info.exists && options.recreate) {
    log(
      `[--recreate] 即将删除并重建 Collection ${store.indexName}` +
        `（当前 ${info.count ?? 0} 个点将全部丢失）`,
    );
    await store.deleteIndex();
    info = { exists: false };
  }

  if (info.exists) {
    const problems: string[] = [];
    if (info.dimension !== actualDimension) {
      problems.push(
        `维度不一致：Collection 为 ${info.dimension} 维，Embedding 实测 ${actualDimension} 维`,
      );
    }
    const expectedMetric = cfg.distance.toLowerCase();
    if ((info.metric ?? "").toLowerCase() !== expectedMetric) {
      problems.push(`距离不一致：Collection 为 ${info.metric}，要求 ${cfg.distance}`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Collection ${store.indexName} 与当前配置不兼容：\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\n本工具默认不会删除已有 Collection。确认可以丢弃其中数据后，` +
          `再用 npm run rag:ingest -- --recreate 显式重建。`,
      );
    }
    log(
      `Collection ${store.indexName} 已存在且兼容：${info.dimension} 维 / ${info.metric} / ` +
        `当前 ${info.count ?? 0} 个点`,
    );
    await store.createPayloadIndexes(PAYLOAD_INDEX_FIELDS);
    return { created: false };
  }

  await store.createIndex(actualDimension, "cosine");
  await store.createPayloadIndexes(PAYLOAD_INDEX_FIELDS);
  log(`Collection ${store.indexName} 已创建：${actualDimension} 维 / ${cfg.distance}`);
  return { created: true };
}

export async function runIngestion(
  cfg: RagConfig,
  deps: PipelineDeps,
  options: { recreate: boolean } = { recreate: false },
): Promise<IngestionReport> {
  const log = deps.log ?? (() => {});
  const { store, embedder } = deps;

  const version = await store.health();
  log(`Qdrant 健康：${version} @ ${cfg.qdrantUrl}`);

  const { created } = await ensureIndex(cfg, store, embedder.dimension, options, log);

  // ---- 1. 解析 + 分块（document_id 全局唯一在这里校验）--------------------
  const { documents, chunks, scopes } = await loadAndChunk(cfg, deps.repoRoot);
  const chunksByDocument = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = chunksByDocument.get(chunk.documentId) ?? [];
    list.push(chunk);
    chunksByDocument.set(chunk.documentId, list);
  }

  log("");
  log(`发现文档 ${documents.length} 个（scope: ${scopes.join(", ")}），共切出 ${chunks.length} 个 chunk：`);
  const baseStats = documents.map((doc) =>
    statOf(doc, chunksByDocument.get(doc.frontmatter.document_id) ?? []),
  );
  for (const s of baseStats) {
    log(
      `  ${s.sourceFile.padEnd(34)} ${String(s.chunkCount).padStart(3)} chunk  ` +
        `字符 ${s.charsMin}~${s.charsMax}（均 ${s.charsAvg}） scope=${s.ingestionScope} domain=${s.domain}`,
    );
  }

  // ---- 2. 全量 Embedding（失败则整轮中止，库未被触碰）---------------------
  log("");
  log(`使用 ${embedder.model} 生成 ${chunks.length} 个向量（${embedder.dimension} 维）`);
  const vectors = await embedInBatches(embedder, chunks.map((c) => c.text));
  const pointOf = new Map<string, StorePoint>();
  chunks.forEach((chunk, i) => {
    pointOf.set(chunk.id, { id: chunk.id, vector: vectors[i]!, payload: toPayload(chunk) });
  });

  // ---- 3. 快照本次涉及 scope 的已有点 ------------------------------------
  const existingByScope = new Map<string, Awaited<ReturnType<KnowledgeStore["listPoints"]>>>();
  for (const scope of scopes) {
    existingByScope.set(
      scope,
      created ? [] : await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope }),
    );
  }

  // ---- 4. 逐文档 upsert，记录成败 ----------------------------------------
  const failures: string[] = [];
  const upsertOk = new Map<string, boolean>();
  for (const doc of documents) {
    const documentId = doc.frontmatter.document_id;
    const own = chunksByDocument.get(documentId) ?? [];
    try {
      await store.upsert(own.map((c) => pointOf.get(c.id)!));
      upsertOk.set(documentId, true);
    } catch (error) {
      upsertOk.set(documentId, false);
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${doc.sourceFile}（${documentId}）upsert 失败：${message}`);
      log(`  !! ${doc.sourceFile} upsert 失败，将保留该文档的旧点：${message}`);
    }
  }

  // ---- 5. 回读校验：期望 ID 是否真的落库 ----------------------------------
  const afterByScope = new Map<string, Awaited<ReturnType<KnowledgeStore["listPoints"]>>>();
  for (const scope of scopes) {
    afterByScope.set(scope, await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope }));
  }
  const landed = new Set(
    [...afterByScope.values()].flat().map((p) => p.id),
  );
  for (const doc of documents) {
    const documentId = doc.frontmatter.document_id;
    if (!upsertOk.get(documentId)) continue;
    const own = chunksByDocument.get(documentId) ?? [];
    const missing = own.filter((c) => !landed.has(c.id));
    if (missing.length > 0) {
      upsertOk.set(documentId, false);
      failures.push(
        `${doc.sourceFile}（${documentId}）回读校验失败：${missing.length} 个 chunk 未在库中找到，` +
          `已保留该文档旧点不做清理。`,
      );
      log(`  !! ${doc.sourceFile} 回读校验失败，保留旧点`);
    }
  }

  // ---- 6. 只清理"已确认写入成功"的文档的 stale 点 -------------------------
  const currentDocumentIds = new Set(documents.map((d) => d.frontmatter.document_id));
  const scopeStats: ScopeStat[] = [];
  let staleTotal = 0;

  for (const scope of scopes) {
    const expected = new Set(
      chunks.filter((c) => c.ingestionScope === scope).map((c) => c.id),
    );
    const before = existingByScope.get(scope) ?? [];
    const protectedDocs: string[] = [];
    const stale: string[] = [];

    for (const point of before) {
      if (expected.has(point.id)) continue; // 仍然是本次期望的点
      const owner = point.documentId;
      if (currentDocumentIds.has(owner)) {
        // 文档还在，但这个点是旧版本 chunk —— 只有该文档确认写入成功才删
        if (upsertOk.get(owner)) stale.push(point.id);
        else if (!protectedDocs.includes(owner)) protectedDocs.push(owner);
      } else {
        // 文档已从本 scope 目录中删除 —— 其残留点属于本 scope，清理掉
        stale.push(point.id);
      }
    }

    if (stale.length > 0) {
      await store.deletePoints(stale);
      log(`  scope=${scope} 清理 stale 点 ${stale.length} 个`);
    }
    staleTotal += stale.length;

    const after = await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope });
    const actualIds = new Set(after.map((p) => p.id));
    const idempotent =
      actualIds.size === expected.size && [...expected].every((id) => actualIds.has(id));

    scopeStats.push({
      scope,
      expectedScopeChunkCount: expected.size,
      currentScopePointCount: actualIds.size,
      stalePointsDeleted: stale.length,
      idempotent,
      protectedDocuments: protectedDocs,
    });
  }

  // ---- 7. 统计 -----------------------------------------------------------
  const collectionTotalPointCount = await store.countPoints();
  const currentKnowledgeSetPointCount = await store.countPoints({
    knowledgeSet: cfg.knowledgeSet,
  });
  const currentScopePointCount = scopeStats.reduce((a, s) => a + s.currentScopePointCount, 0);
  const expectedScopeChunkCount = scopeStats.reduce((a, s) => a + s.expectedScopeChunkCount, 0);
  const idempotent = failures.length === 0 && scopeStats.every((s) => s.idempotent);

  const documentStats: DocumentStat[] = baseStats.map((s) => ({
    ...s,
    upsertOk: upsertOk.get(s.documentId) ?? false,
    ...(upsertOk.get(s.documentId)
      ? {}
      : { upsertError: failures.find((f) => f.includes(s.documentId)) }),
  }));

  return {
    generatedAt: new Date().toISOString(),
    stage: "rag-vector-ingestion",
    config: {},
    qdrant: {
      version,
      collection: cfg.collection,
      distance: cfg.distance,
      createdThisRun: created,
      dimension: embedder.dimension,
    },
    embedding: { model: embedder.model, dimensionActual: embedder.dimension, verified: true },
    documents: documentStats,
    scopes: scopeStats,
    counts: {
      documentCount: documents.length,
      collectionTotalPointCount,
      currentKnowledgeSetPointCount,
      currentScopePointCount,
      expectedScopeChunkCount,
      stalePointsDeleted: staleTotal,
      idempotent,
    },
    failures,
    notes: [
      "当前摄取范围由 config.globs 决定；加入 knowledge/policies/*.md 时 scope 自动为 policies，仍进入同一 Collection。",
      "stale 清理只作用于本次覆盖到的 scope，且必须同时匹配 knowledge_set，不会影响其他 scope 的数据。",
      "任一文档 upsert 或回读校验失败时，该文档的旧点会被保留，知识库保持可用。",
      "idempotent 依据当前 scope 的点 ID 集合与本次期望 chunk ID 集合是否一致，不使用 Collection 总点数。",
      "本阶段只有向量召回，未实现 Reranker。",
    ],
  };
}
