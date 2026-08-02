import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EmbeddingClient } from "../rag/embedding.ts";
import type { StorePoint } from "../rag/store.ts";
import { chunkExperienceDocument, ingestExperience, type ParsedExperienceDocument } from "./ingest-pipeline.ts";
import { REQUIRED_SECTIONS } from "./schema.ts";

const VALID_BODY = [
  "# 标题",
  "## 触发场景",
  "描述触发场景",
  "## 问题表现",
  "描述问题表现",
  "## 错误做法",
  "描述错误做法",
  "## 根因",
  "描述根因",
  "## 正确处理",
  "描述正确处理",
  "## 验证方法",
  "描述验证方法",
  "## 适用范围",
  "描述适用范围",
  "## 不适用范围",
  "描述不适用范围",
  "## 可提升为稳定规则的条件",
  "描述条件",
  "",
].join("\n");

function doc(overrides: Partial<ParsedExperienceDocument> = {}): ParsedExperienceDocument {
  return {
    documentId: "abc123",
    documentVersion: 1,
    title: "测试经验",
    stage: "execute",
    taskType: "backend",
    projectScope: "ai-kefu",
    riskLevel: "medium",
    status: "verified",
    occurrenceCount: 1,
    sourceFile: "ai-kefu/abc123.md",
    body: VALID_BODY,
    ...overrides,
  };
}

describe("chunkExperienceDocument", () => {
  it("九节正文切出 9 个 chunk，一节一个", () => {
    const chunks = chunkExperienceDocument(doc(), "claude-workflow-experience");
    assert.equal(chunks.length, REQUIRED_SECTIONS.length);
    assert.deepEqual(
      chunks.map((c) => c.section),
      [...REQUIRED_SECTIONS],
    );
  });

  it("每个 chunk 的 text 包含节标题与节正文", () => {
    const chunks = chunkExperienceDocument(doc(), "claude-workflow-experience");
    const trigger = chunks.find((c) => c.section === "触发场景")!;
    assert.equal(trigger.text, "## 触发场景\n描述触发场景");
  });

  it("chunk 携带完整的 frontmatter 元数据，供检索侧过滤", () => {
    const chunks = chunkExperienceDocument(
      doc({ stage: "review", taskType: "frontend", riskLevel: "high", status: "candidate" }),
      "claude-workflow-experience",
    );
    for (const chunk of chunks) {
      assert.equal(chunk.documentId, "abc123");
      assert.equal(chunk.documentVersion, 1);
      assert.equal(chunk.stage, "review");
      assert.equal(chunk.taskType, "frontend");
      assert.equal(chunk.riskLevel, "high");
      assert.equal(chunk.status, "candidate");
      assert.equal(chunk.knowledgeSet, "claude-workflow-experience");
    }
  });

  it("同一 documentId 的同一节，跨版本产出相同的 chunk id（不含 document_version）——保证重新摄取新版本时覆盖旧版本向量", () => {
    const v1Chunks = chunkExperienceDocument(doc({ documentVersion: 1 }), "claude-workflow-experience");
    const v2Chunks = chunkExperienceDocument(
      doc({ documentVersion: 2, body: VALID_BODY.replace("描述根因", "更新后的根因") }),
      "claude-workflow-experience",
    );
    const v1Trigger = v1Chunks.find((c) => c.section === "触发场景")!;
    const v2Trigger = v2Chunks.find((c) => c.section === "触发场景")!;
    assert.equal(v1Trigger.id, v2Trigger.id, "同一 documentId+section 的 chunk id 必须跨版本稳定");
  });

  it("不同 documentId 或不同 section 产出不同的 chunk id", () => {
    const chunks = chunkExperienceDocument(doc(), "claude-workflow-experience");
    const ids = new Set(chunks.map((c) => c.id));
    assert.equal(ids.size, chunks.length, "同一文档内不同节的 chunk id 不应冲突");

    const otherDocChunks = chunkExperienceDocument(doc({ documentId: "xyz789" }), "claude-workflow-experience");
    assert.notEqual(chunks[0]!.id, otherDocChunks[0]!.id);
  });

  it("chunk id 是 UUID 形状字符串（Qdrant 点 ID 要求）", () => {
    const chunks = chunkExperienceDocument(doc(), "claude-workflow-experience");
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const chunk of chunks) {
      assert.match(chunk.id, uuidShape);
    }
  });

  it("缺失某个二级标题时该节直接跳过，不产出空 chunk", () => {
    const bodyMissingSection = VALID_BODY.replace("## 验证方法\n描述验证方法\n", "");
    const chunks = chunkExperienceDocument(doc({ body: bodyMissingSection }), "claude-workflow-experience");
    assert.equal(chunks.length, REQUIRED_SECTIONS.length - 1);
    assert.ok(!chunks.some((c) => c.section === "验证方法"));
  });
});

describe("ingestExperience", () => {
  it("对 9 个 chunk 各调用一次 embedding（合并成一次 embed() 调用），再一次性 upsert 到 store", async () => {
    const embedCalls: string[][] = [];
    const embedder: EmbeddingClient = {
      model: "fake-model",
      dimension: 3,
      async embed(texts: string[]) {
        embedCalls.push(texts);
        return texts.map((_, i) => [i, i + 1, i + 2]);
      },
    };

    let upsertedPoints: StorePoint[] = [];
    const fakeStore = {
      knowledgeSet: "claude-workflow-experience",
      async upsert(points: StorePoint[]) {
        upsertedPoints = points;
      },
    } as unknown as import("./store.ts").ExperienceStore;

    await ingestExperience(embedder, fakeStore, doc());

    assert.equal(embedCalls.length, 1, "应该把 9 节文本合并成一次 embed() 调用，不是逐节调用");
    assert.equal(embedCalls[0]!.length, REQUIRED_SECTIONS.length);
    assert.equal(upsertedPoints.length, REQUIRED_SECTIONS.length);
    assert.equal(upsertedPoints[0]!.payload.document_id, "abc123");
    assert.deepEqual(upsertedPoints[0]!.vector, [0, 1, 2]);
  });

  it("upsert 的 payload 字段是 snake_case，与 ExperienceQueryFilter 的过滤字段一一对应", async () => {
    const embedder: EmbeddingClient = {
      model: "fake-model",
      dimension: 3,
      async embed(texts: string[]) {
        return texts.map(() => [0, 0, 0]);
      },
    };
    let upsertedPoints: StorePoint[] = [];
    const fakeStore = {
      knowledgeSet: "claude-workflow-experience",
      async upsert(points: StorePoint[]) {
        upsertedPoints = points;
      },
    } as unknown as import("./store.ts").ExperienceStore;

    await ingestExperience(embedder, fakeStore, doc({ status: "verified", riskLevel: "low" }));

    const payload = upsertedPoints[0]!.payload;
    assert.equal(payload.status, "verified");
    assert.equal(payload.risk_level, "low");
    assert.equal(payload.knowledge_set, "claude-workflow-experience");
    assert.ok("source_file" in payload);
  });
});
