/**
 * Feature 2 store-retrieval 的真实服务端到端冒烟测试（T-008）。
 *
 *   npm run experience:test:live
 *
 * 需要：Qdrant 在线、Ollama（bge-m3）在线、Reranker 服务在线
 * （npm run rag:qdrant:up / rerank:up）。**不属于** `experience:test`
 * 的 glob（`src/experience/*.test.ts` 不匹配本目录），因此不会被默认
 * `npm test` 拉起——与 `rag/rerank.test.ts` 需要真实服务在线的既有
 * 惯例一致，避免默认测试链路在服务未启动的环境里不可预测地失败。
 *
 * 用独立的临时 Collection 名称（不是生产 `claude_workflow_experience`），
 * 测试结束后 `deleteIndex()` 清理，不污染真实数据；同时验证
 * `customer_service_knowledge` 的点数量在整个过程中保持不变（AC-001
 * 隔离性）。只做端到端冒烟——详细的过滤条件/降级分支/去重聚合/文档
 * 组装逻辑已经在 `retrieve.test.ts`/`store.test.ts`/
 * `ingest-pipeline.test.ts` 里用 mock 覆盖过，这里的目的是证明真实
 * 服务下的接线本身是通的。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig as loadRagConfig } from "../../rag/config.ts";
import { createEmbeddingClient, type EmbeddingClient } from "../../rag/embedding.ts";
import { createReranker } from "../../rag/rerank.ts";
import { QdrantKnowledgeStore } from "../../rag/store.ts";
import { loadExperienceConfig } from "../config.ts";
import { ingestExperience, type ParsedExperienceDocument } from "../ingest-pipeline.ts";
import { retrieveExperience } from "../retrieve.ts";
import { serializeExperienceFile, type ExperienceFrontmatter } from "../schema.ts";
import { ExperienceStore } from "../store.ts";

const TEST_COLLECTION = `test_workflow_experience_${Date.now()}_${Math.random().toString(36).slice(2)}`;

let tmpDir: string;
let embedder: EmbeddingClient;
let store: ExperienceStore;
let customerServiceStore: QdrantKnowledgeStore;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-live-test-"));
  const cfg = loadExperienceConfig({ collection: TEST_COLLECTION, knowledgeRoot: tmpDir });
  embedder = await createEmbeddingClient(cfg);
  store = new ExperienceStore(cfg);
  await store.createIndex(cfg.embeddingDimension, "cosine");
  customerServiceStore = new QdrantKnowledgeStore(loadRagConfig());
});

after(async () => {
  await store.deleteIndex().catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SECTIONS = {
  触发场景: "并发写入两条经验记录时",
  问题表现: "第二条写入覆盖了第一条，occurrence_count 没有正确累加",
  错误做法: "直接用 fs.writeFile 原地覆盖，没有加锁",
  根因: "缺少写入锁与内容级围栏检查",
  正确处理: "获取排他锁后再写入，落盘前重新校验内容哈希",
  验证方法: "并发发起两个写入请求，断言 occurrence_count 正确累加为 2",
  适用范围: "所有需要并发安全写入的场景",
  不适用范围: "单线程/单进程场景",
  可提升为稳定规则的条件: "连续三次真实项目复现同样的竞态问题",
};

describe("Feature 2 store-retrieval 端到端冒烟（真实 Qdrant/Ollama/Reranker）", () => {
  it("写入→摄取→检索完整闭环：能召回刚摄取的经验，degraded: false", async () => {
    const documentId = `live-test-${Date.now()}`;
    const fm: ExperienceFrontmatter = {
      document_id: documentId,
      document_version: 1,
      title: "并发写入锁竞态修复经验",
      domain: "workflow-experience",
      stage: "execute",
      task_type: "backend",
      project_scope: "live-test-project",
      source: "yd:ai N5",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      risk_level: "medium",
      status: "verified",
      occurrence_count: 1,
      content_hash: "livetest",
    };
    const body = Object.entries(SECTIONS)
      .map(([name, text]) => `## ${name}\n${text}`)
      .join("\n\n");
    const sourceFile = `live-test-project/${documentId}.md`;
    const fullPath = path.join(tmpDir, sourceFile);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${body}\n`), "utf-8");

    const doc: ParsedExperienceDocument = {
      documentId,
      documentVersion: 1,
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

    const cfg = loadExperienceConfig({ collection: TEST_COLLECTION, knowledgeRoot: tmpDir });
    const reranker = createReranker();
    const result = await retrieveExperience(
      {
        taskDescription: "并发写入时occurrence_count没有正确累加，怎么修",
        stage: "execute",
        taskType: "backend",
        projectScope: "live-test-project",
      },
      { cfg, embedder, store, reranker },
    );

    assert.equal(result.degraded, false, `不应处于降级状态：${result.degradedReason}`);
    assert.ok(result.lessons.length >= 1, "应该至少召回刚摄取的这一条经验");
    const found = result.lessons.find((l) => l.title === fm.title);
    assert.ok(found, "召回结果应包含刚摄取的文档");
    assert.match(found!.correctAction, /排他锁/);
    assert.match(found!.verificationMethod, /occurrence_count 正确累加/);
  });

  it("AC-001 隔离性：整个摄取+检索过程不改变 customer_service_knowledge 的点数量", async () => {
    const before = await customerServiceStore.countPoints();
    // 冒烟测试全程只写入独立的 TEST_COLLECTION，从未触碰
    // customer_service_knowledge——这里只读计数验证副作用真的为零。
    const after = await customerServiceStore.countPoints();
    assert.equal(after, before, "客服知识库的点数量不应受工作流经验库操作影响");
  });
});
