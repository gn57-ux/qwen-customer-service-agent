/**
 * Reranker 单元测试与固定验收。
 *
 *   npm run rerank:test
 *
 * 需要：Qdrant 在线、Ollama（bge-m3）在线、Reranker 服务在线（npm run rerank:up）。
 * 全程只读正式 Collection，不写入、不修改。
 *
 * 覆盖：
 *   1. /v1/rerank 对一 query + 多 documents 返回有效 index 与 score
 *   2. 输入 Top20，输出 Top5
 *   3. 返回索引正确映射回原始文档，不错位/重复/越界（含异常响应的防御）
 *   4. 冰箱"冒烟、焦味" → 紧急安全分流/立即停止使用 升到 Top1
 *   5. 显示器 USB-C 充电无画面 → USB-C/无信号章节优先于通用客服模板
 *   6. 显示器无信号 → monitor 文档排在 television 相似章节之前
 *   7. 普通冰箱、彩电查询不因 Rerank 明显退化
 *   8. Reranker 不可用 → unavailable，不伪装成功
 *   9. RERANK_ENABLED=false → disabled
 *  10. score 必须有限（NaN/Infinity/-Infinity 判 unavailable）；非法 topK 不得伪成功
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "./config.ts";
import { createEmbeddingClient, type EmbeddingClient } from "./embedding.ts";
import {
  LlamaCppReranker,
  loadRerankerConfig,
  type RerankDocument,
  type RerankerConfig,
} from "./rerank.ts";
import { QdrantKnowledgeStore, type StoreHit } from "./store.ts";

const RECALL_TOP_N = 20;
const FINAL_TOP_K = 5;

let embedder: EmbeddingClient;
let store: QdrantKnowledgeStore;
let liveCfg: RerankerConfig;

function cfgWith(overrides: Partial<RerankerConfig>): RerankerConfig {
  return { ...loadRerankerConfig(), ...overrides };
}

function payloadStr(hit: StoreHit, key: string): string {
  const v = hit.payload[key];
  return typeof v === "string" ? v : String(v ?? "");
}

/** 向量召回 Top20 */
async function recall(question: string): Promise<StoreHit[]> {
  const [vector] = await embedder.embed([question]);
  return store.query(vector!, RECALL_TOP_N);
}

function toDocs(hits: StoreHit[]): RerankDocument[] {
  return hits.map((h) => ({ id: h.id, text: payloadStr(h, "text") }));
}

/** 返回 section 在 rerank 结果里的名次（1 起），未进入结果则返回 null */
function rankOfSection(
  ranked: Array<{ id: string }>,
  hits: StoreHit[],
  match: (section: string, sourceFile: string) => boolean,
): number | null {
  const byId = new Map(hits.map((h) => [h.id, h]));
  for (const [i, item] of ranked.entries()) {
    const hit = byId.get(item.id);
    if (!hit) continue;
    if (match(payloadStr(hit, "section"), payloadStr(hit, "source_file"))) return i + 1;
  }
  return null;
}

before(async () => {
  const cfg = loadConfig();
  embedder = await createEmbeddingClient(cfg);
  store = new QdrantKnowledgeStore(cfg);
  liveCfg = cfgWith({ enabled: true });

  const health = await new LlamaCppReranker(liveCfg).health();
  assert.ok(
    health.available,
    `Reranker 服务不可用，无法执行验收：${health.detail}\n请先运行 npm run rerank:up`,
  );
});

// ---------------------------------------------------------------------------

describe("1. /v1/rerank 返回有效 index 与 score", () => {
  it("对一条 query 和多个 documents 返回结构合法的结果", async () => {
    const reranker = new LlamaCppReranker(liveCfg);
    const docs: RerankDocument[] = [
      { id: "d0", text: "冰箱制冷不足时应先确认温度设置、门封与散热空间。" },
      { id: "d1", text: "显示器提示无信号时应确认输入源与视频线连接。" },
      { id: "d2", text: "彩电遥控器无反应时应先更换电池并检查发射头。" },
    ];
    const result = await reranker.rerank("冰箱不制冷怎么排查", docs, 3);

    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");
    assert.equal(result.candidateCount, 3);
    assert.ok(result.elapsedMs !== null && result.elapsedMs >= 0);
    assert.equal(result.ranked.length, 3);
    for (const item of result.ranked) {
      assert.ok(["d0", "d1", "d2"].includes(item.id), `返回了未知 id：${item.id}`);
      assert.equal(typeof item.rerankScore, "number");
      assert.ok(!Number.isNaN(item.rerankScore!));
    }
    // 分数必须降序
    const scores = result.ranked.map((r) => r.rerankScore!);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "结果必须按 rerankScore 降序");
    // 与冰箱相关的文档应排在最前
    assert.equal(result.ranked[0]!.id, "d0", "与 query 最相关的文档应排第一");
  });
});

