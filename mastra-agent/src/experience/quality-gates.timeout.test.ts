/**
 * 用户 22 项清单第 17 项：Hook 超时验证（F-002）。
 *
 * 验证现有超时配置确实生效，不是新增超时逻辑——复用 `rag/rerank.ts`
 * 已有的 `AbortSignal.timeout()` 机制，用一个故意慢响应的假 HTTP
 * server（Node 内置 `http.createServer`，不引入新依赖）替换
 * Reranker 的 `baseUrl`，把 `requestTimeoutMs`/`healthTimeoutMs`
 * 调小（如 200ms），验证超时错误按预期时间抛出（转换成
 * `status: "unavailable"`，不是真的等待生产环境的 60s/3s 超时时长）。
 *
 * `rag/embedding.ts` 的 `REQUEST_TIMEOUT_MS` 是模块内硬编码的 120_000
 * 常量，不通过 `RagConfig`/环境变量暴露，无法在不修改该文件的前提下
 * 缩短——真的等 120s 验证不现实，也违反"不依赖长时间真实 sleep"的
 * 测试约定；`node:test` 的 `mock.timers` 经过实测确认不会影响
 * `AbortSignal.timeout()`（它不是基于 `setTimeout` 实现，Node 内部用
 * 独立的定时器句柄）。两处用的是**同一个** `AbortSignal.timeout()`
 * 机制，只是常量大小不同——这里用 Reranker 一侧做代表性验证，
 * Embedding 一侧按代码走查确认调用方式一致（`embedding.ts:44`），
 * 不重复引入一份等价但要跑 2 分钟的测试。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { LlamaCppReranker, type RerankerConfig } from "../rag/rerank.ts";

let slowServer: Server;
let slowServerPort: number;

before(async () => {
  slowServer = createServer((req, res) => {
    // 故意不响应，模拟服务挂起——只有客户端主动超时才会结束这次请求。
    // 保留 req 引用避免 TS 认为未使用；不需要读取请求体。
    void req;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    }, 5000);
  });
  await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
  const address = slowServer.address();
  if (typeof address !== "object" || address === null) throw new Error("无法获取测试服务器端口");
  slowServerPort = address.port;
});

after(async () => {
  await new Promise<void>((resolve) => slowServer.close(() => resolve()));
});

function cfgWithSlowServer(overrides: Partial<RerankerConfig> = {}): RerankerConfig {
  return {
    enabled: true,
    baseUrl: `http://127.0.0.1:${slowServerPort}`,
    requestTimeoutMs: 200,
    healthTimeoutMs: 200,
    ...overrides,
  };
}

describe("AC（用户清单第 17 项）：Reranker 超时机制真实生效，不无限阻塞", () => {
  it("rerank() 面对挂起的服务，在 requestTimeoutMs 附近超时，返回 status: unavailable 而不是永远等待", async () => {
    const reranker = new LlamaCppReranker(cfgWithSlowServer());
    const start = Date.now();

    const result = await reranker.rerank("测试查询", [{ id: "doc-1", text: "测试文档" }], 5);

    const elapsed = Date.now() - start;
    assert.equal(result.status, "unavailable");
    assert.ok(result.reason && /请求失败/.test(result.reason));
    assert.ok(elapsed < 2000, `应该在远小于服务实际响应时间（5000ms）的时间内超时，实际耗时 ${elapsed}ms`);
    assert.ok(elapsed >= 150, `不应该提前于 requestTimeoutMs（200ms）就返回，实际耗时 ${elapsed}ms`);
  });

  it("health() 面对挂起的服务，在 healthTimeoutMs 附近超时，返回 available: false 而不是永远等待", async () => {
    const reranker = new LlamaCppReranker(cfgWithSlowServer());
    const start = Date.now();

    const health = await reranker.health();

    const elapsed = Date.now() - start;
    assert.equal(health.available, false);
    assert.ok(elapsed < 2000, `应该在远小于服务实际响应时间（5000ms）的时间内超时，实际耗时 ${elapsed}ms`);
  });

  it("正常响应速度的服务不受超时机制误伤（对照组，避免超时阈值设置得太激进）", async () => {
    const fastServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }));
    });
    await new Promise<void>((resolve) => fastServer.listen(0, "127.0.0.1", resolve));
    const address = fastServer.address();
    if (typeof address !== "object" || address === null) throw new Error("无法获取测试服务器端口");

    try {
      const reranker = new LlamaCppReranker(
        cfgWithSlowServer({ baseUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 2000 }),
      );
      const result = await reranker.rerank("测试查询", [{ id: "doc-1", text: "测试文档" }], 5);
      assert.equal(result.status, "ok");
    } finally {
      await new Promise<void>((resolve) => fastServer.close(() => resolve()));
    }
  });
});
