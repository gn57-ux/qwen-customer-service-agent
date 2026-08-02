import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { RagConfig } from "../rag/config.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import type { Reranker, RerankerHealth } from "../rag/rerank.ts";
import { getExperienceStatus, type CreateEmbeddingClientFn } from "./status.ts";
import { serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-status-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

function fakeStore(behavior: "succeed" | "throw" = "succeed"): ExperienceStore {
  return {
    async health() {
      if (behavior === "throw") throw new Error("模拟 Qdrant 不可用");
      return "qdrant ok";
    },
  } as unknown as ExperienceStore;
}

function fakeCreateEmbedder(behavior: "succeed" | "throw" = "succeed"): CreateEmbeddingClientFn {
  return async () => {
    if (behavior === "throw") throw new Error("模拟 Embedding 服务不可用");
    return { model: "fake-model", dimension: 3, async embed() { return []; } } satisfies EmbeddingClient;
  };
}

function fakeReranker(available: boolean): Reranker {
  return {
    name: "fake",
    async health(): Promise<RerankerHealth> {
      return { available, detail: available ? "健康" : "模拟 Reranker 不可用" };
    },
    async rerank() {
      throw new Error("不应该被调用");
    },
  };
}

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

async function writeDoc(relativePath: string, fm: ExperienceFrontmatter): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, "# 标题\n"), "utf-8");
}

describe("getExperienceStatus", () => {
  it("按 status 分组统计文档数量（不是向量点数）", async () => {
    await writeDoc("proj/c1.md", validFm({ document_id: "c1", status: "candidate" }));
    await writeDoc("proj/c2.md", validFm({ document_id: "c2", status: "candidate" }));
    await writeDoc("proj/v1.md", validFm({ document_id: "v1", status: "verified" }));
    await writeDoc("proj/d1.md", validFm({ document_id: "d1", status: "deprecated" }));

    const report = await getExperienceStatus(fakeCfg(), fakeStore(), fakeReranker(true), fakeCreateEmbedder());
    assert.deepEqual(report.countsByStatus, { candidate: 2, verified: 1, deprecated: 1 });
    assert.equal(report.unparseableCount, 0);
  });

  it("Qdrant 不可用时该字段标注不可用，不抛出异常，仍能给出文件统计", async () => {
    await writeDoc("proj/v1.md", validFm({ document_id: "v1", status: "verified" }));
    const report = await getExperienceStatus(
      fakeCfg(),
      fakeStore("throw"),
      fakeReranker(true),
      fakeCreateEmbedder(),
    );
    assert.equal(report.qdrant.available, false);
    assert.match(report.qdrant.detail, /模拟 Qdrant 不可用/);
    assert.equal(report.countsByStatus.verified, 1, "Qdrant 探测失败不应影响基于文件系统的统计");
  });

  it("Reranker 不可用时该字段标注不可用，命令整体不失败", async () => {
    const report = await getExperienceStatus(fakeCfg(), fakeStore(), fakeReranker(false), fakeCreateEmbedder());
    assert.equal(report.reranker.available, false);
  });

  it("Embedding 不可用时该字段标注不可用，命令整体不失败", async () => {
    const report = await getExperienceStatus(
      fakeCfg(),
      fakeStore(),
      fakeReranker(true),
      fakeCreateEmbedder("throw"),
    );
    assert.equal(report.embedding.available, false);
    assert.match(report.embedding.detail, /模拟 Embedding 服务不可用/);
  });

  it("无法解析 frontmatter 的文件计入 unparseableCount，不计入任何 status 分组", async () => {
    await fs.mkdir(path.join(tmpDir, "proj"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "proj", "broken.md"), "不合法内容", "utf-8");

    const report = await getExperienceStatus(fakeCfg(), fakeStore(), fakeReranker(true), fakeCreateEmbedder());
    assert.equal(report.unparseableCount, 1);
    assert.deepEqual(report.countsByStatus, { candidate: 0, verified: 0, deprecated: 0 });
  });
});