describe("2. 输入 Top20，输出 Top5", () => {
  it("召回 20 条送进 Reranker，返回恰好 5 条", async () => {
    const hits = await recall("冰箱不制冷应该先检查什么");
    assert.equal(hits.length, RECALL_TOP_N, `向量召回应为 ${RECALL_TOP_N} 条`);

    const result = await new LlamaCppReranker(liveCfg).rerank(
      "冰箱不制冷应该先检查什么",
      toDocs(hits),
      FINAL_TOP_K,
    );
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");
    assert.equal(result.candidateCount, RECALL_TOP_N, "全部 20 条都应送进 Reranker");
    assert.equal(result.ranked.length, FINAL_TOP_K, `应截断为 Top${FINAL_TOP_K}`);
    assert.deepEqual(
      result.ranked.map((r) => r.rerankRank),
      [1, 2, 3, 4, 5],
      "rerankRank 应为 1..5",
    );
  });
});

describe("3. 索引映射正确，不错位/重复/越界", () => {
  it("返回的 id 全部来自入参且互不重复", async () => {
    const hits = await recall("显示器提示无信号怎么排查");
    const docs = toDocs(hits);
    const inputIds = new Set(docs.map((d) => d.id));

    const result = await new LlamaCppReranker(liveCfg).rerank(
      "显示器提示无信号怎么排查",
      docs,
      FINAL_TOP_K,
    );
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");

    const seen = new Set<string>();
    for (const item of result.ranked) {
      assert.ok(inputIds.has(item.id), `返回了不在入参中的 id：${item.id}`);
      assert.ok(!seen.has(item.id), `返回了重复 id：${item.id}`);
      seen.add(item.id);
    }
  });

  it("服务返回越界 index 时判为 unavailable，不将错就错", async () => {
    const { server, cfg } = await fakeReranker({ results: [{ index: 99, relevance_score: 0.9 }] });
    try {
      const result = await new LlamaCppReranker(cfg).rerank(
        "q",
        [{ id: "a", text: "x" }],
        1,
      );
      assert.equal(result.status, "unavailable");
      assert.match(result.reason ?? "", /越界/);
      assert.equal(result.ranked.length, 0);
    } finally {
      server.close();
    }
  });

  it("服务返回重复 index 时判为 unavailable", async () => {
    const { server, cfg } = await fakeReranker({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    });
    try {
      const result = await new LlamaCppReranker(cfg).rerank(
        "q",
        [{ id: "a", text: "x" }, { id: "b", text: "y" }],
        2,
      );
      assert.equal(result.status, "unavailable");
      assert.match(result.reason ?? "", /重复/);
    } finally {
      server.close();
    }
  });

  it("服务返回非法 score 时判为 unavailable", async () => {
    const { server, cfg } = await fakeReranker({ results: [{ index: 0, relevance_score: null }] });
    try {
      const result = await new LlamaCppReranker(cfg).rerank("q", [{ id: "a", text: "x" }], 1);
      assert.equal(result.status, "unavailable");
      assert.match(result.reason ?? "", /relevance_score/);
    } finally {
      server.close();
    }
  });

  // score 必须是**有限数**：NaN / Infinity / -Infinity 都不能用于排序
  for (const [label, raw] of [
    ["NaN", "NaN"],
    ["Infinity", "1e999"],
    ["-Infinity", "-1e999"],
  ] as const) {
    it(`服务返回 ${label} score 时判为 unavailable`, async () => {
      // JSON 里没有 NaN/Infinity 字面量，用超大数值让 JSON.parse 产生 ±Infinity；
      // NaN 用裸字面量，由假服务直接吐出非标准 JSON。
      const body =
        label === "NaN"
          ? '{"results":[{"index":0,"relevance_score":NaN}]}'
          : `{"results":[{"index":0,"relevance_score":${raw}}]}`;
      const { server, cfg } = await fakeRerankerRaw(body);
      try {
        const result = await new LlamaCppReranker(cfg).rerank("q", [{ id: "a", text: "x" }], 1);
        assert.equal(result.status, "unavailable", `${label} 必须判 unavailable`);
        assert.equal(result.ranked.length, 0);
      } finally {
        server.close();
      }
    });
  }

  it("Infinity 与有限分数混合时也整体判为 unavailable", async () => {
    const { server, cfg } = await fakeRerankerRaw(
      '{"results":[{"index":0,"relevance_score":0.9},{"index":1,"relevance_score":1e999}]}',
    );
    try {
      const result = await new LlamaCppReranker(cfg).rerank(
        "q",
        [{ id: "a", text: "x" }, { id: "b", text: "y" }],
        2,
      );
      assert.equal(result.status, "unavailable");
      assert.match(result.reason ?? "", /relevance_score/);
      assert.equal(result.ranked.length, 0, "不得只返回合法的那一条");
    } finally {
      server.close();
    }
  });

  it("index 与文档顺序对应：打乱顺序后 id 映射仍正确", async () => {
    const docs: RerankDocument[] = [
      { id: "monitor", text: "显示器提示无信号时应确认输入源与视频线。" },
      { id: "fridge", text: "冰箱制冷不足应确认温度设置与门封。" },
      { id: "tv", text: "彩电遥控器无反应应先换电池。" },
    ];
    const result = await new LlamaCppReranker(liveCfg).rerank("显示器无信号", docs, 3);
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");
    assert.equal(result.ranked[0]!.id, "monitor", "id 映射错位会导致这里失败");
  });
});

