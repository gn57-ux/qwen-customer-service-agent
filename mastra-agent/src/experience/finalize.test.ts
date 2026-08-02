import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { stableChunkId } from "./ingest-pipeline.ts";
import { finalizeCandidates, type FinalizeInput } from "./finalize.ts";
import { coerceFrontmatter, parseExperienceFile, REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-finalize-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validFm(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "doc-1",
    document_version: 1,
    title: "测试经验",
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

async function readStatus(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  return coerceFrontmatter(parseExperienceFile(raw).frontmatter).status;
}

function fakeStore(
  opts: { vectorsExist?: boolean } = {},
): ExperienceStore & { updatedPayloads: Array<{ ids: string[]; payload: Record<string, unknown> }> } {
  const updatedPayloads: Array<{ ids: string[]; payload: Record<string, unknown> }> = [];
  const vectorsExist = opts.vectorsExist ?? true;
  return {
    async updatePayload(ids: string[], payload: Record<string, unknown>) {
      updatedPayloads.push({ ids, payload });
    },
    async pointsExist() {
      return vectorsExist;
    },
    get updatedPayloads() {
      return updatedPayloads;
    },
  } as unknown as ExperienceStore & { updatedPayloads: Array<{ ids: string[]; payload: Record<string, unknown> }> };
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

describe("finalizeCandidates", () => {
  it("AC-005: ALLOW + 测试通过时，候选从 candidate 晋升为 verified，Markdown 与向量点都更新", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1" }));
    const store = fakeStore();

    const result = await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);

    assert.deepEqual(result.outcomes, [{ documentId: "doc-1", outcome: "promoted" }]);
    assert.equal(await readStatus(filePath), "verified");

    assert.equal(store.updatedPayloads.length, 1);
    assert.deepEqual(store.updatedPayloads[0]!.payload, { status: "verified" });
    const expectedIds = REQUIRED_SECTIONS.map((s) => stableChunkId("doc-1", s)).sort();
    assert.deepEqual(store.updatedPayloads[0]!.ids.sort(), expectedIds);
  });

  it("AC-004: codexVerdict 非 ALLOW 时保持 candidate，不写入 Markdown，不更新向量点", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1" }));
    const store = fakeStore();

    const input: FinalizeInput = { ...allowInput(["doc-1"]), codexVerdict: "BLOCK" };
    const result = await finalizeCandidates(input, tmpDir, store);

    assert.equal(result.outcomes[0]!.outcome, "not_promoted");
    assert.equal(await readStatus(filePath), "candidate");
    assert.equal(store.updatedPayloads.length, 0);
  });

  it("testsPassed=false 时保持 candidate", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1" }));
    const store = fakeStore();
    const input: FinalizeInput = { ...allowInput(["doc-1"]), testsPassed: false };
    await finalizeCandidates(input, tmpDir, store);
    assert.equal(await readStatus(filePath), "candidate");
  });

  it("privacyOrSecretHit=true 时即使 codexVerdict=ALLOW 也保持 candidate", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1" }));
    const store = fakeStore();
    const input: FinalizeInput = { ...allowInput(["doc-1"]), privacyOrSecretHit: true };
    const result = await finalizeCandidates(input, tmpDir, store);
    assert.equal(result.outcomes[0]!.outcome, "not_promoted");
    assert.equal(await readStatus(filePath), "candidate");
  });

  it("已经是 verified 的候选再次 finalize 时幂等收敛为 already_verified，不重复写 Markdown，但重新协调向量 payload", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1", status: "verified" }));
    const store = fakeStore();
    const result = await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);
    assert.deepEqual(result.outcomes, [{ documentId: "doc-1", outcome: "already_verified" }]);
    assert.equal(await readStatus(filePath), "verified");
    // Markdown 已是目标状态不重复写入，但向量 payload 的幂等协调仍要执行一次——
    // 修复"上一次 finalize 落盘成功、updatePayload 失败"导致向量永久停留在
    // 旧 status 的不一致场景（Codex Review P2）。
    assert.equal(store.updatedPayloads.length, 1, "already_verified 分支应该重新协调一次向量 payload");
    const expectedIds = REQUIRED_SECTIONS.map((s) => stableChunkId("doc-1", s)).sort();
    assert.deepEqual(store.updatedPayloads[0]!.ids.sort(), expectedIds);
    assert.deepEqual(store.updatedPayloads[0]!.payload, { status: "verified" });
  });

  it("deprecated 的候选不允许晋升为 verified（生命周期单向不可复活）", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1", status: "deprecated" }));
    const store = fakeStore();
    const result = await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);
    assert.equal(result.outcomes[0]!.outcome, "not_promoted");
    assert.equal(await readStatus(filePath), "deprecated", "deprecated 不应该被 finalize 复活");
  });

  it("document_id 找不到对应文件时报告 not_found，不抛出异常影响其他候选", async () => {
    await writeDoc(validFm({ document_id: "doc-exists" }));
    const store = fakeStore();
    const result = await finalizeCandidates(
      allowInput(["doc-exists", "doc-does-not-exist"]),
      tmpDir,
      store,
    );
    assert.equal(result.outcomes[0]!.outcome, "promoted");
    assert.equal(result.outcomes[1]!.outcome, "not_found");
  });

  it("多个候选独立处理，一个失败不影响其他候选的晋升结果", async () => {
    await writeDoc(validFm({ document_id: "doc-a" }));
    await writeDoc(validFm({ document_id: "doc-b", status: "deprecated" }));
    await writeDoc(validFm({ document_id: "doc-c" }));
    const store = fakeStore();

    const result = await finalizeCandidates(allowInput(["doc-a", "doc-b", "doc-c"]), tmpDir, store);
    assert.deepEqual(
      result.outcomes.map((o) => o.outcome),
      ["promoted", "not_promoted", "promoted"],
    );
  });

  it("晋升后 updated_at 被刷新，其余 frontmatter 字段保持不变", async () => {
    const filePath = await writeDoc(
      validFm({ document_id: "doc-1", occurrence_count: 3, document_version: 2 }),
    );
    const store = fakeStore();
    await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);

    const raw = await fs.readFile(filePath, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    assert.equal(fm.status, "verified");
    assert.equal(fm.occurrence_count, 3, "occurrence_count 不应被 finalize 改变");
    assert.equal(fm.document_version, 2, "document_version 不应被 finalize 改变");
    assert.notEqual(fm.updated_at, "2026-08-01T00:00:00.000Z", "updated_at 应该被刷新");
  });

  it("晋升后不留下锁文件残留", async () => {
    await writeDoc(validFm({ document_id: "doc-1" }));
    const store = fakeStore();
    await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);

    const scopeEntries = await fs.readdir(path.join(tmpDir, "proj"));
    assert.ok(!scopeEntries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
  });

  it("Codex Review: 向量点缺失时（experience:write 曾因 Embedding/Qdrant 不可用而降级）不谎报 promoted，报告 vectors_missing 且不写 Markdown", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1", status: "candidate" }));
    const store = fakeStore({ vectorsExist: false });
    const result = await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);

    assert.equal(result.outcomes[0]!.outcome, "vectors_missing");
    assert.equal(await readStatus(filePath), "candidate", "向量缺失时不应该把 Markdown 晋升为 verified");
    assert.equal(store.updatedPayloads.length, 0, "向量缺失时不应该调用 updatePayload（对不存在的 id 是无意义的空操作）");
  });

  it("Codex Review: 已经是 verified 但向量点缺失时，同样报告 vectors_missing，不谎报 already_verified", async () => {
    const filePath = await writeDoc(validFm({ document_id: "doc-1", status: "verified" }));
    const store = fakeStore({ vectorsExist: false });
    const result = await finalizeCandidates(allowInput(["doc-1"]), tmpDir, store);

    assert.equal(result.outcomes[0]!.outcome, "vectors_missing");
    assert.equal(await readStatus(filePath), "verified");
    assert.equal(store.updatedPayloads.length, 0);
  });
});
