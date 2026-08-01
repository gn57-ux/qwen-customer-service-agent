/**
 * 路由 + 调用 Agent 的薄适配层——不是新 Agent、不是 LangGraph、不是 workflow，
 * 不实现自己的模型客户端或工具协议。这里只做三件事：
 *   1. classifyRoute()：确定性路由分类，只用来选择要不要走确定性工具执行；
 *   2. order/repair 路由由编排层直接执行已注册的真实工具（queryOrderTool /
 *      searchKnowledgeBaseTool 的 execute()），不依赖模型自己决定要不要调用；
 *   3. 拿到真实工具结果后，续上 customerServiceAgent.generate()/stream() 做
 *      自然语言合成——生成、工具执行结果的最终措辞仍然全部由 Mastra 原生
 *      Agent 完成，这里不实现自己的模型客户端。
 *
 * 历史方案与废弃原因（2026-07-31 真实全链路验收发现，见
 * frontend-workbench/specs/acceptance-2026-07-31/ACCEPTANCE-REPORT.md）：
 * 旧实现用 `customerServiceAgent.generate(messages, {activeTools:[forcedTool],
 * toolChoice:"required", maxSteps:1})` 让模型自己产出结构化 tool-call，
 * Mastra 自动执行工具、结果回填。这依赖 llama-server 对该微调模型的
 * toolChoice:"required" 语义 100% 遵守——但真实验收在同一次会话内对 6 个
 * 全新维修请求（覆盖 Reranker 在线/降级两种条件）全部复现"未产出工具调用，
 * 退化为复读或工具名泄漏"。控制变量实验（重启 llama-server 后用全新会话
 * 重新测试冰箱/彩电/显示器三类维修请求）确认重启不能解决问题，证明这不是
 * 单实例状态残留，而是 toolChoice:"required" 本身对这个模型/推理服务不可靠——
 * 不能继续依赖模型"愿不愿意"调用工具。
 *
 * 现方案：repair/order 两类路由改为编排层直接调用已注册工具实例的
 * `execute(input, { requestContext })`——这是 Mastra 官方 Tool 的公开执行
 * 方法（node_modules/@mastra/core/dist/tools/tool.d.ts 的
 * ToolExecuteFunction 签名），不是复制检索/订单查询逻辑另起一套实现；
 * `requestContext` 的构造方式、以及工具执行后回填给模型做最终合成所需的
 * assistant tool-call part / tool tool-result part 消息结构，均已用真实
 * 请求实测抓取（见 mastra-agent/.scratch/probe-*.ts 的探测记录）而非凭记忆
 * 猜测：`customerServiceAgent.generate(messages, {activeTools, toolChoice:
 * "required", maxSteps:1})` 在真实产出结构化 tool-call 的那些情况下，
 * `step1.response.messages` 就是这个形状——现在直接手工构造完全相同的形状，
 * 但工具本身的调用不再经过模型，而是编排层直接执行，因此不再有"模型拒绝
 * 调用"这条失败路径。
 */

import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";

import { customerServiceAgent } from "./agents/customer-service-agent.ts";
import { queryOrderTool } from "./tools/query-order-tool.ts";
import { searchKnowledgeBaseTool } from "./tools/search-knowledge-base-tool.ts";

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

/** 把 Mastra 自己的 toolResults 数组整理成更好用的扁平结构，按 toolCallId 关联。
 * 仅用于 safety/general 这类不强制工具的路由——那里仍然是模型自己决定要不要
 * 调用工具，调用结果由 Mastra 原生工具循环产出。 */
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

/** classifyRoute 判定为 order 时已确保消息里带 "ORD数字"，这里取第一个匹配
 * 项——多轮对话换订单号场景下每轮只按当前消息重新提取，不沿用历史订单号
 * （agent.e2e.test.ts 的 4c 用例覆盖）。queryOrderTool 内部会自己
 * trim()+toUpperCase()，这里不需要重复归一化。 */
function extractOrderId(message: string): string | null {
  const match = message.match(ORDER_NUMBER_PATTERN);
  return match ? match[0] : null;
}

