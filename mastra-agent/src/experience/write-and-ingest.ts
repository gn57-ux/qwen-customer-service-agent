/**
 * Feature 1 `upsertExperience()` 成功后的摄取调用点——串联"写入 Markdown"
 * 与"向量入库"两步，供 Feature 3 的 CLI 命令、Feature 5 的真实工作流
 * 接入点复用，不需要各自重新实现"写入成功后读回、解析、摄取"这套流程。
 *
 * **写入成功但摄取失败时不回滚 Markdown，只记录告警**——经验写入本身
 * （Feature 1 的原子写入 + 锁 + 围栏检查）已经是独立、完整、已冻结的
 * 成功语义；向量索引缺失只是"暂时不能被检索到"，不是数据丢失，下次
 * 重建索引（Feature 3 `experience:rebuild`）会补齐，属于写路径的
 * graceful degrade，与 F-008 读路径的 degrade 语义对称。
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { RagConfig } from "../rag/config.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import { createEmbeddingClient } from "../rag/embedding.ts";
import { ingestExperience, type ParsedExperienceDocument } from "./ingest-pipeline.ts";
import { coerceFrontmatter, parseExperienceFile } from "./schema.ts";
import type { CreateEmbeddingClientFn } from "./status.ts";
import type { ExperienceStore } from "./store.ts";
import { type UpsertCandidate, type UpsertResult, upsertExperience } from "./write.ts";

export interface WriteAndIngestResult extends UpsertResult {
  /** 向量摄取是否成功；写入本身失败（`ok: false`）时恒为 false，不会尝试摄取 */
  ingested: boolean;
  /** 摄取失败时的告警信息，调用方按需记录日志；不影响写入结果本身 */
  ingestWarning?: string;
}

/** 写入已成功（`result.ok`）后的"读回→解析→摄取"共用步骤，供下方两个入口复用 */
async function ingestAfterWrite(
  result: UpsertResult,
  cfg: RagConfig,
  embedder: EmbeddingClient,
  store: ExperienceStore,
): Promise<WriteAndIngestResult> {
  if (!result.ok || !result.filePath) {
    return { ...result, ingested: false };
  }

  try {
    const raw = await fs.readFile(result.filePath, "utf-8");
    const { frontmatter, body } = parseExperienceFile(raw);
    const fm = coerceFrontmatter(frontmatter);
    const sourceFile = path.relative(path.resolve(cfg.knowledgeRoot), result.filePath);

    const doc: ParsedExperienceDocument = {
      documentId: fm.document_id,
      documentVersion: fm.document_version,
      title: fm.title,
      stage: fm.stage,
      taskType: fm.task_type,
      projectScope: fm.project_scope,
      riskLevel: fm.risk_level,
      status: fm.status,
      occurrenceCount: fm.occurrence_count,
      sourceFile,
      body,
    };

    await ingestExperience(embedder, store, doc);
    return { ...result, ingested: true };
  } catch (e) {
    return { ...result, ingested: false, ingestWarning: (e as Error).message };
  }
}

export async function writeExperienceAndIngest(
  candidate: UpsertCandidate,
  cfg: RagConfig,
  embedder: EmbeddingClient,
  store: ExperienceStore,
): Promise<WriteAndIngestResult> {
  const result = await upsertExperience(candidate);
  return ingestAfterWrite(result, cfg, embedder, store);
}

/**
 * Feature 5 `experience:write` CLI 的核心逻辑——先完成 Feature 1 的纯
 * Markdown 写入（本地、无网络依赖），**只有写入成功才**尝试创建
 * Embedding 客户端（`createEmbeddingClient()` 内部会做一次真实探测
 * 请求，Embedding 服务不可达时在创建阶段就直接抛出）——顺序不能反过来：
 * 如果候选内容本身不合法（校验失败），不应该先付一次网络探测的成本。
 * 探测失败时退化为只完成 Markdown 写入，跳过向量摄取，与
 * `writeExperienceAndIngest()` 已有的"摄取失败只告警"语义保持一致，
 * 调用方不需要区分"探测失败"和"摄取失败"两种不可用时机。
 */
export async function writeExperienceWithFallback(
  candidate: UpsertCandidate,
  cfg: RagConfig,
  store: ExperienceStore,
  createEmbedder: CreateEmbeddingClientFn = createEmbeddingClient,
): Promise<WriteAndIngestResult> {
  const result = await upsertExperience(candidate);
  if (!result.ok || !result.filePath) {
    return { ...result, ingested: false };
  }

  try {
    const embedder = await createEmbedder(cfg);
    return await ingestAfterWrite(result, cfg, embedder, store);
  } catch (e) {
    return { ...result, ingested: false, ingestWarning: `Embedding 服务不可用，未尝试摄取：${(e as Error).message}` };
  }
}
