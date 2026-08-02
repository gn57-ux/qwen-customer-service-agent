/**
 * `experience:finalize`（N8 专用）的核心逻辑——CLI 脚本
 * （`scripts/experience-finalize.ts`）只负责解析输入/打印，真正的
 * "读取现状→校验→转换→持久化写回"在这里，便于不启动子进程就能单元
 * 测试。
 *
 * **每个候选的整个判定+写回过程必须在同一次持锁区间内完成**（复用
 * Feature 1 `write.ts` 的同一把 `document_id` 级别锁，不是另开一把
 * 独立锁）——如果只在最后写入那一步才加锁，读到的 `currentStatus` 是
 * 加锁之前的旧快照，期间若有另一个操作（内容更新/标记 deprecated）
 * 抢先完成，会基于过期状态做出错误判断，可能把一条已经被标记
 * `deprecated` 的记录错误"复活"成 `verified`。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { readActiveFileNoFollow } from "./read-content-hash.ts";
import { stableChunkId } from "./ingest-pipeline.ts";
import {
  coerceFrontmatter,
  parseExperienceFile,
  REQUIRED_SECTIONS,
  serializeExperienceFile,
} from "./schema.ts";
import {
  acquireLock,
  atomicWriteExperience,
  LockLostError,
  lockPathFor,
} from "./write.ts";
import { canVerify, transitionIdempotent, type VerifyEvidence } from "./lifecycle.ts";
import type { ExperienceStore } from "./store.ts";

export interface FinalizeInput {
  codexVerdict: "ALLOW" | "BLOCK" | "ERROR";
  testsPassed: boolean;
  /** 隐私/密钥扫描是否命中；true 时不允许晋升，即使 codexVerdict 是 ALLOW */
  privacyOrSecretHit: boolean;
  /** 本轮 N5 阶段产出的候选经验 document_id 列表 */
  candidateDocumentIds: string[];
  evidence: { before: string; after: string };
}

export type CandidateOutcome =
  | { documentId: string; outcome: "promoted" }
  | { documentId: string; outcome: "already_verified" }
  | { documentId: string; outcome: "not_promoted"; reason: string }
  | { documentId: string; outcome: "lock_lost" }
  | { documentId: string; outcome: "not_found" }
  | { documentId: string; outcome: "vectors_missing"; reason: string };

export interface FinalizeResult {
  outcomes: CandidateOutcome[];
}

/** 在 experienceRoot 下递归查找 {document_id}.md 的活跃文件路径——跳过 .superseded 归档目录 */
async function findActiveExperienceFile(
  experienceRoot: string,
  documentId: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(experienceRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === ".superseded") continue;
    const fullPath = path.join(experienceRoot, entry.name);
    if (entry.isDirectory()) {
      const found = await findActiveExperienceFile(fullPath, documentId);
      if (found) return found;
    } else if (entry.isFile() && entry.name === `${documentId}.md`) {
      return fullPath;
    }
  }
  return null;
}

