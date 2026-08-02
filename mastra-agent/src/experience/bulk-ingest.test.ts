import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { EmbeddingClient } from "../rag/embedding.ts";
import type { ExistingPoint, IndexDescription, StorePoint } from "../rag/store.ts";
import { stableChunkId } from "./ingest-pipeline.ts";
import { runBulkIngest } from "./bulk-ingest.ts";
import { REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-bulk-ingest-test-"));
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
    status: "verified",
    occurrence_count: 1,
    content_hash: "abc",
    ...overrides,
  };
}

const VALID_BODY = [
  "触发场景",
  "问题表现",
  "错误做法",
  "根因",
  "正确处理",
  "验证方法",
  "适用范围",
  "不适用范围",
  "可提升为稳定规则的条件",
]
  .map((s) => `## ${s}\n${s}内容`)
  .join("\n\n");

function fakeEmbedder(): EmbeddingClient {
  return {
    model: "fake-model",
    dimension: 3,
    async embed(texts: string[]) {
      return texts.map(() => [0, 0, 0]);
    },
  };
}

function fakeStore(
  opts: {
    exists?: boolean;
    upsertShouldThrow?: boolean;
    existingPoints?: ExistingPoint[];
    deleteIndexShouldThrow?: Error;
  } = {},
) {
  const upserted: StorePoint[] = [];
  const deletedPointIds: string[] = [];
  const listPointsFilters: Array<{ knowledgeSet: string; scope?: string }> = [];
  let deleteIndexCalled = false;
  let createIndexCalled = false;
  const store = {
    knowledgeSet: "claude-workflow-experience",
    get upserted() {
      return upserted;
    },
    get deletedPointIds() {
      return deletedPointIds;
    },
    get listPointsFilters() {
      return listPointsFilters;
    },
    get deleteIndexCalled() {
      return deleteIndexCalled;
    },
    get createIndexCalled() {
      return createIndexCalled;
    },
    async describe(): Promise<IndexDescription> {
      return { exists: opts.exists ?? false };
    },
    async createIndex() {
      createIndexCalled = true;
    },
    async deleteIndex() {
      deleteIndexCalled = true;
      if (opts.deleteIndexShouldThrow) throw opts.deleteIndexShouldThrow;
    },
    async upsert(points: StorePoint[]) {
      if (opts.upsertShouldThrow) throw new Error("模拟摄取失败");
      upserted.push(...points);
    },
    async listPoints(filter: { knowledgeSet: string; scope?: string }): Promise<ExistingPoint[]> {
      listPointsFilters.push(filter);
      return opts.existingPoints ?? [];
    },
    async deletePoints(ids: string[]): Promise<void> {
      deletedPointIds.push(...ids);
    },
  };
  return store as unknown as ExperienceStore & {
    upserted: StorePoint[];
    deletedPointIds: string[];
    listPointsFilters: Array<{ knowledgeSet: string; scope?: string }>;
    deleteIndexCalled: boolean;
    createIndexCalled: boolean;
  };
}

/** 构造一份文档在 Qdrant 里应有的 9 个点（每个必需二级标题一个），供孤儿清理测试模拟"现存点" */
function pointsFor(documentId: string): ExistingPoint[] {
  return REQUIRED_SECTIONS.map((section) => ({
    id: stableChunkId(documentId, section),
    documentId,
  }));
}

