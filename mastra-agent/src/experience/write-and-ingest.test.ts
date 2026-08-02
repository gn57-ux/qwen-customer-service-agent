import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { RagConfig } from "../rag/config.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import type { StorePoint } from "../rag/store.ts";
import type { ExperienceStore } from "./store.ts";
import { type UpsertCandidate, upsertExperience } from "./write.ts";
import { writeExperienceAndIngest, writeExperienceWithFallback } from "./write-and-ingest.ts";

const VALID_BODY = [
  "# 标题",
  "## 触发场景",
  "描述",
  "## 问题表现",
  "描述",
  "## 错误做法",
  "描述",
  "## 根因",
  "描述",
  "## 正确处理",
  "描述",
  "## 验证方法",
  "描述",
  "## 适用范围",
  "描述",
  "## 不适用范围",
  "描述",
  "## 可提升为稳定规则的条件",
  "描述",
  "",
].join("\n");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-write-and-ingest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function candidate(overrides: Partial<UpsertCandidate> = {}): UpsertCandidate {
  return {
    experienceRoot: tmpDir,
    title: "写入摄取集成测试",
    stage: "execute",
    taskType: "backend",
    projectScope: "ai-kefu-test",
    source: "yd:ai N5",
    riskLevel: "medium",
    body: VALID_BODY,
    ...overrides,
  };
}

function fakeCfg(): RagConfig {
  return {
    qdrantUrl: "http://127.0.0.1:6333",
    collection: "claude_workflow_experience",
    embeddingBaseUrl: "http://127.0.0.1:11434/v1",
    embeddingModel: "bge-m3",
    embeddingDimension: 3,
    distance: "Cosine",
    knowledgeSet: "claude-workflow-experience",
    knowledgeRoot: tmpDir,
    globs: ["**/*.md"],
    chunk: { maxChars: 800, minChars: 400, overlapChars: 100 },
  };
}

function fakeEmbedder(
  behavior: "succeed" | "throw" = "succeed",
): EmbeddingClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "fake-model",
    dimension: 3,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      if (behavior === "throw") throw new Error("模拟 Embedding 服务不可用");
      return texts.map((_, i) => [i, i + 1, i + 2]);
    },
  };
}

function fakeCreateEmbedder(behavior: "succeed" | "reject") {
  return async () => {
    if (behavior === "reject") throw new Error("模拟 Embedding 服务探测失败（连接被拒绝）");
    return fakeEmbedder("succeed");
  };
}

function fakeStore(): ExperienceStore & { upserted: StorePoint[] } {
  const upserted: StorePoint[] = [];
  return {
    knowledgeSet: "claude-workflow-experience",
    upserted,
    async upsert(points: StorePoint[]) {
      upserted.push(...points);
    },
  } as unknown as ExperienceStore & { upserted: StorePoint[] };
}

describe("writeExperienceAndIngest", () => {
  it("写入成功且摄取成功时，ingested: true，向量点已写入 store", async () => {
    const embedder = fakeEmbedder("succeed");
    const store = fakeStore();
    const result = await writeExperienceAndIngest(candidate(), fakeCfg(), embedder, store);

    assert.equal(result.ok, true);
    assert.equal(result.ingested, true);
    assert.equal(result.ingestWarning, undefined);
    assert.equal(store.upserted.length, 9, "9 个二级标题应各产出一个向量点");
    assert.equal(store.upserted[0]!.payload.document_id, result.documentId);
  });

  it("写入成功但摄取失败（Embedding 服务不可用）时，不回滚 Markdown 文件，只记录告警", async () => {
    const embedder = fakeEmbedder("throw");
    const store = fakeStore();
    const result = await writeExperienceAndIngest(candidate(), fakeCfg(), embedder, store);

    assert.equal(result.ok, true, "Markdown 写入本身应当成功");
    assert.equal(result.ingested, false);
    assert.match(result.ingestWarning!, /模拟 Embedding 服务不可用/);

    // 核心断言：Markdown 文件必须仍然存在，且内容完整——摄取失败不应该
    // 撤销已经落盘的写入。
    const raw = await fs.readFile(result.filePath!, "utf-8");
    assert.ok(raw.includes("触发场景"));

    assert.equal(store.upserted.length, 0, "摄取失败时不应有任何向量点被写入");
  });

  it("写入本身失败（内容缺少必需二级标题）时，不调用 embedder，ingested: false", async () => {
    const embedder = fakeEmbedder("succeed");
    const store = fakeStore();
    const badBody = VALID_BODY.replace("## 验证方法\n描述\n", "");
    const result = await writeExperienceAndIngest(
      candidate({ body: badBody }),
      fakeCfg(),
      embedder,
      store,
    );

    assert.equal(result.ok, false);
    assert.equal(result.ingested, false);
    assert.equal(embedder.calls.length, 0, "写入失败时不应该调用 embedding 服务");
  });

  it("摄取成功时 source_file 是相对 knowledgeRoot 的路径，不含绝对用户目录", async () => {
    const embedder = fakeEmbedder("succeed");
    const store = fakeStore();
    await writeExperienceAndIngest(candidate(), fakeCfg(), embedder, store);

    const sourceFile = store.upserted[0]!.payload.source_file as string;
    assert.ok(!path.isAbsolute(sourceFile), "source_file 不应是绝对路径");
    assert.ok(!sourceFile.includes(os.homedir()), "source_file 不应包含用户主目录");
  });
});

describe("writeExperienceWithFallback（Feature 5 experience:write CLI 核心逻辑）", () => {
  it("createEmbedder 探测成功时，行为等同 writeExperienceAndIngest：写入且摄取", async () => {
    const store = fakeStore();
    const result = await writeExperienceWithFallback(candidate(), fakeCfg(), store, fakeCreateEmbedder("succeed"));

    assert.equal(result.ok, true);
    assert.equal(result.ingested, true);
    assert.equal(store.upserted.length, 9);
  });

  it("createEmbedder 探测阶段就失败（Embedding 服务不可达）时，仍完成 Markdown 写入，只跳过摄取", async () => {
    const store = fakeStore();
    const result = await writeExperienceWithFallback(candidate(), fakeCfg(), store, fakeCreateEmbedder("reject"));

    assert.equal(result.ok, true, "Embedding 探测失败不应影响 Markdown 写入本身");
    assert.equal(result.ingested, false);
    assert.match(result.ingestWarning!, /Embedding 服务不可用/);
    assert.match(result.ingestWarning!, /模拟 Embedding 服务探测失败/);
    assert.equal(store.upserted.length, 0, "探测失败时不应尝试任何向量写入");

    const raw = await fs.readFile(result.filePath!, "utf-8");
    assert.ok(raw.includes("触发场景"), "Markdown 文件应完整落盘，不受 Embedding 不可用影响");
  });

  it("Markdown 写入本身失败时（内容不合法），不调用 createEmbedder", async () => {
    const store = fakeStore();
    const badBody = VALID_BODY.replace("## 验证方法\n描述\n", "");
    let embedderCalled = false;
    const createEmbedder = async () => {
      embedderCalled = true;
      return fakeEmbedder("succeed");
    };

    const result = await writeExperienceWithFallback(candidate({ body: badBody }), fakeCfg(), store, createEmbedder);

    assert.equal(result.ok, false);
    assert.equal(result.ingested, false);
    assert.equal(embedderCalled, false, "写入失败时不应该尝试创建 Embedding 客户端");
  });
});
