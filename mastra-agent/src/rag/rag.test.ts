/**
 * RAG 基础层最小自动验证。
 *
 *   npm run rag:test
 *
 * 安全约束：
 * - **任何写库用例都使用独立临时 Collection**（`rag_selftest_<pid>_<n>`），
 *   用完立即删除；正式的 customer_service_knowledge 全程只读，不被修改。
 * - 需要 Qdrant 与 Ollama 在线；任一不可用时用例会明确失败而不是静默跳过。
 *
 * 覆盖：
 *   1. duplicate document_id 必须失败
 *   2. Embedding 维度错误必须失败
 *   3. Collection 维度 / 距离错误必须失败
 *   4. 无 --recreate 时不得删除 Collection
 *   5. 连续两次摄取，repair scope 点 ID 与点数一致
 *   6. 模拟 upsert 失败时旧点仍保留
 *   7. 删除一份文档后只清理对应 scope 的旧点
 *   8. 不误删 policies scope 的模拟点
 *   9. 查询必须按 knowledge_set 隔离，其他知识集不得进入结果
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, type RagConfig } from "./config.ts";
import { createEmbeddingClient, type EmbeddingClient } from "./embedding.ts";
import { loadAndChunk } from "./markdown.ts";
import { runIngestion, toPayload } from "./pipeline.ts";
import { QdrantKnowledgeStore, type KnowledgeStore, type StorePoint } from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTRA_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(MASTRA_ROOT, "..");

let collectionSeq = 0;
const createdCollections: Array<{ cfg: RagConfig; store: QdrantKnowledgeStore }> = [];

function tempCollectionName(): string {
  collectionSeq += 1;
  return `rag_selftest_${process.pid}_${collectionSeq}`;
}

/** 生成一个指向临时 Collection 的配置；正式 Collection 不受影响 */
function tempConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return loadConfig({ collection: tempCollectionName(), ...overrides });
}

function trackStore(cfg: RagConfig): QdrantKnowledgeStore {
  const store = new QdrantKnowledgeStore(cfg);
  createdCollections.push({ cfg, store });
  return store;
}

/** 写一组临时知识文档，返回临时 repoRoot */
async function makeKnowledgeTree(
  files: Array<{ scope: string; name: string; documentId: string; title?: string; body?: string }>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rag-selftest-"));
  for (const f of files) {
    const dir = path.join(root, "knowledge", f.scope);
    await mkdir(dir, { recursive: true });
    const content =
      `---\n` +
      `document_id: ${f.documentId}\n` +
      `document_version: 1.0.0\n` +
      `title: ${f.title ?? f.documentId}\n` +
      `domain: selftest\n` +
      `source: selftest\n` +
      `updated_at: 2026-07-30\n` +
      `risk_level: low\n` +
      `---\n\n` +
      (f.body ??
        `# ${f.title ?? f.documentId}\n\n## 小节一\n\n这是自测文档的第一段内容，用于验证摄取流程。\n\n## 小节二\n\n这是自测文档的第二段内容。\n`);
    await writeFile(path.join(dir, f.name), content, "utf8");
  }
  return root;
}

let embedder: EmbeddingClient;

before(async () => {
  // 用正式配置校验 Embedding 服务；只读，不碰任何 Collection
  embedder = await createEmbeddingClient(loadConfig());
});

after(async () => {
  for (const { store } of createdCollections) {
    try {
      const info = await store.describe();
      if (info.exists) await store.deleteIndex();
    } catch {
      // 清理尽力而为
    }
  }
  // 兜底：确认没有遗留的自测 Collection
  const leftovers: string[] = [];
  for (const { store } of createdCollections) {
    try {
      if ((await store.describe()).exists) leftovers.push(store.indexName);
    } catch {
      /* ignore */
    }
  }
  assert.deepEqual(leftovers, [], `自测 Collection 未清理干净：${leftovers.join(", ")}`);
});

// ---------------------------------------------------------------------------

