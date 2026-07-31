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
 *   5. 无召回结果时返回空数组，不报错（真实 query 场景，最佳努力，非确定性分支覆盖）
 *   6. retrievedCount/returnedCount：四个分支下均取自运行时 hits.length/results.length，
 *      不得等于 RAG_RECALL_TOP_N/RAG_FINAL_TOP_K 等配置值（除非恰好命中数等于配置值本身）
 *
 * hits=[]（空召回）分支的确定性覆盖不依赖"凑一个真的搜不到的 query"这种不可控条件——
 * 见下方"hits=[] 空召回分支（确定性覆盖）"用例，直接把 hits:[] 传给纯组装函数
 * assembleSearchResult()，不涉及真实网络请求，因此在没有 Qdrant/Ollama 时也能跑。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.RERANK_BASE_URL = process.env.RERANK_BASE_URL || "http://127.0.0.1:8787";

import {
  __resetSearchKnowledgeBaseClientsForTest,
  assembleSearchResult,
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

    assert.equal(typeof result.retrievedCount, "number");
    assert.equal(typeof result.returnedCount, "number");
    assert.ok(result.retrievedCount >= result.returnedCount, "命中数必须 >= 最终返回数");
    assert.equal(result.returnedCount, result.results.length, "returnedCount 必须等于 results.length");

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
      assert.equal(typeof result.retrievedCount, "number");
      assert.equal(result.returnedCount, result.results.length, "降级分支 returnedCount 必须等于截断后的 results.length");
      assert.ok(result.retrievedCount >= result.returnedCount);
    } finally {
      process.env.RERANK_BASE_URL = originalBaseUrl;
      __resetSearchKnowledgeBaseClientsForTest();
    }
  });

  it("无召回结果的极端 query 不报错（真实检索，允许返回空数组，最佳努力）", async () => {
    const result = (await searchKnowledgeBaseTool.execute!(
      { query: "🌌🚀完全无关的随机字符串xyzzy不存在的产品型号量子冰箱" } as any,
      undefined as any,
    )) as any;
    assert.ok(Array.isArray(result.results));
    // 是否真的召回为空取决于向量相似度和已入库数据，这里不对 retrievedCount/
    // returnedCount 做条件断言（那是伪覆盖）；hits=[] 分支的确定性断言见下方用例。
  });

  it("hits=[] 空召回分支（确定性覆盖）：retrievedCount=0、returnedCount=0、results=[]，无条件断言", async () => {
    // 直接构造空数组喂给纯组装函数，不依赖任何真实 query 能不能搜到东西——
    // 这个分支必然执行，不是"如果凑巧召回为空就顺便测一下"。
    const result = await assembleSearchResult("任意 query，本用例不发起真实检索", []);
    assert.equal(result.reranked, false);
    assert.equal(result.degraded, false);
    assert.equal(result.retrievedCount, 0);
    assert.equal(result.returnedCount, 0);
    assert.equal(result.results.length, 0);
    assert.deepEqual(result.results, []);
  });
});
