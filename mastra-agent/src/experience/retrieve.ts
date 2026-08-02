/**
 * 工作流经验的检索管线：脱敏 → embedding → 向量召回 20 条（含全部
 * metadata 过滤条件下推）→ 按 document_id 去重聚合 → Rerank/降级 →
 * 文档级组装（从源文件重新抽取跨小节字段）→ 最终 3-5 条 `RetrievedLesson`。
 *
 * `StoreHit` 只对应经验文档的一个小节（Feature 2 摄取时按二级标题
 * 整节切块），Qdrant payload 里也不存章节正文本身——`RetrievedLesson`
 * 需要跨"问题表现/根因/正确处理/验证方法"四节内容，必须从源 Markdown
 * 文件重新读取解析，不能直接把命中的 chunk 文本当结果返回。
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { RagConfig } from "../rag/config.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import type { RerankDocument, Reranker } from "../rag/rerank.ts";
import type { StoreHit } from "../rag/store.ts";
import { redact } from "./redact.ts";
import { parseExperienceFile, parseExperienceSections } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

export interface RetrieveQuery {
  taskDescription: string;
  stage: "execute" | "review" | "qa" | "finish";
  taskType?: string;
  projectScope: string;
  /**
   * "project-and-global"（默认）——当前项目 + global 都召回；
   * "project-only"——只召回当前项目，不含 global。⛔ 不支持
   * "global-only"：当前项目内检索天然应该包含全局通用经验。
   */
  scopeMode?: "project-and-global" | "project-only";
  riskLevel?: string;
}

export interface RetrievedLesson {
  title: string;
  /** 从"问题表现"+"根因"节提炼 */
  summary: string;
  /** "正确处理"节 */
  correctAction: string;
  /** "验证方法"节 */
  verificationMethod: string;
  sourceFile: string;
  documentVersion: number;
  relevanceScore: number;
}

export interface RetrieveResult {
  lessons: RetrievedLesson[];
  degraded: boolean;
  /** "input_blocked" | "embedding_unavailable" | "qdrant_unavailable" | "reranker_unavailable" */
  degradedReason?: string;
}

export interface RetrieveDeps {
  cfg: RagConfig;
  embedder: EmbeddingClient;
  store: ExperienceStore;
  reranker: Reranker;
}

const VECTOR_TOP_K = 20;
const FINAL_TOP_K = 5;

const REQUIRED_LESSON_SECTIONS = ["问题表现", "根因", "正确处理", "验证方法"] as const;

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function payloadNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" ? value : 0;
}

/** 按 document_id 去重，每组只保留向量分数最高的一条作为该文档的代表 hit */
function dedupeByDocumentId(hits: StoreHit[]): StoreHit[] {
  const byDocument = new Map<string, StoreHit>();
  for (const hit of hits) {
    const documentId = payloadString(hit.payload, "document_id");
    if (!documentId) continue;
    const existing = byDocument.get(documentId);
    if (!existing || hit.score > existing.score) byDocument.set(documentId, hit);
  }
  return [...byDocument.values()];
}

/** 读取并解析源文件的全部小节；文件被并发删除/损坏等极端情况返回 null，不抛异常 */
async function readDocumentSections(
  cfg: RagConfig,
  sourceFile: string,
): Promise<Map<string, string> | null> {
  try {
    const absolutePath = path.join(path.resolve(cfg.knowledgeRoot), sourceFile);
    const raw = await fs.readFile(absolutePath, "utf-8");
    const { body } = parseExperienceFile(raw);
    return parseExperienceSections(body);
  } catch {
    return null;
  }
}

