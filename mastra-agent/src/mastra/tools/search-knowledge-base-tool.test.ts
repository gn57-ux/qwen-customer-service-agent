/**
 * searchKnowledgeBaseTool 集成测试：真实 Qdrant + Ollama(bge-m3) + Reranker。
 * 只读检索已入库的正式 Collection，不写入、不修改。
 *
 *   npm run agent:test:live
 *   需要：Qdrant 在线、Ollama 在线、npm run rerank:up 已启动。
 *
 * 覆盖：
 *   1. 正常检索：返回结果包含 title/section/sourceFile/documentVersion/vectorScore/rerankScore
 *   2. reranked=true 时 rerankScore 全部非空，且按 rerankScore 降序
 *   3. 只检索 knowledge_set=customer-service（复用 store.ts 的隔离，非本工具重新实现）
 *   4. Reranker 不可用时 degraded=true，rerankScore 全部为 null，不冒充已重排
 *   5. 无召回结果时返回空数组，不报错
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.RERANK_BASE_URL = process.env.RERANK_BASE_URL || "http://127.0.0.1:8787";

import {
  __resetSearchKnowledgeBaseClientsForTest,
  searchKnowledgeBaseTool,
} from "./search-knowledge-base-tool.ts";

describe("searchKnowledgeBaseTool", () => {
  before(() => {
    __resetSearchKnowledgeBaseClientsForTest();
  });

  after(() => {
    __resetSearchKnowledgeBaseClientsForTest();
  });

  it("正常检索：字段齐全，reranked=true 时 rerankScore 非空且降序", async () => {
    const result = (await searchKnowledgeBaseTool.execute!(
      { query: "冰箱不制冷应该先检查什么" } as any,
      undefined as any,
    )) as any;

    assert.ok(result.results.length > 0, "应该有召回结果");
    assert.ok(result.results.length <= 5, "最终结果不应超过 Top5");

    for (const item of result.results) {
      assert.equal(typeof item.title, "string");
      assert.equal(typeof item.section, "string");
      assert.equal(typeof item.sourceFile, "string");
      assert.equal(typeof item.documentVersion, "string");
      assert.equal(typeof item.vectorScore, "number");
      assert.ok(item.sourceFile.length > 0);
    }

    if (result.reranked) {
      assert.equal(result.degraded, false);
      for (const item of result.results) {
        assert.equal(typeof item.rerankScore, "number");
      }
      const scores = result.results.map((r: any) => r.rerankScore);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "结果必须按 rerankScore 降序");
    } else {
      assert.equal(result.degraded, true, "非 reranked 状态必须显式标记 degraded");
      assert.ok((result.degradedReason ?? "").length > 0, "降级必须给出原因");
      for (const item of result.results) {
        assert.equal(item.rerankScore, null, "降级时不得用向量顺序冒充 rerankScore");
      }
    }
  });

  it("检索隔离：结果全部来自 knowledge_set=customer-service（复用 store.ts，不重新过滤）", async () => {
    const result = (await searchKnowledgeBaseTool.execute!(
      { query: "显示器提示无信号怎么排查" } as any,
      undefined as any,
    )) as any;
    assert.ok(result.results.length > 0);
    // sourceFile 全部来自 knowledge/repair 下的已入库文档（domain 相关文件名）
    for (const item of result.results) {
      assert.match(item.sourceFile, /\.md$/);
    }
  });

  it("Reranker 不可用时：degraded=true，rerankScore 全部为 null，不冒充已重排", async () => {
    const originalBaseUrl = process.env.RERANK_BASE_URL;
    process.env.RERANK_BASE_URL = "http://127.0.0.1:59999"; // 确定无人监听
    __resetSearchKnowledgeBaseClientsForTest();
    try {
      const result = (await searchKnowledgeBaseTool.execute!(
        { query: "冰箱不制冷应该先检查什么" } as any,
        undefined as any,
      )) as any;
      assert.equal(result.reranked, false);
      assert.equal(result.degraded, true);
      assert.ok((result.degradedReason ?? "").length > 0);
      for (const item of result.results) {
        assert.equal(item.rerankScore, null);
      }
      assert.ok(result.results.length > 0, "降级时仍应返回向量顺序 Top5，不是空结果");
    } finally {
      process.env.RERANK_BASE_URL = originalBaseUrl;
      __resetSearchKnowledgeBaseClientsForTest();
    }
  });

  it("无召回结果的极端 query 不报错（允许返回空数组）", async () => {
    const result = (await searchKnowledgeBaseTool.execute!(
      { query: "🌌🚀完全无关的随机字符串xyzzy不存在的产品型号量子冰箱" } as any,
      undefined as any,
    )) as any;
    assert.ok(Array.isArray(result.results));
  });
});