async function finalizeOne(
  documentId: string,
  evidence: VerifyEvidence,
  experienceRoot: string,
  store: ExperienceStore,
): Promise<CandidateOutcome> {
  const targetPath = await findActiveExperienceFile(experienceRoot, documentId);
  if (!targetPath) return { documentId, outcome: "not_found" };

  const lockPath = lockPathFor(documentId, path.dirname(targetPath));
  const lock = await acquireLock(lockPath);
  try {
    const raw = await readActiveFileNoFollow(targetPath);
    if (raw === null) return { documentId, outcome: "not_found" };
    const { frontmatter, body } = parseExperienceFile(raw);
    const fm = coerceFrontmatter(frontmatter);

    if (!canVerify(evidence)) {
      return { documentId, outcome: "not_promoted", reason: describeRejection(evidence) };
    }

    // transitionIdempotent(current, "verified") 只有 current 已经是
    // "verified" 时才会返回等于 current 的值（幂等收敛）；current 是
    // "candidate" 时会转换成 "verified"（不相等，走下面的真实写入）；
    // current 是 "deprecated" 时 ALLOWED_TRANSITIONS 不允许转到
    // "verified"，transition() 会抛错，被下面的 catch 捕获——不存在
    // "targetStatus 等于一个非 verified 的 fm.status" 这种情况。
    let targetStatus;
    try {
      targetStatus = transitionIdempotent(fm.status, "verified");
    } catch (e) {
      return { documentId, outcome: "not_promoted", reason: (e as Error).message };
    }

    const chunkIds = REQUIRED_SECTIONS.map((section) => stableChunkId(documentId, section));

    // 核实向量点确实存在——`experience:write` 在 Embedding/Qdrant 不可用
    // 时会降级为"只写 Markdown、跳过摄取"，此时这 9 个 chunkId 在 Qdrant
    // 里根本不存在；`updatePayload()` 对不存在的 id 静默忽略、不报错，
    // 单靠它的返回值判断不出"晋升"是否真的让内容变得可检索（Codex
    // Review 指出的真实 bug：曾经会在向量完全缺失的情况下依然报告
    // promoted/already_verified）。缺失时不写 Markdown、不调用
    // updatePayload，直接报告 vectors_missing，让调用方先
    // `experience:rebuild`/重新摄取，candidate 状态原样保留、可安全重试。
    if (!(await store.pointsExist(chunkIds))) {
      return {
        documentId,
        outcome: "vectors_missing",
        reason: "向量点缺失（此前摄取可能因 Embedding/Qdrant 不可用而降级），需先 experience:rebuild 或重新摄取后再 finalize",
      };
    }

    if (targetStatus === fm.status) {
      // Markdown 已经是 verified，但如果上一次 finalize 是"落盘成功、
      // updatePayload() 失败"这种中途失败，向量 payload 会永久停留在
      // 旧 status、被检索的 status 过滤条件排除。重试时幂等收敛分支
      // 不能直接短路返回，要用同一批 chunkIds 重新做一次幂等的 payload
      // 更新——修复失败则和"晋升"分支一样直接抛出，不吞错误、不谎报
      // already_verified。
      await store.updatePayload(chunkIds, { status: targetStatus });
      return { documentId, outcome: "already_verified" };
    }

    // 落盘前最后一道校验——唯一真正防止"两个进程都完成 finalize 写入"
    // 的强保证点，不依赖锁获取阶段完全无竞态（见 Feature 1 write.ts
    // 顶部说明）。
    await lock.assertStillHeld();

    const newFrontmatter = { ...fm, status: targetStatus, updated_at: new Date().toISOString() };
    const fileContent = serializeExperienceFile(newFrontmatter, body);
    await atomicWriteExperience(targetPath, fileContent);

    // payload-only 更新已存在向量点的 status 字段，不重新 embedding。
    await store.updatePayload(chunkIds, { status: targetStatus });

    return { documentId, outcome: "promoted" };
  } catch (e) {
    if (e instanceof LockLostError) {
      return { documentId, outcome: "lock_lost" };
    }
    throw e;
  } finally {
    await lock.release();
  }
}

function describeRejection(evidence: VerifyEvidence): string {
  if (evidence.codexVerdict !== "ALLOW") return `codexVerdict=${evidence.codexVerdict}，未达到 ALLOW`;
  if (!evidence.testsPassed) return "testsPassed=false";
  if (evidence.privacyOrSecretHit) return "privacyOrSecretHit=true，隐私/密钥扫描命中";
  if (!evidence.before.trim() || !evidence.after.trim()) return "evidence.before/after 缺失";
  return "未满足晋升条件";
}

export async function finalizeCandidates(
  input: FinalizeInput,
  experienceRoot: string,
  store: ExperienceStore,
): Promise<FinalizeResult> {
  const evidence: VerifyEvidence = {
    codexVerdict: input.codexVerdict,
    testsPassed: input.testsPassed,
    privacyOrSecretHit: input.privacyOrSecretHit,
    before: input.evidence.before,
    after: input.evidence.after,
  };

  const outcomes: CandidateOutcome[] = [];
  for (const documentId of input.candidateDocumentIds) {
    outcomes.push(await finalizeOne(documentId, evidence, experienceRoot, store));
  }
  return { outcomes };
}