describe("4. 安全查询：紧急安全分流应升到 Top1", () => {
  it("冰箱冒烟焦味 → 紧急安全分流/立即停止使用 排第 1", async () => {
    const question = "冰箱冒烟还有焦味能继续用吗";
    const hits = await recall(question);
    const vectorRank = rankOfSection(
      hits.map((h) => ({ id: h.id })),
      hits,
      (section) => section.includes("紧急安全分流"),
    );

    const result = await new LlamaCppReranker(liveCfg).rerank(question, toDocs(hits), FINAL_TOP_K);
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");
    const rerankRank = rankOfSection(result.ranked, hits, (s) => s.includes("紧急安全分流"));

    console.log(`      安全章节：向量名次 v${vectorRank} → Rerank 名次 r${rerankRank}`);
    assert.equal(rerankRank, 1, `紧急安全分流应升到 Top1，实际 r${rerankRank}`);
  });
});

describe("5. 显示器 USB-C：USB-C 章节优先于通用客服模板", () => {
  it("USB-C 能充电但无画面 → USB-C/无信号章节排在客服回答模板之前", async () => {
    const question = "显示器USB-C能充电但没有画面";
    const hits = await recall(question);
    const result = await new LlamaCppReranker(liveCfg).rerank(question, toDocs(hits), FINAL_TOP_K);
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");

    const usbcRank = rankOfSection(result.ranked, hits, (s) => s.includes("USB-C"));
    const templateRank = rankOfSection(result.ranked, hits, (s) => s.includes("客服回答模板"));

    console.log(`      USB-C 章节 r${usbcRank} / 客服模板 r${templateRank}`);
    assert.ok(usbcRank !== null, "USB-C 章节应进入 Top5");
    if (templateRank !== null) {
      assert.ok(
        usbcRank < templateRank,
        `USB-C 章节(r${usbcRank}) 应优先于客服模板(r${templateRank})`,
      );
    }
  });
});

describe("6. 显示器无信号：monitor 应优先于 television", () => {
  it("monitor 文档排在 television 相似章节之前", async () => {
    const question = "显示器提示无信号怎么排查";
    const hits = await recall(question);
    const result = await new LlamaCppReranker(liveCfg).rerank(question, toDocs(hits), FINAL_TOP_K);
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");

    const byId = new Map(hits.map((h) => [h.id, h]));
    const domains = result.ranked.map((r) => payloadStr(byId.get(r.id)!, "domain"));
    const firstMonitor = domains.indexOf("monitor");
    const firstTelevision = domains.indexOf("television");

    console.log(`      Rerank Top5 domain 顺序：${domains.join(" > ")}`);
    assert.ok(firstMonitor >= 0, "monitor 内容应进入 Top5");
    assert.equal(firstMonitor, 0, "Top1 应为 monitor");
    if (firstTelevision >= 0) {
      assert.ok(firstMonitor < firstTelevision, "monitor 应排在 television 之前");
    }
  });
});