/** 工具执行失败（Qdrant/Embedding/Reranker 抛错等基础设施异常，不是"未命中"
 * 这种工具正常返回的业务结果）时的固定兜底文案——不再调用模型合成，因为
 * 没有真实工具结果可供合成，模型此时只会自由生成，正是要杜绝的"无依据维修
 * 回答"。文案本身也遵守系统 Prompt 的安全优先级，不建议自行拆机/检查。 */
const REPAIR_TOOL_FAILURE_REPLY =
  "知识库检索服务暂时不可用，我现在无法提供有真实资料依据的排查建议，为避免误导不会凭经验直接回答。" +
  "请稍后重试，或转专业售后处理；如设备出现冒烟、明火、漏电或积水等情况，请先远离危险源，不要自行拆机或检查。";

const ORDER_TOOL_FAILURE_REPLY =
  "订单系统暂时无法访问，我不会编造订单状态、物流节点或退款结果。请稍后重试，或转人工核实。";

/** 编排层直接执行已注册的 searchKnowledgeBaseTool 实例——不复制检索/重排
 * 逻辑、不手写假结果；execute() 是 Mastra 官方 Tool 的公开方法，第二个参数
 * 是其正式要求的执行上下文，最小构造为 { requestContext }（其余字段如
 * mastra/abortSignal/workspace 均为可选，工具实现本身也未使用它们，见
 * search-knowledge-base-tool.ts 的 execute 函数体）。 */
/** { requestContext, observe } 是 execute() 的最小合法上下文：requestContext
 * 由运行时始终保证非空（空实例即可，两个工具的 execute 都不读它），observe
 * 是 Mastra 官方导出的无操作实现（@mastra/core/tools 的 noopObserve，
 * span 直接运行传入函数、log 是空操作）——不是我们自己臆造的占位对象。 */
async function executeSearchKnowledgeBase(query: string): Promise<unknown> {
  return searchKnowledgeBaseTool.execute!(
    { query },
    { requestContext: new RequestContext(), observe: noopObserve },
  );
}

async function executeQueryOrderTool(orderId: string): Promise<unknown> {
  return queryOrderTool.execute!(
    { orderId },
    { requestContext: new RequestContext(), observe: noopObserve },
  );
}

/** 生成一个仅用于关联 assistant tool-call part 与 tool tool-result part 的
 * 本地 ID——不需要全局唯一或加密安全，只需要在这一轮对话消息里不重复。 */
