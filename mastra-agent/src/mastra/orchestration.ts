/**
 * 路由 + 调用 Agent 的薄适配层——不是新 Agent、不是 LangGraph、不是 workflow，
 * 不实现自己的模型客户端或工具协议。真正的生成、工具执行、结果回填全部由
 * customerServiceAgent.generate()（Mastra 原生执行方法）完成；这里只做两件事：
 *   1. classifyRoute()：确定性路由分类，只用来选择要不要强制 toolChoice；
 *   2. 按分类结果调用 customerServiceAgent.generate()，必要时分两步强制工具调用。
 *
 * 为什么"维修事实"和"带订单号"两类需要强制 toolChoice（已用真实请求验证，
 * 详见 README-AGENT.md「已知限制与踩坑记录」）：
 * 这个微调模型对维修排查步骤有很强的训练记忆，即使两个工具都注册给它、
 * System Prompt 也强调"必须先检索"，在 toolChoice 默认 auto 时它仍然经常
 * 跳过 searchKnowledgeBase 直接背答案。订单场景实测不强制也大多数时候可靠，
 * 但按任务要求（带订单号必须调用）仍然一并走确定性强制路径，不依赖模型判断。
 *
 * 为什么强制调用分两步（先 maxSteps:1 拿到工具结果，再单独调用一次做最终
 * 合成），而不是一次 toolChoice:"required" + 多步跑到底：
 * 已用真实请求验证，llama-server 对这个模型的 toolChoice 语义有限——
 * `{type:'tool', toolName:X}` 这种指定具体函数的强制形式不会被真正遵守，
 * 只有通用的 "required" 才会真的产出结构化 tool_calls；但如果整个多步循环
 * 都带着 toolChoice:"required" 跑（即强制这一步之后的每一步也必须调用工具），
 * 在维修检索这类召回内容本身包含多条相似安全提示的场景下，合成步骤会解码
 * 退化成大段复读。拆成两步后：第一步只强制一次（maxSteps:1，产出一次真实
 * 的结构化 tool-call + Mastra 自动执行 + 结构化 tool-result），第二步是
 * 普通的 customerServiceAgent.generate()（toolChoice 恢复默认，不再强制），
 * 用 Mastra 自己的结构化消息格式（AI SDK v5 assistant tool-call part /
 * tool tool-result part，不是纯字符串 role=tool）把第一步的结果续上做最终
 * 合成——两步都是 customerServiceAgent.generate()，没有绕开它。
 */

import type { Agent } from "@mastra/core/agent";

import { customerServiceAgent } from "./agents/customer-service-agent.ts";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentRunResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  route: RouteCategory;
}

type GenerateResult = Awaited<ReturnType<Agent["generate"]>>;

/** 把 Mastra 自己的 toolResults 数组整理成更好用的扁平结构，按 toolCallId 关联。 */
function collectToolCalls(result: GenerateResult): ToolCallRecord[] {
  const results = (result.toolResults ?? []) as Array<{
    payload?: { toolName?: string; args?: Record<string, unknown>; result?: unknown };
  }>;
  return results
    .filter((r) => r.payload)
    .map((r) => ({
      name: r.payload!.toolName ?? "",
      arguments: r.payload!.args ?? {},
      result: r.payload!.result,
    }));
}

/**
 * 路由分类（已用真实请求验证为必要，不是过度设计——见文件头注释）：
 * 安全场景优先级最高，不强制任何工具（不需要检索就能给出正确的安全边界，
 * 已实测；需要事实时由模型自己决定下一步是否检索）。订单号识别优先于维修域
 * 关键词判断（例如"电视挂架松动"同时含"电视"，但属于安全场景不是维修检索）。
 */
const SAFETY_PATTERN =
  /冒烟|明火|火花|焦[味糊]|漏电|触电|插头.{0,4}(发热|烧黑|发黑|发烫)|插座.{0,4}(发热|烧黑|发黑|发烫)|积水|松动|摇晃|晃(一晃|得动)?|掉落|坠落/;
const ORDER_NUMBER_PATTERN = /ORD\d+/i;
const REPAIR_DOMAIN_PATTERN =
  /冰箱|电视|彩电|显示器|冷藏|冷冻|不制冷|无信号|不亮|花屏|漏水|结霜|异味|噪音|噪声|保修|维修|排查|免拆机|升级条件/;

export type RouteCategory = "safety" | "order" | "repair" | "general";

export function classifyRoute(message: string): RouteCategory {
  if (SAFETY_PATTERN.test(message)) return "safety";
  if (ORDER_NUMBER_PATTERN.test(message)) return "order";
  if (REPAIR_DOMAIN_PATTERN.test(message)) return "repair";
  return "general";
}

