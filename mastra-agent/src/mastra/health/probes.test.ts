/**
 * health/probes.ts 单元测试：纯函数/通用包装器，不依赖任何真实服务。
 *
 *   npm run agent:test:unit
 *
 * 覆盖 §2.service-status-endpoint 的验收标准：
 *   - AC-002~004：aggregateKnowledgeBase() 三分支聚合语义
 *   - AC-005：某下游挂起（check() 永不 resolve）时，probe() 仍在 timeoutMs 内返回
 *   - AC-006：探测失败时返回值只含 { ok: boolean }，异常细节不可能出现在返回值里
 *     （类型层面即不允许，这里额外用运行时断言复核）
 *   - AC-009 的机制来源：probe() 异常永不外抛，因此下游全部失败时
 *     collectServiceStatus() 依然能正常返回（而不是 reject），路由级验证见
 *     ./customer-service.status-route.test.ts
 *
 * 所有五个真实探测函数（probeQdrant/probeEmbedding/probeLlamaServer/
 * probeReranker/probeOrderService）都经过同一个 probe() 包装器，因此这里对
 * probe() 本身的测试，等价于对"任一下游挂起/异常不得影响整体响应"这条硬性
 * 要求的通用证明——不需要针对每个具体探测器分别搭建挂起/异常场景。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateKnowledgeBase, matchesModelName, parseFastApiHealthStatus, probe, type ProbeResult } from "./probes.ts";

describe("probe() — 统一探测包装器", () => {
  it("check() 正常返回 true → { ok: true }", async () => {
    const result = await probe("test-ok", async () => true, 50);
    assert.deepEqual(result, { ok: true });
  });

  it("check() 正常返回 false → { ok: false }", async () => {
    const result = await probe("test-false", async () => false, 50);
    assert.deepEqual(result, { ok: false });
  });

  it("AC-005 check() 永不 resolve（模拟下游挂起）→ probe() 仍在 timeoutMs 内返回 { ok: false }", async () => {
    const started = Date.now();
    const hung = () => new Promise<boolean>(() => {}); // 永不 resolve/reject
    const result = await probe("test-hang", hung, 50);
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { ok: false });
    assert.ok(elapsed < 500, `应在 timeoutMs(50ms) 附近返回，实际耗时 ${elapsed}ms`);
  });

  it("AC-006 check() 抛出带敏感信息的异常 → 返回值只含 { ok: false }，不含异常细节", async () => {
    const sensitiveDetail = "无法连接 http://127.0.0.1:6333/collections/customer_service_knowledge：ECONNREFUSED";
    const result = await probe(
      "test-throw",
      async () => {
        throw new Error(sensitiveDetail);
      },
      50,
    );
    assert.deepEqual(result, { ok: false });
    // 结构性证明：ProbeResult 类型只有 ok 一个字段，序列化后不可能包含异常细节
    const serialized = JSON.stringify(result);
    assert.equal(serialized, '{"ok":false}');
    assert.doesNotMatch(serialized, /6333|ECONNREFUSED|127\.0\.0\.1/);
  });

  it("check() 抛出非 Error 对象（如字符串）也能被归一为 { ok: false }，不抛出", async () => {
    const result = await probe(
      "test-throw-string",
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string thrown";
      },
      50,
    );
    assert.deepEqual(result, { ok: false });
  });
});

describe("aggregateKnowledgeBase() — 知识库三分支聚合语义", () => {
  const ok: ProbeResult = { ok: true };
  const down: ProbeResult = { ok: false };

  it("AC-002 三者均可用 → online", () => {
    assert.equal(aggregateKnowledgeBase(ok, ok, ok), "online");
  });

  it("AC-003 关键分支：仅 Reranker 不可用，Qdrant+Embedding 可用 → degraded", () => {
    assert.equal(aggregateKnowledgeBase(ok, ok, down), "degraded");
  });

  it("AC-004a Qdrant 不可用（Embedding 可用）→ error", () => {
    assert.equal(aggregateKnowledgeBase(down, ok, ok), "error");
  });

  it("AC-004b Embedding 不可用（Qdrant 可用）→ error", () => {
    assert.equal(aggregateKnowledgeBase(ok, down, ok), "error");
  });

  it("Qdrant 与 Embedding 都不可用（Reranker 也不可用）→ error（基础检索挂是致命的，与 Reranker 状态无关）", () => {
    assert.equal(aggregateKnowledgeBase(down, down, down), "error");
  });

  it("Qdrant 不可用但 Reranker 可用 → 仍是 error（基础检索优先于 Reranker 判定）", () => {
    assert.equal(aggregateKnowledgeBase(down, ok, ok), "error");
  });
});

describe("matchesModelName() — Ollama 带 tag 的模型名双向归一化匹配", () => {
  // 产品裁定（Stop hook CR 明确要求写清楚）：当前需求只是"确认配置的模型
  // 确实存在"，不校验具体 tag/版本是否一致——因此按 base name（`:` 前的部分）
  // 精确比较，id 与 target **两侧都要归一化**，tag 不同不影响匹配结果。
  // 如果未来产品要求 tag 必须严格一致，需要显式改掉这条裁定并更新本注释。

  it("实测回归：Ollama 返回带 tag 的 id（bge-m3:latest）匹配不带 tag 的配置（bge-m3）", () => {
    assert.equal(matchesModelName("bge-m3:latest", "bge-m3"), true);
  });

  it("双向归一化：id 与 target 都带相同 tag（bge-m3:latest / bge-m3:latest）也必须匹配（此前的 bug：只归一化 id 一侧会漏掉这种场景）", () => {
    assert.equal(matchesModelName("bge-m3:latest", "bge-m3:latest"), true);
  });

  it("反向：id 不带 tag，target 带 tag（bge-m3 / bge-m3:latest）也必须匹配", () => {
    assert.equal(matchesModelName("bge-m3", "bge-m3:latest"), true);
  });

  it("base name 相同但 tag 不同（bge-m3:v1 / bge-m3:v2）→ 按裁定应匹配（只确认模型存在，不比对具体 tag）", () => {
    assert.equal(matchesModelName("bge-m3:v1", "bge-m3:v2"), true);
  });

  it("id 与目标完全相同（都不带 tag）也匹配", () => {
    assert.equal(matchesModelName("bge-m3", "bge-m3"), true);
  });

  it("不做子串匹配：bge-m3-v2 不应误命中 bge-m3", () => {
    assert.equal(matchesModelName("bge-m3-v2:latest", "bge-m3"), false);
  });

  it("完全不相关的模型名不匹配", () => {
    assert.equal(matchesModelName("qwen3:8b", "bge-m3"), false);
  });

  it("非字符串 id（如 undefined）不匹配，不抛异常", () => {
    assert.equal(matchesModelName(undefined, "bge-m3"), false);
  });

  it("空字符串/纯空白 id 不匹配", () => {
    assert.equal(matchesModelName("", "bge-m3"), false);
    assert.equal(matchesModelName("   ", "bge-m3"), false);
  });
});

describe("parseFastApiHealthStatus() — FastAPI /health 响应判定（纯函数，不发起真实请求）", () => {
  it("HTTP 200 + {status:\"ok\"} → true", () => {
    assert.equal(parseFastApiHealthStatus(true, { status: "ok" }), true);
  });

  it("HTTP 200 + {status:\"degraded\"} → false（FastAPI 在 degraded 时依然返回 200，必须靠 body 判定）", () => {
    assert.equal(parseFastApiHealthStatus(true, { status: "degraded" }), false);
  });

  it("HTTP 200 + {status:\"not_loaded\"} → false", () => {
    assert.equal(parseFastApiHealthStatus(true, { status: "not_loaded" }), false);
  });

  it("HTTP 500（httpOk=false）→ false，即使传入的 body 里恰好有 status:\"ok\"（httpOk 优先短路）", () => {
    assert.equal(parseFastApiHealthStatus(false, { status: "ok" }), false);
  });

  it("body 为 null（如 HTTP 失败时没有解析响应体）→ false，不抛异常", () => {
    assert.equal(parseFastApiHealthStatus(false, null), false);
  });

  it("body 是意外形状（没有 status 字段）→ false", () => {
    assert.equal(parseFastApiHealthStatus(true, {}), false);
  });
});
