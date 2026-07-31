/**
 * customerServiceChatRoute / customerServiceStreamRoute 的响应组装 —— 真实路径级测试。
 *
 * 背景（Stop hook CR 反馈）：contract.test.ts 里"调用 buildContractExtras() 两次
 * 再比较"的用例只证明该函数本身是确定性纯函数，不能作为 chat 与 stream 两条真实
 * HTTP/SSE 路径产出一致结果的证据——两次调用的是同一个函数、同一份输入，任何纯
 * 函数都会通过。这里改为对真实导出的两个 registerApiRoute() 对象发起真实请求。
 *
 * 做法：
 *   1. 用 node:test 的 mock.module() 替换 "../orchestration.ts" 的
 *      runAgentTurn/streamAgentTurn——只在测试进程里拦截 import，不修改
 *      orchestration.ts 源码一个字节（Stop hook 明确禁止改它）。
 *   2. 把真实的 customerServiceChatRoute/customerServiceStreamRoute（未做任何
 *      测试专用改动，就是 routes/customer-service.ts 里那两个导出）挂进一个
 *      全新的 Hono app。
 *   3. 用 app.request() 发起真实的 fetch Request/Response 往返（Hono 在内存里
 *      构造真实 Context，streamSSE() 正常工作，不是伪造的 c 对象）。
 *   4. 断言两条路径的响应体（chat 的 JSON body / stream 的 SSE done 事件）都
 *      带着与注入的工具结果一致的 retrievedCount/returnedCount。
 *
 * 不需要 Mastra Server（:4111）、FastAPI（:8000）、llama-server（:8002）在线——
 * orchestration 层被完全替身，这是路由组装层面的测试，不是端到端测试
 * （端到端覆盖仍然是 agent.e2e.test.ts 的职责）。
 *
 * 运行（node:test 的模块级 mock 是实验特性，需要显式开启）：
 *   npm run route:test
 * 或：
 *   node --experimental-test-module-mocks --env-file-if-exists=../../.env \
 *     --import tsx --test src/mastra/routes/customer-service.route-assembly.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { ToolCallRecord } from "../orchestration.ts";

const FAKE_KB_RESULT = {
  reranked: true,
  degraded: false,
  retrievedCount: 13,
  returnedCount: 4,
  results: [] as unknown[],
};

function fakeToolCalls(): ToolCallRecord[] {
  return [{ name: "searchKnowledgeBase", arguments: { query: "test" }, result: FAKE_KB_RESULT }];
}

// 必须在 import "./customer-service.ts"（它静态 import 了 orchestration.ts）之前完成 mock 注册，
// 否则拦截不到——ESM 静态 import 在模块顶层就已经解析绑定。specifier 用与
// customer-service.ts 完全相同的相对路径（本文件与它同在 routes/ 目录下），
// 保证两边解析到同一个绝对模块。
mock.module("../orchestration.ts", {
  namedExports: {
    runAgentTurn: async (_message: string, _history: unknown) => ({
      reply: "chat 路径的测试回复",
      route: "repair",
      toolCalls: fakeToolCalls(),
    }),
    streamAgentTurn: async (
      _message: string,
      _history: unknown,
      handlers: {
        onToolResult: (call: ToolCallRecord) => Promise<void>;
        onTextDelta: (delta: string) => Promise<void>;
      },
    ) => {
      for (const call of fakeToolCalls()) {
        await handlers.onToolResult(call);
      }
      await handlers.onTextDelta("stream 路径的测试回复");
      return {
        reply: "stream 路径的测试回复",
        route: "repair",
        toolCalls: fakeToolCalls(),
      };
    },
  },
});

const { Hono } = await import("hono");
const { customerServiceChatRoute, customerServiceStreamRoute } = await import("./customer-service.ts");

// ApiRoute 是联合类型（handler 版 | createHandler 版）；这两个 route 在源文件里
// 用的都是 handler 形式（见 routes/customer-service.ts），运行时断言收窄一次即可，
// 不代表放松了别处的类型检查。
function requireHandler(route: typeof customerServiceChatRoute | typeof customerServiceStreamRoute) {
  if (!("handler" in route) || typeof route.handler !== "function") {
    throw new Error(`route ${route.path} 没有 handler（可能被改成了 createHandler 形式），测试需要同步更新`);
  }
  return route.handler;
}

function buildApp() {
  // 两个 route 在源文件里都声明为 POST（见 routes/customer-service.ts），
  // 用 .post() 而不是泛型的 .on(method, ...) 避开 Hono 复杂重载集合在
  // "method 取自变量而非字面量"时的类型推断噪音——运行时行为完全一致。
  assert.equal(customerServiceChatRoute.method, "POST");
  assert.equal(customerServiceStreamRoute.method, "POST");
  const app = new Hono();
  // @mastra/core 内部打包的一份 Hono 类型快照与顶层 node_modules/hono 在结构类型上
  // 对不上号（同样的问题 routes/customer-service.ts 顶部注释已经记录过一次，见
  // streamSSE(c as any, ...) 那处）——运行时是同一个 hono 模块实例，纯粹类型层面
  // 摩擦，这里按需断言，不代表放松了别处的类型检查。
  app.post(customerServiceChatRoute.path, requireHandler(customerServiceChatRoute) as any);
  app.post(customerServiceStreamRoute.path, requireHandler(customerServiceStreamRoute) as any);
  return app;
}

function extractDoneEventData(sseText: string): any {
  const chunk = sseText
    .split("\n\n")
    .find((c) => c.split("\n").some((line) => line.trim() === "event: done"));
  assert.ok(chunk, `必须收到 done 事件，实际收到：${sseText}`);
  const dataLine = chunk!.split("\n").find((l) => l.startsWith("data:"));
  assert.ok(dataLine, "done 事件必须带 data 行");
  return JSON.parse(dataLine!.slice("data:".length).trim());
}

describe("customerServiceChatRoute / customerServiceStreamRoute — 真实路径级响应组装（AC-005）", () => {
  it("POST /customer-service/chat：响应体的 retrievedCount/returnedCount 来自真实工具结果", async () => {
    const app = buildApp();
    const res = await app.request("/customer-service/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "冰箱不制冷" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.retrievedCount, 13);
    assert.equal(body.returnedCount, 4);
    assert.equal(body.route, "repair");
  });

  it("POST /customer-service/stream：SSE done 事件的 retrievedCount/returnedCount 与 chat 一致", async () => {
    const app = buildApp();
    const res = await app.request("/customer-service/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "冰箱不制冷" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const doneBody = extractDoneEventData(text);
    assert.equal(doneBody.retrievedCount, 13);
    assert.equal(doneBody.returnedCount, 4);
    assert.equal(doneBody.route, "repair");
  });

  it("chat 与 stream 两条真实路径对同一份工具结果返回完全一致的计数（AC-005 的真实证据，非伪测试）", async () => {
    const app = buildApp();

    const chatRes = await app.request("/customer-service/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "显示器无信号" }),
    });
    const chatBody = (await chatRes.json()) as any;

    const streamRes = await app.request("/customer-service/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "显示器无信号" }),
    });
    const streamBody = extractDoneEventData(await streamRes.text());

    assert.equal(chatBody.retrievedCount, streamBody.retrievedCount);
    assert.equal(chatBody.returnedCount, streamBody.returnedCount);
    assert.equal(chatBody.retrievedCount, 13);
    assert.equal(chatBody.returnedCount, 4);
  });
});