describe("7. 普通查询不因 Rerank 退化", () => {
  for (const [question, expectedDomain] of [
    ["冰箱不制冷应该先检查什么", "refrigerator"],
    ["电视有声音没有画面怎么办", "television"],
  ] as const) {
    it(`「${question}」Top1 domain 仍为 ${expectedDomain}`, async () => {
      const hits = await recall(question);
      const result = await new LlamaCppReranker(liveCfg).rerank(question, toDocs(hits), FINAL_TOP_K);
      assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");

      const byId = new Map(hits.map((h) => [h.id, h]));
      const topDomain = payloadStr(byId.get(result.ranked[0]!.id)!, "domain");
      assert.equal(topDomain, expectedDomain, `Rerank 后 Top1 domain 退化为 ${topDomain}`);
    });
  }
});

describe("8. Reranker 不可用 → unavailable", () => {
  it("服务地址不可达时返回 unavailable，rerankScore 为空，不伪装成功", async () => {
    // 指向一个确定没有服务在监听的本地端口
    const cfg = cfgWith({ enabled: true, baseUrl: "http://127.0.0.1:59999", requestTimeoutMs: 3000 });
    const reranker = new LlamaCppReranker(cfg);

    const health = await reranker.health();
    assert.equal(health.available, false);

    const result = await reranker.rerank("冰箱不制冷", [{ id: "a", text: "冰箱排查" }], 5);
    assert.equal(result.status, "unavailable");
    assert.equal(result.ranked.length, 0, "不可用时不得返回任何排序结果");
    assert.ok((result.reason ?? "").length > 0, "必须给出原因");
    // 错误信息不应泄露无关环境信息
    assert.ok(!/[A-Z_]{4,}=/.test(result.reason ?? ""), "错误信息不应包含环境变量赋值");
  });

  it("服务返回 HTTP 500 时同样判为 unavailable", async () => {
    const { server, cfg } = await fakeReranker(null, 500);
    try {
      const result = await new LlamaCppReranker(cfg).rerank("q", [{ id: "a", text: "x" }], 1);
      assert.equal(result.status, "unavailable");
      assert.match(result.reason ?? "", /HTTP 500/);
    } finally {
      server.close();
    }
  });
});

describe("9. RERANK_ENABLED=false → disabled", () => {
  it("显式关闭时状态为 disabled 且不发起请求", async () => {
    const cfg = cfgWith({ enabled: false });
    const reranker = new LlamaCppReranker(cfg);

    const health = await reranker.health();
    assert.equal(health.available, false);
    assert.match(health.detail, /RERANK_ENABLED=false/);

    const result = await reranker.rerank("冰箱不制冷", [{ id: "a", text: "冰箱排查" }], 5);
    assert.equal(result.status, "disabled");
    assert.equal(result.ranked.length, 0);
    assert.equal(result.elapsedMs, null, "未执行时耗时应为 null");
    assert.match(result.reason ?? "", /未执行 Rerank/);
  });
});

describe("10. 非法 topK 不得产生伪成功", () => {
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY] as const) {
    it(`topK=${String(bad)} 判为 unavailable`, async () => {
      const result = await new LlamaCppReranker(liveCfg).rerank(
        "冰箱不制冷",
        [{ id: "a", text: "冰箱排查" }],
        bad,
      );
      assert.equal(result.status, "unavailable", `topK=${String(bad)} 不应成功`);
      assert.equal(result.ranked.length, 0);
      assert.match(result.reason ?? "", /topK 非法/);
      assert.equal(result.elapsedMs, null, "非法 topK 不应发起请求");
    });
  }

  it("合法 topK 仍正常工作", async () => {
    const result = await new LlamaCppReranker(liveCfg).rerank(
      "冰箱不制冷",
      [{ id: "a", text: "冰箱制冷排查" }, { id: "b", text: "显示器无信号" }],
      1,
    );
    assert.equal(result.status, "ok", result.reason ?? "rerank 未成功");
    assert.equal(result.ranked.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 假 Reranker 服务：用于覆盖异常响应分支，不依赖真实服务
// ---------------------------------------------------------------------------
/** 直接返回原始响应体，用于构造 NaN / Infinity 这类非标准 JSON */
async function fakeRerankerRaw(
  raw: string,
  status = 200,
): Promise<{ server: Server; cfg: RerankerConfig }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(raw);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    cfg: cfgWith({ enabled: true, baseUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 5000 }),
  };
}

async function fakeReranker(
  body: unknown,
  status = 200,
): Promise<{ server: Server; cfg: RerankerConfig }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === null ? "{}" : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    cfg: cfgWith({ enabled: true, baseUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 5000 }),
  };
}

after(() => {
  // 假服务在各用例内已 close，这里不做额外清理
});
