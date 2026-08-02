/**
 * 工作流经验的摄取管线：按 9 个固定二级标题整节切块 → embedding → upsert。
 *
 * 分块策略比客服知识库简单——经验文档结构固定，不需要
 * `rag/markdown.ts` 的"合并过短相邻片段"逻辑，每节长度本来就可控，
 * 直接一节一个 chunk。
 */

import { createHash } from "node:crypto";

import type { EmbeddingClient } from "../rag/embedding.ts";
import type { StorePoint } from "../rag/store.ts";
import { parseExperienceSections, REQUIRED_SECTIONS } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

/**
 * `upsertExperience()`（Feature 1）成功写入后的产物——由调用方（T-004）
 * 读回刚写入的文件、解析出这个形状，不要求 write.ts 直接返回它，避免
 * 改动已冻结的 Feature 1 接口。
 */
export interface ParsedExperienceDocument {
  documentId: string;
  documentVersion: number;
  title: string;
  stage: string;
  taskType: string;
  projectScope: string;
  riskLevel: string;
  status: string;
  occurrenceCount: number;
  /** 相对 knowledgeRoot 的路径，不含绝对用户目录 */
  sourceFile: string;
  body: string;
}

export interface ExperienceChunk {
  id: string;
  text: string;
  documentId: string;
  documentVersion: number;
  title: string;
  section: string;
  stage: string;
  taskType: string;
  projectScope: string;
  riskLevel: string;
  status: string;
  occurrenceCount: number;
  sourceFile: string;
  knowledgeSet: string;
}

/**
 * 稳定 ID：`documentId#section` 的哈希，拼成 UUID 形状（Qdrant 接受
 * UUID 字符串作为点 ID，与 `rag/markdown.ts` 的 `stableChunkId()` 同一
 * 惯例）。**不包含 document_version**——同一份经验内容变化时
 * `document_id` 保持不变（Feature 1 的设计前提），复用同一个点 ID
 * 能让重新摄取新版本时自然覆盖旧版本的向量，检索结果始终只包含
 * 当前活跃版本，不需要额外清理旧版本遗留的向量点。
 *
 * **导出**（不只是模块内部私有函数）——Feature 3 的
 * `experience:finalize` 需要在不重新读取 Qdrant 的情况下，用同一套
 * 确定性算法直接算出某个 documentId 全部 9 个小节的点 ID，从而对
 * 已存在的向量点做 payload-only 的 status 更新，不需要先 scroll 查询
 * 一遍再更新。
 */
export function stableChunkId(documentId: string, section: string): string {
  const digest = createHash("sha256").update(`${documentId}#${section}`).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * 按 9 个固定二级标题切分成 chunk——独立导出成纯函数，不需要真实
 * embedding/Qdrant 服务就能单元测试切块逻辑本身。
 */
export function chunkExperienceDocument(
  doc: ParsedExperienceDocument,
  knowledgeSet: string,
): ExperienceChunk[] {
  const sections = parseExperienceSections(doc.body);
  const chunks: ExperienceChunk[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const sectionText = sections.get(section);
    // 缺失的节直接跳过，不产出空 chunk——正常流程下 Feature 1 的
    // validateExperience() 已经保证 9 节齐全，这里的跳过是防御性的，
    // 不是主路径。
    if (sectionText === undefined) continue;
    chunks.push({
      id: stableChunkId(doc.documentId, section),
      text: `## ${section}\n${sectionText}`,
      documentId: doc.documentId,
      documentVersion: doc.documentVersion,
      title: doc.title,
      section,
      stage: doc.stage,
      taskType: doc.taskType,
      projectScope: doc.projectScope,
      riskLevel: doc.riskLevel,
      status: doc.status,
      occurrenceCount: doc.occurrenceCount,
      sourceFile: doc.sourceFile,
      knowledgeSet,
    });
  }
  return chunks;
}

function chunkToPoint(chunk: ExperienceChunk, vector: number[]): StorePoint {
  return {
    id: chunk.id,
    vector,
    payload: {
      document_id: chunk.documentId,
      document_version: chunk.documentVersion,
      title: chunk.title,
      section: chunk.section,
      stage: chunk.stage,
      task_type: chunk.taskType,
      project_scope: chunk.projectScope,
      risk_level: chunk.riskLevel,
      status: chunk.status,
      occurrence_count: chunk.occurrenceCount,
      source_file: chunk.sourceFile,
      knowledge_set: chunk.knowledgeSet,
    },
  };
}

/**
 * `upsertExperience()` 成功后同步调用——经验写入频率低，同步调用足够
 * 简单可靠。调用方必须自行 try/catch：本函数失败不应该回滚已经落盘的
 * Markdown 文件，只是"暂时没有向量索引"，属于写路径的 graceful
 * degrade（与 F-008 读路径的 degrade 对称），下次重建索引会补齐。
 */
export async function ingestExperience(
  embedder: EmbeddingClient,
  store: ExperienceStore,
  doc: ParsedExperienceDocument,
): Promise<void> {
  const chunks = chunkExperienceDocument(doc, store.knowledgeSet);
  if (chunks.length === 0) return;
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  const points = chunks.map((chunk, i) => chunkToPoint(chunk, vectors[i]!));
  await store.upsert(points);
}