describe("1. duplicate document_id 必须失败", () => {
  it("两份文档使用同一个 document_id 时抛错且指出冲突文件", async () => {
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "dup-doc-1" },
      { scope: "repair", name: "b.md", documentId: "dup-doc-1" },
    ]);
    const cfg = loadConfig({ knowledgeRoot: "knowledge", globs: ["repair/*.md"] });
    await assert.rejects(
      () => loadAndChunk(cfg, root),
      (error: Error) => {
        assert.match(error.message, /document_id 重复/);
        assert.match(error.message, /dup-doc-1/);
        return true;
      },
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("2. Embedding 维度错误必须失败", () => {
  it("EMBEDDING_DIMENSION 与模型实测不符时拒绝继续", async () => {
    const cfg = loadConfig({ embeddingDimension: 999 });
    await assert.rejects(
      () => createEmbeddingClient(cfg),
      (error: Error) => {
        assert.match(error.message, /维度与配置不符/);
        assert.match(error.message, /999/);
        return true;
      },
    );
  });

  it("模型不存在时给出中文错误并提示 ollama pull，不回退其他模型", async () => {
    const cfg = loadConfig({ embeddingModel: "definitely-not-a-real-model-xyz" });
    await assert.rejects(
      () => createEmbeddingClient(cfg),
      (error: Error) => {
        assert.match(error.message, /不存在|失败/);
        return true;
      },
    );
  });
});

describe("3. Collection 维度或距离错误必须失败", () => {
  it("已存在 Collection 维度与实测维度不符时中止", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    await store.createIndex(64, "cosine"); // 故意建成 64 维
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "dim-doc-1" },
    ]);
    await assert.rejects(
      () => runIngestion(cfg, { embedder, store, repoRoot: root }),
      (error: Error) => {
        assert.match(error.message, /维度不一致/);
        assert.match(error.message, /不会删除已有 Collection/);
        return true;
      },
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("4. 无 --recreate 时不得删除 Collection", () => {
  it("维度冲突时原 Collection 与其中的点必须原样保留", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    await store.createIndex(64, "cosine");
    await store.createPayloadIndexes(["knowledge_set", "ingestion_scope", "document_id"]);
    await store.upsert([
      {
        id: "11111111-1111-1111-1111-111111111111",
        vector: Array.from({ length: 64 }, () => 0.1),
        payload: { knowledge_set: cfg.knowledgeSet, ingestion_scope: "repair", document_id: "keep" },
      },
    ]);
    const before = await store.countPoints();
    assert.equal(before, 1);

    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "norecreate-doc-1" },
    ]);
    await assert.rejects(() => runIngestion(cfg, { embedder, store, repoRoot: root }));

    const info = await store.describe();
    assert.equal(info.exists, true, "Collection 不应被删除");
    assert.equal(info.dimension, 64, "维度不应被改写");
    assert.equal(await store.countPoints(), 1, "原有点不应丢失");
    await rm(root, { recursive: true, force: true });
  });
});