export async function retrieveExperience(
  query: RetrieveQuery,
  deps: RetrieveDeps,
): Promise<RetrieveResult> {
  // 1. 检索输入同样必须脱敏，且 blocked 时不得调用 embedder.embed()——
  // 未处理的敏感输入不能发往可配置地址的外部 Embedding 服务。
  const redacted = redact(query.taskDescription);
  if (redacted.blocked) {
    return { lessons: [], degraded: true, degradedReason: "input_blocked" };
  }

  // 2. Embedding 失败 → 无法执行检索。
  let vector: number[];
  try {
    const vectors = await deps.embedder.embed([redacted.text]);
    vector = vectors[0]!;
  } catch {
    return { lessons: [], degraded: true, degradedReason: "embedding_unavailable" };
  }

  // 3. scopeMode 决定 projectScopeIn；过滤条件与 topK 限制在同一次
  // Qdrant 请求里下推生效，不做查询后的应用层二次过滤。
  const projectScopeIn =
    query.scopeMode === "project-only" ? [query.projectScope] : [query.projectScope, "global"];

  let hits: StoreHit[];
  try {
    hits = await deps.store.query(vector, VECTOR_TOP_K, {
      stage: query.stage,
      taskType: query.taskType,
      riskLevel: query.riskLevel,
      status: "verified",
      projectScopeIn,
    });
  } catch {
    return { lessons: [], degraded: true, degradedReason: "qdrant_unavailable" };
  }

  // 4. 按 document_id 去重聚合，得到文档级候选列表。
  const candidates = dedupeByDocumentId(hits);
  if (candidates.length === 0) {
    return { lessons: [], degraded: false };
  }

  // 读取每个候选文档的完整分节内容——既用于下面 Rerank 的输入文本
  // （代表 chunk 的那一节），也复用给最终的跨小节文档组装，不重复读取
  // 同一个文件两次。读取/解析失败的候选直接跳过，不参与 Rerank，也不
  // 让整次检索失败。
  const sectionsByDocumentId = new Map<string, Map<string, string>>();
  const rerankInputs: RerankDocument[] = [];
  for (const hit of candidates) {
    const documentId = payloadString(hit.payload, "document_id");
    const sourceFile = payloadString(hit.payload, "source_file");
    const sections = await readDocumentSections(deps.cfg, sourceFile);
    if (sections === null) continue;
    sectionsByDocumentId.set(documentId, sections);
    const section = payloadString(hit.payload, "section");
    rerankInputs.push({ id: documentId, text: sections.get(section) ?? "" });
  }

  // 5. Rerank 可用 → 用真实交叉编码分数排序；不可用/禁用 → 按向量分数
  // （representativeScore）排序取 Top，明确标注 degraded，**不得**把
  // 向量排序包装成看起来像 Rerank 完成的结果。
  let selected: Array<{ documentId: string; score: number }>;
  let degraded = false;
  let degradedReason: string | undefined;

  const rerankResult = await deps.reranker.rerank(redacted.text, rerankInputs, FINAL_TOP_K);
  if (rerankResult.status === "ok") {
    selected = rerankResult.ranked
      .filter((r) => r.rerankScore !== null)
      .map((r) => ({ documentId: r.id, score: r.rerankScore! }));
  } else {
    degraded = true;
    degradedReason = "reranker_unavailable";
    const byScore = candidates
      .filter((hit) => sectionsByDocumentId.has(payloadString(hit.payload, "document_id")))
      .sort((a, b) => b.score - a.score)
      .slice(0, FINAL_TOP_K);
    selected = byScore.map((hit) => ({
      documentId: payloadString(hit.payload, "document_id"),
      score: hit.score,
    }));
  }

  // 6. 文档级组装：用第 4 步已经读好的分节内容，抽取"问题表现/根因/
  // 正确处理/验证方法"四节，组装成 RetrievedLesson。任一必需节缺失
  // （源文件结构异常等极端情况）→ 跳过该条候选、不让整次检索失败，
  // 不需要额外的 degradedReason（这是 best-effort 降级，非明确契约）。
  const hitByDocumentId = new Map(
    candidates.map((hit) => [payloadString(hit.payload, "document_id"), hit] as const),
  );
  const lessons: RetrievedLesson[] = [];
  for (const item of selected) {
    const hit = hitByDocumentId.get(item.documentId);
    const sections = sectionsByDocumentId.get(item.documentId);
    if (!hit || !sections) continue;
    if (!REQUIRED_LESSON_SECTIONS.every((name) => sections.has(name))) continue;

    lessons.push({
      title: payloadString(hit.payload, "title"),
      summary: `${sections.get("问题表现")}\n${sections.get("根因")}`,
      correctAction: sections.get("正确处理")!,
      verificationMethod: sections.get("验证方法")!,
      sourceFile: payloadString(hit.payload, "source_file"),
      documentVersion: payloadNumber(hit.payload, "document_version"),
      relevanceScore: item.score,
    });
  }

  return { lessons, degraded, degradedReason };
}
