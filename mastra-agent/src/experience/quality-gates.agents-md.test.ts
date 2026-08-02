/**
 * 用户 22 项清单第 20 项：不修改 AGENTS.md（F-003）。
 *
 * 运行一次完整的摄取 + finalize 流程（用 fake embedder/store，不依赖
 * 真实服务，操作对象是临时 knowledgeRoot，不写入仓库真实经验目录），
 * 前后各对**仓库真实根目录**下的 `AGENTS.md` 拍一次快照（存在性 +
 * 内容哈希），断言完全不变——Feature 5 的"建议生成器"只输出到别的
 * 位置，不写这个文件，这里验证的是"本 feature 目前实现的全部代码路径
 * 都不会意外触碰它"。
 *
 * 仓库根目录通过本文件路径向上解析得到（`mastra-agent/src/experience/`
 * 的上三级），不硬编码绝对路径/用户名。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runBulkIngest } from "./bulk-ingest.ts";
import { finalizeCandidates, type FinalizeInput } from "./finalize.ts";
import { REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import type { IndexDescription, StorePoint } from "../rag/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-agents-md-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function snapshotAgentsMd(): Promise<string | null> {
  try {
    const content = await fs.readFile(AGENTS_MD_PATH);
    return createHash("sha256").update(content).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function fakeEmbedder(): EmbeddingClient {
  return {
    model: "fake-model",
    dimension: 3,
    async embed(texts: string[]) {
      return texts.map(() => [0, 0, 0]);
    },
  };
}

function fakeStore(): ExperienceStore {
  const upserted: StorePoint[] = [];
  return {
    knowledgeSet: "claude-workflow-experience",
    async describe(): Promise<IndexDescription> {
      return { exists: true };
    },
    async createIndex() {},
    async deleteIndex() {},
    async upsert(points: StorePoint[]) {
      upserted.push(...points);
    },
    async updatePayload() {},
    async pointsExist() {
      return true;
    },
    async listPoints() {
      return [];
    },
    async deletePoints() {},
  } as unknown as ExperienceStore;
}

function validFm(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "doc-1",
    document_version: 1,
    title: "AGENTS.md 不变性测试经验",
    domain: "workflow-experience",
    stage: "execute",
    task_type: "backend",
    project_scope: "proj",
    source: "yd:ai N5",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    risk_level: "low",
    status: "candidate",
    occurrence_count: 1,
    content_hash: "abc",
    ...overrides,
  };
}

describe("AC-004: AGENTS.md 在完整摄取+finalize 流程前后内容/存在性不变", () => {
  it("运行摄取 + finalize 全流程后，AGENTS.md 快照与流程前完全一致", async () => {
    const before = await snapshotAgentsMd();

    const body = REQUIRED_SECTIONS.map((s) => `## ${s}\n${s}内容`).join("\n\n");
    const docPath = path.join(tmpDir, "proj", "doc-1.md");
    await fs.mkdir(path.dirname(docPath), { recursive: true });
    await fs.writeFile(docPath, serializeExperienceFile(validFm(), `# 标题\n\n${body}\n`), "utf-8");

    const store = fakeStore();
    const ingestReport = await runBulkIngest(tmpDir, fakeEmbedder(), store);
    assert.equal(ingestReport.successCount, 1);

    const finalizeInput: FinalizeInput = {
      codexVerdict: "ALLOW",
      testsPassed: true,
      privacyOrSecretHit: false,
      candidateDocumentIds: ["doc-1"],
      evidence: { before: "存在问题", after: "已修复并验证" },
    };
    const finalizeResult = await finalizeCandidates(finalizeInput, tmpDir, store);
    assert.equal(finalizeResult.outcomes[0]!.outcome, "promoted");

    const after = await snapshotAgentsMd();
    assert.equal(after, before, "AGENTS.md 的存在性/内容哈希不应该因为经验摄取或 finalize 流程发生任何变化");
  });
});