describe("5. 连续两次摄取，repair scope 点 ID 与点数一致", () => {
  it("第二次摄取不产生新点、不删旧点，idempotent=true", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "idem-doc-1" },
      { scope: "repair", name: "b.md", documentId: "idem-doc-2" },
    ]);

    const first = await runIngestion(cfg, { embedder, store, repoRoot: root });
    assert.equal(first.failures.length, 0);
    assert.equal(first.counts.idempotent, true);
    const firstIds = (await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope: "repair" }))
      .map((p) => p.id)
      .sort();

    const second = await runIngestion(cfg, { embedder, store, repoRoot: root });
    const secondIds = (await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope: "repair" }))
      .map((p) => p.id)
      .sort();

    assert.deepEqual(secondIds, firstIds, "两次摄取的点 ID 集合必须一致");
    assert.equal(second.counts.stalePointsDeleted, 0, "幂等运行不应删除任何点");
    assert.equal(second.counts.idempotent, true);
    assert.equal(
      second.counts.currentScopePointCount,
      second.counts.expectedScopeChunkCount,
      "scope 点数应等于期望 chunk 数",
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("6. 模拟 upsert 失败时旧点仍保留", () => {
  it("某文档 upsert 抛错时，它的旧点不被删除，且整体报告失败", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "fail-doc-1" },
      { scope: "repair", name: "b.md", documentId: "fail-doc-2" },
    ]);

    // 先正常入库一次
    const first = await runIngestion(cfg, { embedder, store, repoRoot: root });
    assert.equal(first.failures.length, 0);
    const before = await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope: "repair" });
    const doc1Before = before.filter((p) => p.documentId === "fail-doc-1").map((p) => p.id).sort();
    assert.ok(doc1Before.length > 0);

    // 改写 fail-doc-1 的内容，使其 chunk ID 全变（正常情况下旧点会被清理）
    await writeFile(
      path.join(root, "knowledge", "repair", "a.md"),
      `---\ndocument_id: fail-doc-1\ndocument_version: 2.0.0\ntitle: 改写后\n` +
        `domain: selftest\nsource: selftest\nupdated_at: 2026-07-31\nrisk_level: low\n---\n\n` +
        `# 改写后\n\n## 新小节\n\n内容已经完全不同，chunk 哈希会变化。\n`,
      "utf8",
    );

    // 注入只对 fail-doc-1 失败的 store
    const failing: KnowledgeStore = {
      ...store,
      indexName: store.indexName,
      health: () => store.health(),
      describe: () => store.describe(),
      createIndex: (d, m) => store.createIndex(d, m),
      deleteIndex: () => store.deleteIndex(),
      createPayloadIndexes: (f) => store.createPayloadIndexes(f),
      query: (v, k) => store.query(v, k),
      listPoints: (f) => store.listPoints(f),
      countPoints: (f) => store.countPoints(f),
      deletePoints: (ids) => store.deletePoints(ids),
      upsert: async (points: StorePoint[]) => {
        if (points.some((p) => p.payload.document_id === "fail-doc-1")) {
          throw new Error("模拟写入失败");
        }
        return store.upsert(points);
      },
    };

    const second = await runIngestion(cfg, { embedder, store: failing, repoRoot: root });
    assert.ok(second.failures.length > 0, "应报告失败");
    assert.equal(second.counts.idempotent, false, "存在失败文档时不应判为幂等");

    const after = await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope: "repair" });
    const doc1After = after.filter((p) => p.documentId === "fail-doc-1").map((p) => p.id).sort();
    assert.deepEqual(doc1After, doc1Before, "失败文档的旧点必须原样保留");

    const scopeStat = second.scopes.find((s) => s.scope === "repair")!;
    assert.ok(
      scopeStat.protectedDocuments.includes("fail-doc-1"),
      "报告应标注被保护的文档",
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("7 & 8. scope 隔离：删除文档只清理本 scope，且不误删 policies", () => {
  it("repair 文档被删除后只清理其 repair 点，policies 模拟点完好", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "scope-repair-1" },
      { scope: "repair", name: "b.md", documentId: "scope-repair-2" },
    ]);

    const first = await runIngestion(cfg, { embedder, store, repoRoot: root });
    assert.equal(first.failures.length, 0);

    // 手工塞入 policies scope 的模拟点（同一 Collection、同一 knowledge_set）
    const policiesIds = [
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ];
    await store.upsert(
      policiesIds.map((id) => ({
        id,
        vector: Array.from({ length: embedder.dimension }, () => 0.01),
        payload: {
          knowledge_set: cfg.knowledgeSet,
          ingestion_scope: "policies",
          document_id: "policy-doc-1",
          text: "政策文档模拟点",
        },
      })),
    );
    // 另一个 knowledge_set 的点，同样不能被碰
    const otherSetId = "44444444-4444-4444-4444-444444444444";
    await store.upsert([
      {
        id: otherSetId,
        vector: Array.from({ length: embedder.dimension }, () => 0.02),
        payload: {
          knowledge_set: "other-set",
          ingestion_scope: "repair",
          document_id: "other-doc-1",
        },
      },
    ]);

    // 删除一份 repair 文档后重新摄取
    await rm(path.join(root, "knowledge", "repair", "b.md"));
    const second = await runIngestion(cfg, { embedder, store, repoRoot: root });
    assert.equal(second.failures.length, 0);

    const repairAfter = await store.listPoints({ knowledgeSet: cfg.knowledgeSet, scope: "repair" });
    const remainingDocs = [...new Set(repairAfter.map((p) => p.documentId))].sort();
    assert.deepEqual(remainingDocs, ["scope-repair-1"], "被删除文档的 repair 点应被清理");
    assert.ok(second.counts.stalePointsDeleted > 0, "应统计到清理数量");

    const policiesAfter = await store.listPoints({
      knowledgeSet: cfg.knowledgeSet,
      scope: "policies",
    });
    assert.deepEqual(
      policiesAfter.map((p) => p.id).sort(),
      [...policiesIds].sort(),
      "policies scope 的点不得被误删",
    );

    const otherSetAfter = await store.listPoints({ knowledgeSet: "other-set" });
    assert.equal(otherSetAfter.length, 1, "其他 knowledge_set 的点不得被误删");

    // 幂等统计不能用 Collection 总点数：这里总点数明显大于 repair 期望 chunk 数
    assert.ok(
      second.counts.collectionTotalPointCount > second.counts.expectedScopeChunkCount,
      "本用例应存在其他 scope / set 的点",
    );
    assert.equal(second.counts.idempotent, true, "repair scope 单独重复摄取仍应判为幂等");

    await rm(root, { recursive: true, force: true });
  });
});

