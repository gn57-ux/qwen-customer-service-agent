/**
 * customerServiceStatusRoute 的真实路径级测试——手法与
 * customer-service.route-assembly.test.ts 一致（见该文件与
 * frontend-workbench/specs/memory/real-route-testing-with-module-mock.md）：
 * 用 node:test 的 mock.module() 替身 "../health/probes.ts" 的
 * collectServiceStatus()（不改生产源码），把真实导出的
 * customerServiceStatusRoute 挂进一个全新 Hono app，用 app.request() 发起
 * 真实请求。
 *
 * 覆盖：
 *   - AC-001：200 + 三字段结构体，字段值均为四态之一
 *   - AC-009：下游全部不可用（collectServiceStatus 返回三个 "error"）时仍是 200，
 *     不是 5xx——这里直接验证 route handler 对 collectServiceStatus() 返回值的
 *     包装行为；collectServiceStatus() 自身"探测异常不冒泡为 reject"的保证见
 *     probes.test.ts 对 probe() 的测试（所有具体探测器都经过同一个包装器）。
 *   - AC-006 脱敏（路由级复核）：响应体全文不含 URL/端口号/IP/主机名/堆栈关键字。
 *
 * 运行：npm run agent:test:unit（已含 --experimental-test-module-mocks）。
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { ServiceStatusBody } from "../contract.ts";

const ALL_ERROR: ServiceStatusBody = { localModel: "error", knowledgeBase: "error", orderService: "error" };
const ALL_ONLINE: ServiceStatusBody = { localModel: "online", knowledgeBase: "online", orderService: "online" };
const MIXED: ServiceStatusBody = { localModel: "online", knowledgeBase: "degraded", orderService: "error" };

let nextResponse: ServiceStatusBody = ALL_ONLINE;

// 必须在 import "./customer-service.ts" 之前完成 mock 注册（同目录下用完全相同的
// 相对路径字符串，保证解析到与生产 route 文件相同的绝对模块）。
mock.module("../health/probes.ts", {
  namedExports: {
    collectServiceStatus: async () => nextResponse,
  },
});

const { Hono } = await import("hono");
const { customerServiceStatusRoute } = await import("./customer-service.ts");

function requireHandler(route: typeof customerServiceStatusRoute) {
  if (!("handler" in route) || typeof route.handler !== "function") {
    throw new Error(`route ${route.path} 没有 handler，测试需要同步更新`);
  }
  return route.handler;
}

function buildApp() {
  assert.equal(customerServiceStatusRoute.method, "GET");
  const app = new Hono();
  // @mastra/core 内部打包的 Hono 类型与顶层 node_modules/hono 结构对不上号（纯类型
  // 层面摩擦，同一问题在 routes/customer-service.ts 与 route-assembly 测试里都有
  // 记录），这里按需断言。
  app.get(customerServiceStatusRoute.path, requireHandler(customerServiceStatusRoute) as any);
  return app;
}

const VALID_STATES = ["unknown", "online", "degraded", "error"];

describe("customerServiceStatusRoute — GET /customer-service/status（真实路径级）", () => {
  it("AC-001：全部在线时返回 200 + 三字段，均为合法四态", async () => {
    nextResponse = ALL_ONLINE;
    const app = buildApp();
    const res = await app.request("/customer-service/status", { method: "GET" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as ServiceStatusBody;
    assert.ok(VALID_STATES.includes(body.localModel));
    assert.ok(VALID_STATES.includes(body.knowledgeBase));
    assert.ok(VALID_STATES.includes(body.orderService));
    assert.deepEqual(body, ALL_ONLINE);
  });

  it("AC-009：下游全部不可用时仍返回 200（不是 5xx），三字段均为 error", async () => {
    nextResponse = ALL_ERROR;
    const app = buildApp();
    const res = await app.request("/customer-service/status", { method: "GET" });
    assert.equal(res.status, 200, "下游全挂是正常业务结果，不应表现为接口错误");
    const body = (await res.json()) as ServiceStatusBody;
    assert.deepEqual(body, ALL_ERROR);
  });

  it("混合状态（在线/降级/异常并存）时仍是 200，字段各自独立反映", async () => {
    nextResponse = MIXED;
    const app = buildApp();
    const res = await app.request("/customer-service/status", { method: "GET" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as ServiceStatusBody;
    assert.deepEqual(body, MIXED);
  });

  it("AC-006 脱敏复核：响应体全文不含 URL / 端口号 / IP / 主机名 / 堆栈关键字", async () => {
    nextResponse = ALL_ERROR;
    const app = buildApp();
    const res = await app.request("/customer-service/status", { method: "GET" });
    const text = await res.text();
    assert.doesNotMatch(text, /https?:\/\//i);
    assert.doesNotMatch(text, /:(8000|8001|8002|6333|8787|11434)\b/);
    assert.doesNotMatch(text, /\b(\d{1,3}\.){3}\d{1,3}\b/, "不应包含 IPv4 地址");
    assert.doesNotMatch(text, /localhost|127\.0\.0\.1/i);
    assert.doesNotMatch(text, /at\s+\S+\s+\(.*:\d+:\d+\)/, "不应包含类似堆栈帧的内容");
    // 响应体只应包含契约里的三个键
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["knowledgeBase", "localModel", "orderService"]);
  });
});