const FORCED_TOOL_BY_ROUTE: Partial<Record<RouteCategory, "queryOrderTool" | "searchKnowledgeBase">> = {
  order: "queryOrderTool",
  repair: "searchKnowledgeBase",
};

export async function runAgentTurn(
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<AgentRunResult> {
  const route = classifyRoute(userMessage);
  const forcedTool = FORCED_TOOL_BY_ROUTE[route];
  const messages = [...history, { role: "user" as const, content: userMessage }];

  if (!forcedTool) {
    // safety / general：不强制工具，交给 customerServiceAgent 自己判断
    // （安全场景已实测不需要检索也能给出正确的安全边界；普通表达/无订单号的
    // 订单意图也已实测会正确先追问，不会盲目调用工具）。
    const result = await customerServiceAgent.generate(messages as any);
    return { reply: result.text.trim(), toolCalls: collectToolCalls(result), route };
  }

  // 第一步：只强制这一步调用指定工具，maxSteps=1——Mastra 会自动执行真实注册
  // 的 queryOrderTool/searchKnowledgeBaseTool，并把结构化 tool-call/tool-result
  // 放进 response.messages。
  const step1 = await customerServiceAgent.generate(messages as any, {
    activeTools: [forcedTool],
    toolChoice: "required",
    maxSteps: 1,
  });

  const toolCalls = collectToolCalls(step1);
  if (toolCalls.length === 0) {
    // 极少数情况下强制仍未产出工具调用：不伪造结果，直接把第一步的文本作为
    // 回复返回，不进入第二步合成（没有工具结果可合成）。
    return { reply: step1.text.trim(), toolCalls: [], route };
  }

  // 第二步：普通调用（toolChoice 恢复默认），用 Mastra 自己的结构化消息续上
  // 第一步的 tool-call/tool-result，做最终合成——仍然是 customerServiceAgent.generate()。
  const responseMessages = step1.response?.messages ?? [];
  const step2 = await customerServiceAgent.generate([...messages, ...responseMessages] as any);
  return { reply: step2.text.trim(), toolCalls, route };
}

export interface StreamAgentTurnHandlers {
  /** 强制路由的工具在流式合成开始前就已经真实执行完毕，这里立刻通知一次。
   * 允许返回 Promise（例如 SSE 路由里要 await stream.writeSSE），调用方会等待。 */
  onToolResult?: (call: ToolCallRecord) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
}

/**
 * runAgentTurn 的流式版本：路由/强制工具逻辑完全一致，只是最终合成那一步用
 * customerServiceAgent.stream() 而不是 .generate()，把文本增量通过
 * onTextDelta 回调实时吐出去（供 /customer-service/stream 路由转成 SSE）。
 *
 * 强制路由（order/repair）时，工具调用发生在流式合成开始之前（两步模式的
 * 第一步本来就不是流式的），所以 onToolResult 会在任何 onTextDelta 之前
 * 同步触发；不强制路由（safety/general）时，Mastra 的 stream() 内部循环
 * 理论上也可能自己决定调用工具，但已实测这两类场景几乎不会主动调用工具，
 * 这种情况下 onToolResult 会在文本流结束后才触发（读取 getFullOutput()）。
 */
export async function streamAgentTurn(
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  handlers: StreamAgentTurnHandlers = {},
): Promise<AgentRunResult> {
  const route = classifyRoute(userMessage);
  const forcedTool = FORCED_TOOL_BY_ROUTE[route];
  const messages = [...history, { role: "user" as const, content: userMessage }];

  let toolCalls: ToolCallRecord[] = [];
  let finalMessages: unknown = messages;

  if (forcedTool) {
    const step1 = await customerServiceAgent.generate(messages as any, {
      activeTools: [forcedTool],
      toolChoice: "required",
      maxSteps: 1,
    });
    toolCalls = collectToolCalls(step1);
    if (toolCalls.length === 0) {
      await handlers.onTextDelta?.(step1.text.trim());
      return { reply: step1.text.trim(), toolCalls: [], route };
    }
    for (const call of toolCalls) await handlers.onToolResult?.(call);
    finalMessages = [...messages, ...(step1.response?.messages ?? [])];
  }

  const streamResult = await customerServiceAgent.stream(finalMessages as any);
  let text = "";
  for await (const delta of streamResult.textStream) {
    text += delta;
    await handlers.onTextDelta?.(delta);
  }

  if (!forcedTool) {
    const full = await streamResult.getFullOutput();
    toolCalls = collectToolCalls(full as unknown as GenerateResult);
    for (const call of toolCalls) await handlers.onToolResult?.(call);
  }

  return { reply: text.trim(), toolCalls, route };
}
