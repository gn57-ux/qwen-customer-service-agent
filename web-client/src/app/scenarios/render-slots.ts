/**
 * 场景插槽分发（design.md 模块 1）。按结构化字段决定 AssistantMessage 要填充
 * 哪些插槽——⛔ 不解析 reply 正文。
 */
import type { ChatResponseBody } from "../../types.ts";

export interface ResolvedSlots {
  safetyCard: boolean;
  orderCard: boolean;
  citations: boolean;
}

export function resolveSlots(body: ChatResponseBody): ResolvedSlots {
  return {
    // 仅 route 决定——安全建议必须始终以安全卡呈现，不依赖是否调用了工具
    safetyCard: body.route === "safety",
    // 三条件缺一不可：route==="order" 排除安全/维修场景里恰好带着 order 字段
    // 误渲染卡片；toolCalls 含 queryOrderTool + order 存在，排除"未提供订单号，
    // 服务端先追问"场景（F-002：那种场景 route 同样是 order，但没调用工具）。
    orderCard: body.route === "order" && body.toolCalls.some((call) => call.name === "queryOrderTool") && !!body.order,
    // general 场景⛔不渲染引用角标（F-005），即便 sources 意外非空也要挡住
    citations: body.route !== "general" && (body.sources ?? []).length > 0,
  };
}
