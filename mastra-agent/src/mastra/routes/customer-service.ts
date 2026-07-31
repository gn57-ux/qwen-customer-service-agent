/**
 * customer-service/chat 与 customer-service/stream：唯一允许前端调用的正式入口。
 *
 * 前端路径必须是 React/Vite → @mastra/client-js（MastraClient.request()）→
 * 这两个自定义 Mastra Server route → runAgentTurn()/streamAgentTurn()
 * （确定性路由 + 强制工具）→ customerServiceAgent → FastAPI:8000 →
 * llama-server → queryOrderTool/searchKnowledgeBaseTool。
 *
 * 这两个 route 是唯一调用点：前端不能通过标准 Agent endpoint
 * （/api/agents/customerServiceAgent/generate）绕开这里的路由逻辑直接跟
 * Agent 对话——那样会跳过 classifyRoute()/强制 toolChoice，回到"模型自己
 * 决定要不要检索"的不可靠状态（见 README-AGENT.md 记录的实测问题）。这两个
 * route 内部固定调用 runAgentTurn()/streamAgentTurn()，请求体里不接受
 * toolChoice/activeTools 等参数，杜绝绕过。
 */

import { registerApiRoute } from "@mastra/core/server";
import { streamSSE } from "hono/streaming";

import { buildContractExtras, newTraceId, type ChatResponseBody } from "../contract.ts";
import { collectServiceStatus } from "../health/probes.ts";
import { runAgentTurn, streamAgentTurn, type ToolCallRecord } from "../orchestration.ts";

interface ChatRequestBody {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

function parseHistory(body: unknown): { message: string; history: Array<{ role: "user" | "assistant"; content: string }> } {
  const b = (body ?? {}) as Partial<ChatRequestBody>;
  if (typeof b.message !== "string" || b.message.trim().length === 0) {
    throw new Error("请求体必须包含非空的 message 字段");
  }
  const history = Array.isArray(b.history)
    ? b.history.filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          typeof m === "object" && m !== null &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
    : [];
  return { message: b.message, history };
}

export const customerServiceChatRoute = registerApiRoute("/customer-service/chat", {
  method: "POST",
  handler: async (c) => {
    const traceId = newTraceId();
    const started = Date.now();
    let parsed: ReturnType<typeof parseHistory>;
    try {
      parsed = parseHistory(await c.req.json().catch(() => ({})));
    } catch (cause) {
      return c.json({ error: (cause as Error).message, traceId }, 400);
    }

    try {
      const result = await runAgentTurn(parsed.message, parsed.history);
      const body: ChatResponseBody = {
        reply: result.reply,
        route: result.route,
        toolCalls: result.toolCalls,
        ...buildContractExtras(result.toolCalls),
        traceId,
        latencyMs: Date.now() - started,
      };
      return c.json(body, 200);
    } catch (cause) {
      return c.json({ error: (cause as Error).message, traceId }, 502);
    }
  },
});

export const customerServiceStreamRoute = registerApiRoute("/customer-service/stream", {
  method: "POST",
  handler: async (c) => {
    const traceId = newTraceId();
    const started = Date.now();
    let parsed: ReturnType<typeof parseHistory>;
    try {
      parsed = parseHistory(await c.req.json().catch(() => ({})));
    } catch (cause) {
      return c.json({ error: (cause as Error).message, traceId }, 400);
    }

    // registerApiRoute() 的 Context 类型来自 @mastra/core 内部打包的一份 Hono
    // 类型快照，与顶层 node_modules/hono（同一个 npm 依赖树里被去重到同一个
    // 4.12.31，运行时是同一个模块实例）在结构类型上对不上号（差在一个内部
    // symbol 键属性），纯粹是类型层面的摩擦，不是真的类型不兼容——这里按需
    // 断言一次，不代表放松了别处的类型检查。
    return streamSSE(c as any, async (stream) => {
      const toolCalls: ToolCallRecord[] = [];
      try {
        await stream.writeSSE({ event: "meta", data: JSON.stringify({ traceId }) });

        const result = await streamAgentTurn(parsed.message, parsed.history, {
          onToolResult: async (call) => {
            toolCalls.push(call);
            await stream.writeSSE({ event: "tool-result", data: JSON.stringify(call) });
          },
          onTextDelta: async (delta) => {
            await stream.writeSSE({ event: "text-delta", data: JSON.stringify({ delta }) });
          },
        });

        const body: ChatResponseBody = {
          reply: result.reply,
          route: result.route,
          toolCalls: result.toolCalls,
          ...buildContractExtras(result.toolCalls),
          traceId,
          latencyMs: Date.now() - started,
        };
        await stream.writeSSE({ event: "done", data: JSON.stringify(body) });
      } catch (cause) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (cause as Error).message, traceId }),
        });
      }
    });
  },
});

/**
 * 服务状态探测：恒返回 200。下游全挂也是三个 "error" 字段的正常业务结果，
 * 不是接口错误——5xx 留给"这个端点自身故障"这一真正异常，让前端只需处理
 * 一种成功形态（需求 §5.5 B-3、design.md「下游全挂返回 200 vs 5xx」）。
 */
export const customerServiceStatusRoute = registerApiRoute("/customer-service/status", {
  method: "GET",
  handler: async (c) => c.json(await collectServiceStatus(), 200),
});
