/**
 * 用户 22 项清单第 16 项：Hook 重入保护验证（F-001）。
 *
 * 验证的是 Feature 1 并发锁在 finalize 场景下的实际效果——不是重新
 * 设计一套锁，`finalizeCandidates()` 内部复用 Feature 1
 * `acquireLock()`/`lockPathFor()`（同一把按 document_id 命名的锁）。
 *
 * 两个场景，都用 `Promise.all()` 真实并发触发两次独立的
 * `finalizeCandidates()` 调用（不是 mock 出并发）：
 * 1. 处理**不同**候选 ID：互不阻塞，各自成功晋升。
 * 2. 处理**相同**候选 ID：锁生效，真正串行执行——第一个完成真实的
 *    candidate→verified 转换，第二个在自己拿到锁之后读到的
 *    `status` 已经是 `verified`，用 `transitionIdempotent(verified,
 *    "verified")` 识别为已达目标状态直接返回，不抛错、不重复递增
 *    `occurrence_count`/`document_version`——不能断言"两次都执行了
 *    真正的状态转换"，`verified→verified` 本身是状态机拒绝的非法
 *    转换，只有幂等包装层会放行（AC-003 的验收口径）。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { finalizeCandidates, type FinalizeInput } from "./finalize.ts";
import { coerceFrontmatter, parseExperienceFile, REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-hook-concurrency-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validFm(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "doc-1",
    document_version: 1,
    title: "并发 finalize 测试经验",
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

const VALID_BODY = REQUIRED_SECTIONS.map((s) => `## ${s}\n${s}内容`).join("\n\n");

async function writeDoc(fm: ExperienceFrontmatter): Promise<string> {
  const fullPath = path.join(tmpDir, fm.project_scope, `${fm.document_id}.md`);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${VALID_BODY}\n`), "utf-8");
  return fullPath;
}

async function readFrontmatter(filePath: string): Promise<ExperienceFrontmatter> {
  const raw = await fs.readFile(filePath, "utf-8");
  return coerceFrontmatter(parseExperienceFile(raw).frontmatter);
}

function fakeStore(): ExperienceStore {
  return {
    async updatePayload() {
      // 模拟真实网络调用的耗时，放大并发窗口，让锁的串行化效果
      // 更容易被真实触发（而不是两次调用凑巧没有真正重叠）。
      await new Promise((r) => setTimeout(r, 20));
    },
    async pointsExist() {
      return true;
    },
  } as unknown as ExperienceStore;
}

function allowInput(candidateDocumentIds: string[]): FinalizeInput {
  return {
    codexVerdict: "ALLOW",
    testsPassed: true,
    privacyOrSecretHit: false,
    candidateDocumentIds,
    evidence: { before: "存在问题", after: "已修复并验证" },
  };
}

describe("AC-002: 并发 finalize 不同候选 ID，互不阻塞、互不覆盖对方结果", () => {
  it("两个候选各自独立晋升为 verified", async () => {
    const pathA = await writeDoc(validFm({ document_id: "doc-a" }));
    const pathB = await writeDoc(validFm({ document_id: "doc-b" }));
    const store = fakeStore();

    const [resultA, resultB] = await Promise.all([
      finalizeCandidates(allowInput(["doc-a"]), tmpDir, store),
      finalizeCandidates(allowInput(["doc-b"]), tmpDir, store),
    ]);

    assert.equal(resultA.outcomes[0]!.outcome, "promoted");
    assert.equal(resultB.outcomes[0]!.outcome, "promoted");
    assert.equal((await readFrontmatter(pathA)).status, "verified");
    assert.equal((await readFrontmatter(pathB)).status, "verified");
  });
});

describe("AC-003: 并发 finalize 相同候选 ID，锁串行化 + transitionIdempotent 幂等收敛", () => {
  it("两次调用均不抛错，恰好一次真实晋升、一次幂等收敛为 already_verified", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-shared", occurrence_count: 5, document_version: 2 }));
    const store = fakeStore();

    const [resultA, resultB] = await Promise.all([
      finalizeCandidates(allowInput(["doc-shared"]), tmpDir, store),
      finalizeCandidates(allowInput(["doc-shared"]), tmpDir, store),
    ]);

    const outcomes = [resultA.outcomes[0]!.outcome, resultB.outcomes[0]!.outcome].sort();
    assert.deepEqual(
      outcomes,
      ["already_verified", "promoted"],
      "锁真正串行化时，两次并发调用应该恰好一次是真实转换、一次是幂等收敛，不应该出现两次都是 promoted（意味着锁失效）",
    );

    const finalFm = await readFrontmatter(filePath);
    assert.equal(finalFm.status, "verified");
    assert.equal(finalFm.occurrence_count, 5, "occurrence_count 不应因第二次调用被重复变化");
    assert.equal(finalFm.document_version, 2, "document_version 不应因第二次调用被重复变化");

    const scopeEntries = await fs.readdir(path.join(tmpDir, "proj"));
    assert.ok(!scopeEntries.some((e) => e.endsWith(".lock")), "并发结束后不应残留锁文件");
  });
});
