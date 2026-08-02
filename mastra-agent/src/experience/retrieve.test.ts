import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { RagConfig } from "../rag/config.ts";
import type { EmbeddingClient } from "../rag/embedding.ts";
import type { RerankDocument, RerankResult, Reranker, RerankerHealth } from "../rag/rerank.ts";
import type { StoreHit } from "../rag/store.ts";
import { retrieveExperience, type RetrieveDeps, type RetrieveQuery } from "./retrieve.ts";
import { REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-retrieve-test-"));
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

async function writeSourceDoc(
  relativePath: string,
  overrides: Partial<ExperienceFrontmatter> = {},
  sections: Partial<Record<(typeof REQUIRED_SECTIONS)[number], string>> = {},
): Promise<void> {
  const fm: ExperienceFrontmatter = {
    document_id: "doc-1",
    document_version: 1,
    title: "锁竞态修复经验",
    domain: "workflow-experience",
    stage: "execute",
    task_type: "backend",
    project_scope: "my-project",
    source: "yd:ai N5",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    risk_level: "medium",
    status: "verified",
    occurrence_count: 1,
    content_hash: "deadbeef",
    ...overrides,
  };
  const body = REQUIRED_SECTIONS.map((name) => `## ${name}\n${sections[name] ?? `${name}的内容`}`).join(
    "\n\n",
  );
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${body}\n`), "utf-8");
}

function baseQuery(overrides: Partial<RetrieveQuery> = {}): RetrieveQuery {
  return {
    taskDescription: "修复一个锁竞态问题",
    stage: "execute",
    projectScope: "my-project",
    ...overrides,
  };
}

function makeEmbedder(behavior: "succeed" | "throw" = "succeed"): EmbeddingClient & { calls: number } {
  let calls = 0;
  return {
    model: "fake-model",
    dimension: 3,
    get calls() {
      return calls;
    },
    async embed(texts: string[]) {
      calls += 1;
      if (behavior === "throw") throw new Error("模拟 Embedding 服务不可用");
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

function makeStore(
  hits: StoreHit[],
  behavior: "succeed" | "throw" = "succeed",
): ExperienceStore & { lastFilter?: Record<string, unknown> } {
  const state: { lastFilter?: Record<string, unknown> } = {};
  return {
    knowledgeSet: "claude-workflow-experience",
    get lastFilter() {
      return state.lastFilter;
    },
    async query(_vector: number[], _topK: number, extraFilter?: Record<string, unknown>) {
      state.lastFilter = extraFilter;
      if (behavior === "throw") throw new Error("模拟 Qdrant 不可用");
      return hits;
    },
  } as unknown as ExperienceStore & { lastFilter?: Record<string, unknown> };
}

function makeReranker(status: "ok" | "unavailable"): Reranker {
  return {
    name: "fake-reranker",
    async health(): Promise<RerankerHealth> {
      return { available: status === "ok", detail: status };
    },
    async rerank(_query: string, documents: RerankDocument[], topK: number): Promise<RerankResult> {
      if (status === "unavailable") {
        return {
          status: "unavailable",
          ranked: [],
          reason: "模拟 Reranker 不可用",
          elapsedMs: null,
          candidateCount: documents.length,
          rerankerName: "fake-reranker",
        };
      }
      // 简单起见：按输入顺序反转排序（制造一个与向量分数不同的顺序，
      // 用来验证 retrieve.ts 确实采纳了 rerank 的结果而不是向量分数）。
      const ranked = [...documents]
        .reverse()
        .slice(0, topK)
        .map((d, i) => ({ id: d.id, rerankScore: 1 - i * 0.1, rerankRank: i + 1 }));
      return {
        status: "ok",
        ranked,
        elapsedMs: 10,
        candidateCount: documents.length,
        rerankerName: "fake-reranker",
      };
    },
  };
}

function hitFor(
  documentId: string,
  section: string,
  score: number,
  overrides: Partial<Record<string, unknown>> = {},
): StoreHit {
  return {
    id: `${documentId}#${section}`,
    score,
    payload: {
      document_id: documentId,
      document_version: 1,
      title: "锁竞态修复经验",
      section,
      source_file: `${documentId}.md`,
      status: "verified",
      ...overrides,
    },
  };
}