describe("9. 查询按 knowledge_set 隔离", () => {
  it("同 Collection 内写入两个高度相似的点，查询只返回本知识集的那个", async () => {
    const cfg = tempConfig();
    const store = trackStore(cfg);
    await store.createIndex(embedder.dimension, "cosine");
    await store.createPayloadIndexes(["knowledge_set", "ingestion_scope", "document_id"]);

    // 两条内容高度相似的文本，分属不同 knowledge_set：
    // 若 query 不按 knowledge_set 过滤，other-set 必然会挤进 Top K。
    const sharedText = "冰箱不制冷时应先确认供电、温度设置和门封状态。";
    const [vecOurs, vecOther] = await embedder.embed([sharedText, sharedText]);

    const oursId = "aaaaaaaa-0000-0000-0000-00000000aaaa";
    const otherId = "bbbbbbbb-0000-0000-0000-00000000bbbb";
    await store.upsert([
      {
        id: oursId,
        vector: vecOurs!,
        payload: {
          knowledge_set: cfg.knowledgeSet,
          ingestion_scope: "repair",
          document_id: "iso-ours",
          domain: "refrigerator",
          text: sharedText,
        },
      },
      {
        id: otherId,
        vector: vecOther!,
        payload: {
          knowledge_set: "other-set",
          ingestion_scope: "repair",
          document_id: "iso-other",
          domain: "refrigerator",
          text: sharedText,
        },
      },
    ]);

    // 先确认两个点确实都在库里，排除"根本没写进去"造成的假阳性
    assert.equal(await store.countPoints(), 2, "两个点都应写入");
    assert.equal(await store.countPoints({ knowledgeSet: "other-set" }), 1);

    const [queryVector] = await embedder.embed(["冰箱不制冷应该先检查什么"]);
    const hits = await store.query(queryVector!, 10);

    assert.ok(hits.length > 0, "本知识集应有召回");
    assert.deepEqual(
      hits.map((h) => h.id),
      [oursId],
      "结果中只能出现本 knowledge_set 的点",
    );
    for (const hit of hits) {
      assert.equal(
        hit.payload.knowledge_set,
        cfg.knowledgeSet,
        "命中点的 knowledge_set 必须与配置一致",
      );
    }
    assert.ok(
      !hits.some((h) => h.id === otherId),
      "other-set 的点绝不能出现在结果中",
    );

    // 反向确认：other-set 的点本身是可被检索到的（证明上面的缺席是过滤所致，而非向量不相似）
    const otherStore = trackStore(loadConfig({ collection: cfg.collection, knowledgeSet: "other-set" }));
    const otherHits = await otherStore.query(queryVector!, 10);
    assert.deepEqual(
      otherHits.map((h) => h.id),
      [otherId],
      "换成 other-set 时应只返回 other-set 的点",
    );
  });
});

describe("payload 字段完整性", () => {
  it("每个 chunk 的 payload 都带 knowledge_set 与 ingestion_scope", async () => {
    const root = await makeKnowledgeTree([
      { scope: "repair", name: "a.md", documentId: "payload-doc-1" },
    ]);
    const cfg = loadConfig();
    const { chunks } = await loadAndChunk(cfg, root);
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      const payload = toPayload(chunk);
      assert.equal(payload.knowledge_set, "customer-service");
      assert.equal(payload.ingestion_scope, "repair");
      for (const key of [
        "document_id",
        "document_version",
        "title",
        "section",
        "domain",
        "source",
        "updated_at",
        "risk_level",
        "text",
        "chunk_index",
        "content_hash",
        "source_file",
      ]) {
        assert.ok(payload[key] !== undefined && payload[key] !== "", `payload.${key} 缺失`);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
});
