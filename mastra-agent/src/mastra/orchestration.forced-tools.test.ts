/**
 * repair/order 路由确定性工具执行的行为测试——不需要真实 Qdrant/Embedding/
 * Reranker/FastAPI/llama-server 在线（那是 agent.e2e.test.ts 的职责）。
 *
 * 用 node:test 的 mock.module() 替换：
 *   - "./tools/search-knowledge-base-tool.ts" 的 searchKnowledgeBaseTool
 *   - "./tools/query-order-tool.ts" 的 queryOrderTool
 *   - "./agents/customer-service-agent.ts" 的 customerServiceAgent
 * 只在测试进程里拦截 import，不修改 orchestration.ts 源码一个字节——
 * orchestration.ts 仍然调用真实导出对象的 .execute()/.generate()/.stream()，
 * 这里只是把这些依赖换成受控的桩，用来断言：
 *   1. repair/order 路由恰好调用一次对应工具，参数来自用户消息本身（不解析
 *      模型输出、不解析历史回复正文）；
 *   2. 工具的真实返回值原样进入 ToolCallRecord.result，供
 *      contract.ts 的 buildContractExtras() 使用（不经过 reply 文本）；
 *   3. 空召回 / Reranker 降级 / 工具异常三类分支的行为符合预期；
 *   4. chat（runAgentTurn）与 stream（streamAgentTurn）对同一输入产出一致
 *      的 toolCalls；
 *   5. 流式路径里 onToolResult 严格先于 onTextDelta 触发（对应 SSE 的
 *      tool-result → text-delta 事件顺序）；
 *   6. 工具返回的结果与合成阶段模型的自由文本互不影响——即使桩合成函数
 *      返回与工具结果毫不相关的文本，ToolCallRecord 仍然是工具的真实返回值，
 *      证明结构化字段不是从 reply 正文解析出来的；
 *   7. safety 路由不会触发 searchKnowledgeBaseTool（安全场景优先，不因维修
 *      关键词误检索）。
 *
 * 运行（node:test 的模块级 mock 是实验特性，需要显式开启，已纳入
 * npm run agent:test:unit）：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/mastra/orchestration.forced-tools.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

const searchExecuteMock = mock.fn(async (_input: { query: string }, _ctx: unknown) => ({
  reranked: true,
  degraded: false,
  retrievedCount: 17,
  returnedCount: 3,
  results: [{ title: "冰箱安全排障指南", section: "不制冷", sourceFile: "x.md", documentVersion: "1.0.0", vectorScore: 0.7, rerankScore: 2.1, text: "..." }],
}));

const orderExecuteMock = mock.fn(async (input: { orderId: string }, _ctx: unknown) => ({
  found: true,
  partial: false,
  order: { order_id: input.orderId, status: "paid", status_text: "已付款", created_at: null, carrier: null, tracking_number: null, latest_logistics: null, estimated_delivery: null, can_cancel: true, customer_tip: null },
}));

const generateMock = mock.fn(async (messages: unknown) => ({ text: "（桩）合成回复，与工具结果内容无关" }));

async function* fakeTextStream() {
  yield "（桩）";
  yield "流式合成回复";
}

const streamMock = mock.fn(async (_messages: unknown) => ({
  textStream: fakeTextStream(),
  getFullOutput: async () => ({ toolResults: [] }),
}));

// 必须在 import "./orchestration.ts" 之前完成 mock 注册——ESM 静态 import
// 在模块顶层就已经解析绑定，specifier 用与 orchestration.ts 完全相同的相对路径
// （本文件与它同在 src/mastra/ 目录下），保证解析到同一个绝对模块。
mock.module("./tools/search-knowledge-base-tool.ts", {
  namedExports: {
    searchKnowledgeBaseTool: { execute: searchExecuteMock },
  },
});
mock.module("./tools/query-order-tool.ts", {
  namedExports: {
    queryOrderTool: { execute: orderExecuteMock },
  },
});
mock.module("./agents/customer-service-agent.ts", {
  namedExports: {
    customerServiceAgent: { generate: generateMock, stream: streamMock },
  },
});

const { runAgentTurn, streamAgentTurn } = await import("./orchestration.ts");

describe("repair/order 路由确定性工具执行", () => {
  it("1&2&6. repair 路由恰好调用一次 searchKnowledgeBase，真实结果进入 ToolCallRecord，与桩合成文本无关", async () => {
    searchExecuteMock.mock.resetCalls();
    generateMock.mock.resetCalls();
    const result = await runAgentTurn("冰箱不制冷应该先检查什么");

    assert.equal(result.route, "repair");
    assert.equal(searchExecuteMock.mock.calls.length, 1, "应恰好调用一次");
    assert.equal(searchExecuteMock.mock.calls[0]!.arguments[0]!.query, "冰箱不制冷应该先检查什么", "query 应来自用户原始消息，不是模型改写");

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "searchKnowledgeBase");
    // 工具返回值原样进入 result，不受桩合成回复文本（与工具结果无关）影响——
    // 证明这些字段不是从 reply 正文解析出来的。
    assert.equal((result.toolCalls[0]!.result as any).retrievedCount, 17);
    assert.equal((result.toolCalls[0]!.result as any).returnedCount, 3);
    assert.equal(result.reply, "（桩）合成回复，与工具结果内容无关");

    // 合成阶段收到的消息里必须包含真实工具结果（tool-result part），
    // 不是只把 reply 文本传回去。
    const synthesisMessages = generateMock.mock.calls[0]!.arguments[0] as any[];
    const toolResultMsg = synthesisMessages.find((m) => m.role === "tool");
    assert.ok(toolResultMsg, "合成消息里必须有 role=tool 的 tool-result part");
    assert.equal(toolResultMsg.content[0].output.value.retrievedCount, 17);
  });

  it("3. 空召回：retrievedCount/returnedCount=0，不编造来源", async () => {
    searchExecuteMock.mock.mockImplementationOnce(async () => ({
      reranked: false,
      degraded: false,
      retrievedCount: 0,
      returnedCount: 0,
      results: [],
    }));
    const result = await runAgentTurn("电视有声音没有画面怎么办");
    const kb = result.toolCalls[0]!.result as any;
    assert.equal(kb.retrievedCount, 0);
    assert.equal(kb.returnedCount, 0);
    assert.deepEqual(kb.results, []);
  });

  it("4. Reranker unavailable：degraded=true 且 degradedReason 明确", async () => {
    searchExecuteMock.mock.mockImplementationOnce(async () => ({
      reranked: false,
      degraded: true,
      degradedReason: "Reranker 不可用",
      retrievedCount: 12,
      returnedCount: 5,
      results: [],
    }));
    const result = await runAgentTurn("显示器提示无信号怎么排查");
    const kb = result.toolCalls[0]!.result as any;
    assert.equal(kb.degraded, true);
    assert.equal(kb.degradedReason, "Reranker 不可用");
  });

  it("5. 工具异常：不进入无依据维修回答（不调用模型合成，不产出假 toolCalls）", async () => {
    generateMock.mock.resetCalls();
    searchExecuteMock.mock.mockImplementationOnce(async () => {
      throw new Error("Qdrant 连接失败（模拟）");
    });
    const result = await runAgentTurn("冰箱结霜严重怎么办");
    assert.equal(result.toolCalls.length, 0, "工具异常时不得产出伪造的 toolCalls");
    assert.match(result.reply, /暂时不可用|无法/, "应如实告知服务不可用，不是正常排查建议");
    assert.equal(generateMock.mock.calls.length, 0, "没有真实工具结果时不应再调用模型自由合成");
  });

  it("7. 订单路由：恰好调用一次 queryOrderTool，orderId 来自当前消息的正则提取", async () => {
    orderExecuteMock.mock.resetCalls();
    const result = await runAgentTurn("帮我查一下 ORD1001 的状态");
    assert.equal(result.route, "order");
    assert.equal(orderExecuteMock.mock.calls.length, 1);
    assert.equal(orderExecuteMock.mock.calls[0]!.arguments[0]!.orderId, "ORD1001");
    assert.equal(result.toolCalls[0]!.arguments.orderId, "ORD1001");
  });

  it("7b. 订单路由：多轮换订单号，按当前消息重新提取，不沿用历史订单号", async () => {
    orderExecuteMock.mock.resetCalls();
    const history = [
      { role: "user" as const, content: "帮我查一下 ORD1002 的状态" },
      { role: "assistant" as const, content: "ORD1002 正在运输中" },
    ];
    await runAgentTurn("不对，我要查 ORD1003", history);
    assert.equal(orderExecuteMock.mock.calls.length, 1);
    assert.equal(orderExecuteMock.mock.calls[0]!.arguments[0]!.orderId, "ORD1003");
  });

  it("8. safety 路由不触发 searchKnowledgeBase（安全场景优先于维修关键词）", async () => {
    searchExecuteMock.mock.resetCalls();
    const result = await runAgentTurn("电视挂在墙上有点松动，晃一晃能动。");
    assert.equal(result.route, "safety");
    assert.equal(searchExecuteMock.mock.calls.length, 0);
  });

  it("9. chat 与 stream 两条路径对同一输入产出一致的 toolCalls（共用同一个工具执行函数）", async () => {
    searchExecuteMock.mock.resetCalls();
    const chatResult = await runAgentTurn("冰箱不制冷应该先检查什么");

    searchExecuteMock.mock.resetCalls();
    const events: string[] = [];
    const streamResult = await streamAgentTurn("冰箱不制冷应该先检查什么", [], {
      onToolResult: async () => {
        events.push("tool-result");
      },
      onTextDelta: async () => {
        events.push("text-delta");
      },
    });

    assert.equal(searchExecuteMock.mock.calls.length, 1, "stream 路径也应恰好调用一次工具");
    assert.deepEqual(
      chatResult.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      streamResult.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      "chat 与 stream 的工具调用参数应完全一致",
    );
    assert.equal((chatResult.toolCalls[0]!.result as any).retrievedCount, (streamResult.toolCalls[0]!.result as any).retrievedCount);

    // 10. 流式事件顺序：tool-result 必须先于 text-delta（对应 SSE 的
    // meta → tool-result → text-delta → done，meta 由 route 层负责，这里
    // 只验证 orchestration 层保证的相对顺序）。
    const firstToolResultIdx = events.indexOf("tool-result");
    const firstTextDeltaIdx = events.indexOf("text-delta");
    assert.ok(firstToolResultIdx >= 0 && firstTextDeltaIdx >= 0, "两类事件都应发生");
    assert.ok(firstToolResultIdx < firstTextDeltaIdx, "tool-result 必须先于 text-delta 触发");
  });
});