function localToolCallId(): string {
  return `forced-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * 把一次真实工具调用结果封装成 Mastra/AI SDK v5 期望的结构化消息对
 * （assistant 的 tool-call part + tool 的 tool-result part），供
 * customerServiceAgent.generate()/.stream() 续上做最终合成。
 *
 * 消息形状不是凭记忆猜的：用真实请求跑通旧的强制 toolChoice 路径后，
 * 打印 `step1.response.messages` 实测抓取（探测脚本见
 * mastra-agent/.scratch/probe-shape.ts，探测结果记录在本文件头部注释与
 * ACCEPTANCE-REPORT.md 的「根因确认」章节），逐字段核对过
 * type/toolCallId/toolName/input/output 的键名与嵌套结构。
 */
function buildToolResultMessages(call: ToolCallRecord): unknown[] {
  const id = localToolCallId();
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: call.name, input: call.arguments }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: call.name,
          output: { type: "json", value: call.result },
          input: call.arguments,
        },
      ],
    },
  ];
}

type ForcedExecution = { toolCall: ToolCallRecord } | { fallbackReply: string };

/**
 * repair/order 路由的确定性工具执行——chat（runAgentTurn）与 stream
 * （streamAgentTurn）共用同一个函数，保证两条路径的工具调用/结果整理逻辑
 * 不会各自实现一遍、逐渐漂移（任务要求 6）。
 *
 * 不解析模型正文、不读取任何 LLM 输出来决定要不要调用或调用什么参数——
 * 参数（query 用原始用户消息、orderId 用确定性正则提取）完全来自
 * classifyRoute() 已经验证过的用户输入本身。
 */
async function executeForcedRoute(route: "repair" | "order", userMessage: string): Promise<ForcedExecution> {
  if (route === "repair") {
    try {
      const result = await executeSearchKnowledgeBase(userMessage);
      return { toolCall: { name: "searchKnowledgeBase", arguments: { query: userMessage }, result } };
    } catch {
      return { fallbackReply: REPAIR_TOOL_FAILURE_REPLY };
    }
  }

  const orderId = extractOrderId(userMessage);
  if (!orderId) {
    // classifyRoute 判定为 order 时已保证消息匹配 ORDER_NUMBER_PATTERN，
    // 这里理论不可达；保留兜底而不是非空断言，避免正则未来演进出现分支
    // 不一致时静默抛出未处理异常。
    return { fallbackReply: ORDER_TOOL_FAILURE_REPLY };
  }
  try {
    const result = await executeQueryOrderTool(orderId);
    return { toolCall: { name: "queryOrderTool", arguments: { orderId }, result } };
  } catch {
    return { fallbackReply: ORDER_TOOL_FAILURE_REPLY };
  }
}

function isForcedRoute(route: RouteCategory): route is "repair" | "order" {
  return route === "repair" || route === "order";
}

export async function runAgentTurn(
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<AgentRunResult> {
  const route = classifyRoute(userMessage);
  const messages = [...history, { role: "user" as const, content: userMessage }];

  if (!isForcedRoute(route)) {
    // safety / general：不强制工具，交给 customerServiceAgent 自己判断
    // （安全场景已实测不需要检索也能给出正确的安全边界；普通表达/无订单号的
    // 订单意图也已实测会正确先追问，不会盲目调用工具）。
    const result = await customerServiceAgent.generate(messages as any);
    return { reply: result.text.trim(), toolCalls: collectToolCalls(result), route };
  }

  const execution = await executeForcedRoute(route, userMessage);
  if ("fallbackReply" in execution) {
    return { reply: execution.fallbackReply, toolCalls: [], route };
  }

  const toolMessages = buildToolResultMessages(execution.toolCall);
  const synthesis = await customerServiceAgent.generate([...messages, ...toolMessages] as any);
  return { reply: synthesis.text.trim(), toolCalls: [execution.toolCall], route };
}

export interface StreamAgentTurnHandlers {
  /** 强制路由的工具在流式合成开始前就已经真实执行完毕，这里立刻通知一次。
   * 允许返回 Promise（例如 SSE 路由里要 await stream.writeSSE），调用方会等待。 */
  onToolResult?: (call: ToolCallRecord) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
}

/**
 * runAgentTurn 的流式版本：路由/工具执行逻辑与 runAgentTurn 完全一致（共用
 * executeForcedRoute/buildToolResultMessages），只是最终合成那一步用
 * customerServiceAgent.stream() 而不是 .generate()，把文本增量通过
 * onTextDelta 回调实时吐出去（供 /customer-service/stream 路由转成 SSE，
 * 事件顺序 meta → tool-result → text-delta → done 由该 route 层保证）。
 */
export async function streamAgentTurn(
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  handlers: StreamAgentTurnHandlers = {},
): Promise<AgentRunResult> {
  const route = classifyRoute(userMessage);
  const messages = [...history, { role: "user" as const, content: userMessage }];

  let toolCalls: ToolCallRecord[] = [];
  let finalMessages: unknown = messages;

  if (isForcedRoute(route)) {
    const execution = await executeForcedRoute(route, userMessage);
    if ("fallbackReply" in execution) {
      await handlers.onTextDelta?.(execution.fallbackReply);
      return { reply: execution.fallbackReply, toolCalls: [], route };
    }
    toolCalls = [execution.toolCall];
    await handlers.onToolResult?.(execution.toolCall);
    finalMessages = [...messages, ...buildToolResultMessages(execution.toolCall)];
  }

  const streamResult = await customerServiceAgent.stream(finalMessages as any);
  let text = "";
  for await (const delta of streamResult.textStream) {
    text += delta;
    await handlers.onTextDelta?.(delta);
  }

  if (!isForcedRoute(route)) {
    const full = await streamResult.getFullOutput();
    toolCalls = collectToolCalls(full as unknown as GenerateResult);
    for (const call of toolCalls) await handlers.onToolResult?.(call);
  }

  return { reply: text.trim(), toolCalls, route };
}