describe("retrieveExperience", () => {
  it("AC-007: taskDescription 命中 Token 类内容时，在调用 embedder 之前就返回 input_blocked，不调用 embed()", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(
      baseQuery({ taskDescription: "泄露了 sk-abcdefghijklmnopqrstuvwxyz123456" }),
      deps,
    );

    assert.deepEqual(result, { lessons: [], degraded: true, degradedReason: "input_blocked" });
    assert.equal(embedder.calls, 0, "input_blocked 时不应调用 embedder.embed()");
  });

  it("AC-004: Embedding 服务不可用时返回 embedding_unavailable，不抛出未捕获异常", async () => {
    const embedder = makeEmbedder("throw");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.deepEqual(result, { lessons: [], degraded: true, degradedReason: "embedding_unavailable" });
  });

  it("AC-004: Qdrant 服务不可用时返回 qdrant_unavailable，不抛出未捕获异常", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([], "throw");
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.deepEqual(result, { lessons: [], degraded: true, degradedReason: "qdrant_unavailable" });
  });

  it("AC-003: Reranker 不可用时仍返回结果（基于向量分数），degraded: true 且 degradedReason 明确标注", async () => {
    await writeSourceDoc("doc-1.md", { document_id: "doc-1" });
    const embedder = makeEmbedder("succeed");
    const store = makeStore([hitFor("doc-1", "问题表现", 0.9)]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("unavailable") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, "reranker_unavailable");
    assert.equal(result.lessons.length, 1);
    assert.equal(result.lessons[0]!.relevanceScore, 0.9, "降级时应使用向量分数作为 relevanceScore");
  });

  it("AC-006: scopeMode 默认/project-and-global 时，projectScopeIn 同时包含当前项目与 global", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    await retrieveExperience(baseQuery({ projectScope: "my-project" }), deps);
    assert.deepEqual(store.lastFilter?.projectScopeIn, ["my-project", "global"]);
  });

  it("AC-006b: scopeMode=project-only 时，projectScopeIn 只包含当前项目，不含 global", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    await retrieveExperience(baseQuery({ projectScope: "my-project", scopeMode: "project-only" }), deps);
    assert.deepEqual(store.lastFilter?.projectScopeIn, ["my-project"]);
  });

  it("查询过滤条件恒定要求 status=verified，不召回 candidate/deprecated", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    await retrieveExperience(baseQuery(), deps);
    assert.equal(store.lastFilter?.status, "verified");
  });

  it("AC-008: 同一 document_id 的多个不同小节命中时，去重聚合后只产出一条 RetrievedLesson，字段来自真实跨小节正文", async () => {
    await writeSourceDoc(
      "doc-1.md",
      { document_id: "doc-1" },
      {
        问题表现: "真实的问题表现内容",
        根因: "真实的根因内容",
        正确处理: "真实的正确处理内容",
        验证方法: "真实的验证方法内容",
      },
    );
    const embedder = makeEmbedder("succeed");
    // 同一 document_id 的两个不同小节都命中——"错误做法"分数更高，
    // "根因"分数更低；去重后应该只保留分数更高的那个作为代表 hit。
    const store = makeStore([
      hitFor("doc-1", "错误做法", 0.95),
      hitFor("doc-1", "根因", 0.6),
    ]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.equal(result.lessons.length, 1, "同一文档的多个小节命中应该去重聚合成一条结果");
    const lesson = result.lessons[0]!;
    assert.equal(lesson.summary, "真实的问题表现内容\n真实的根因内容");
    assert.equal(lesson.correctAction, "真实的正确处理内容");
    assert.equal(lesson.verificationMethod, "真实的验证方法内容");
    assert.notEqual(lesson.summary, "", "summary 不应是空字符串");
  });

  it("源文件缺失必需小节时跳过该候选，不让整次检索失败", async () => {
    // 缺少"验证方法"节。
    const fm: ExperienceFrontmatter = {
      document_id: "doc-broken",
      document_version: 1,
      title: "结构不完整的经验",
      domain: "workflow-experience",
      stage: "execute",
      task_type: "backend",
      project_scope: "my-project",
      source: "yd:ai N5",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      risk_level: "medium",
      status: "verified",
      occurrence_count: 1,
      content_hash: "deadbeef",
    };
    const brokenBody = ["问题表现", "根因", "正确处理"]
      .map((name) => `## ${name}\n内容`)
      .join("\n\n");
    await fs.writeFile(
      path.join(tmpDir, "doc-broken.md"),
      serializeExperienceFile(fm, `# 标题\n\n${brokenBody}\n`),
      "utf-8",
    );

    const embedder = makeEmbedder("succeed");
    const store = makeStore([hitFor("doc-broken", "问题表现", 0.8, { source_file: "doc-broken.md" })]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.deepEqual(result.lessons, [], "结构不完整的候选应被跳过，不产出半截结果");
    assert.equal(result.degraded, false, "跳过单条候选不属于需要 degradedReason 的整体降级");
  });

  it("源文件读取失败（不存在）时跳过该候选，不抛出异常", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([hitFor("doc-missing", "问题表现", 0.8, { source_file: "不存在的文件.md" })]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.deepEqual(result.lessons, []);
    assert.equal(result.degraded, false);
  });

  it("没有任何候选命中时返回空结果，degraded: false（这是正常的“没有相关经验”，不是故障）", async () => {
    const embedder = makeEmbedder("succeed");
    const store = makeStore([]);
    const deps: RetrieveDeps = { cfg: fakeCfg(), embedder, store, reranker: makeReranker("ok") };

    const result = await retrieveExperience(baseQuery(), deps);
    assert.deepEqual(result, { lessons: [], degraded: false });
  });
});