async function writeDoc(relativePath: string, fm: ExperienceFrontmatter, body = VALID_BODY): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${body}\n`), "utf-8");
}

describe("runBulkIngest", () => {
  it("扫描全部文档并逐个摄取，成功计数正确", async () => {
    await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
    await writeDoc("proj/doc-2.md", validFm({ document_id: "doc-2" }));

    const store = fakeStore({ exists: true });
    const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

    assert.equal(report.documentCount, 2);
    assert.equal(report.successCount, 2);
    assert.deepEqual(report.failures, []);
    assert.equal(store.upserted.length, 18, "2 份文档各 9 节");
  });

  it("collection 不存在时自动 createIndex，存在时不重复创建", async () => {
    await writeDoc("proj/doc-1.md", validFm());

    const storeMissing = fakeStore({ exists: false });
    await runBulkIngest(tmpDir, fakeEmbedder(), storeMissing);
    assert.equal(storeMissing.createIndexCalled, true);

    const storeExisting = fakeStore({ exists: true });
    await runBulkIngest(tmpDir, fakeEmbedder(), storeExisting);
    assert.equal(storeExisting.createIndexCalled, false);
  });

  it("--rebuild 时先 deleteIndex 再 createIndex", async () => {
    await writeDoc("proj/doc-1.md", validFm());
    const store = fakeStore({ exists: false });
    await runBulkIngest(tmpDir, fakeEmbedder(), store, { rebuild: true });
    assert.equal(store.deleteIndexCalled, true);
    assert.equal(store.createIndexCalled, true);
  });

  it("frontmatter 校验失败的文档记录为失败，不中断其余文档的摄取", async () => {
    const badBody = VALID_BODY.replace("## 验证方法\n验证方法内容\n\n", "");
    await writeDoc("proj/bad-doc.md", validFm({ document_id: "bad-doc" }), badBody);
    await writeDoc("proj/good-doc.md", validFm({ document_id: "good-doc" }));

    const store = fakeStore({ exists: true });
    const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

    assert.equal(report.documentCount, 2);
    assert.equal(report.successCount, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.relativePath, path.join("proj", "bad-doc.md"));
  });

  it("frontmatter 完全无法解析的文件记录为失败", async () => {
    await fs.mkdir(path.join(tmpDir, "proj"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "proj", "broken.md"), "不合法内容", "utf-8");

    const store = fakeStore({ exists: true });
    const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);
    assert.equal(report.failures.length, 1);
  });

  it("单个文档摄取（embedding/upsert）失败时记录失败，不影响其余文档", async () => {
    await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
    const store = fakeStore({ exists: true, upsertShouldThrow: true });
    const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);
    assert.equal(report.successCount, 0);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0]!.error, /模拟摄取失败/);
  });

  describe("Codex Review 修复：增量路径孤儿点清理", () => {
    it("文档已从磁盘删除时，其旧向量点（含 verified 状态）被清理，不再可被检索", async () => {
      // 只写 doc-2（磁盘上现存），doc-1 只作为"Qdrant 里的旧点"存在——
      // 模拟 doc-1.md 已被删除，但上次摄取留下的 verified 向量点还在。
      await writeDoc("proj/doc-2.md", validFm({ document_id: "doc-2" }));
      const store = fakeStore({ exists: true, existingPoints: pointsFor("doc-1") });

      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

      assert.equal(report.orphansRemoved, 9, "doc-1 的 9 个孤儿点应全部被清理");
      assert.deepEqual(
        store.deletedPointIds.sort(),
        pointsFor("doc-1")
          .map((p) => p.id)
          .sort(),
      );
    });

    it("文档变为无法通过校验的内容时，其旧向量点（此前可能是 verified）被清理", async () => {
      const badBody = VALID_BODY.replace("## 验证方法\n验证方法内容\n\n", "");
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }), badBody);
      const store = fakeStore({ exists: true, existingPoints: pointsFor("doc-1") });

      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

      assert.equal(report.failures.length, 1, "doc-1 本身仍应记录为校验失败");
      assert.equal(report.orphansRemoved, 9, "doc-1 失效后，其旧向量点应被当作孤儿清理");
    });

    it("文档变为 deprecated 但内容仍合法时，不清理（照常走正常 upsert 覆盖 payload）", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1", status: "deprecated" }));
      const store = fakeStore({ exists: true, existingPoints: pointsFor("doc-1") });

      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

      assert.equal(report.successCount, 1, "deprecated 但结构合法的文档应正常摄取");
      assert.equal(report.orphansRemoved, 0, "仍然合法的文档不应被当作孤儿清理");
      assert.equal(store.deletedPointIds.length, 0);
    });

    it("单次摄取瞬时失败（embedding/upsert 抛错）不会把仍然合法的旧向量点当孤儿清理", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: true, upsertShouldThrow: true, existingPoints: pointsFor("doc-1") });

      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store);

      assert.equal(report.failures.length, 1, "本次摄取仍应记录为失败");
      assert.equal(report.orphansRemoved, 0, "结构校验通过、只是本次摄取瞬时失败，不应清理旧向量");
    });

    it("清理只按 knowledgeSet 范围查询，不会带上其它 scope 条件误伤客服知识库", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: true });
      await runBulkIngest(tmpDir, fakeEmbedder(), store);

      assert.equal(store.listPointsFilters.length, 1);
      assert.deepEqual(store.listPointsFilters[0], { knowledgeSet: "claude-workflow-experience" });
    });

    it("--rebuild 路径不做孤儿点清理（collection 已整体清空重建，扫描不到孤儿也没有意义）", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: false });
      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store, { rebuild: true });

      assert.equal(report.orphansRemoved, 0);
      assert.equal(store.listPointsFilters.length, 0, "--rebuild 路径不应调用 listPoints");
    });

    it("核实/清理孤儿点阶段本身失败（listPoints 抛错）时，整个函数必须抛出，不得返回看似成功的 report", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: true });
      store.listPoints = async () => {
        throw new Error("模拟 Qdrant 不可达");
      };

      await assert.rejects(
        () => runBulkIngest(tmpDir, fakeEmbedder(), store),
        /模拟 Qdrant 不可达/,
      );
    });
  });

  describe("Codex Review 修复：--rebuild 删除失败必须中止", () => {
    it("--rebuild 时 deleteIndex 真实失败（非 collection 不存在）必须原样抛出，不得静默继续摄取", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: true, deleteIndexShouldThrow: new Error("模拟 Qdrant 删除 Collection 失败") });

      await assert.rejects(
        () => runBulkIngest(tmpDir, fakeEmbedder(), store, { rebuild: true }),
        /模拟 Qdrant 删除 Collection 失败/,
      );
      assert.equal(store.upserted.length, 0, "删除失败后不应该继续对着未清空的旧 collection 摄取");
    });

    it("--rebuild 正常场景（deleteIndex 成功）仍然照常完成摄取，不受本次修复影响", async () => {
      await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
      const store = fakeStore({ exists: false });
      const report = await runBulkIngest(tmpDir, fakeEmbedder(), store, { rebuild: true });

      assert.equal(store.deleteIndexCalled, true);
      assert.equal(report.successCount, 1);
    });
  });
});
