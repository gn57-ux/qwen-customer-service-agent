/**
 * 与 mastra-agent/src/mastra/contract.ts 保持一致的类型镜像。
 * web-client 是独立的最小包（不依赖 mastra-agent 的编译单元），这里手动
 * 复制字段定义；改动服务端契约时必须同步改这里，两边字段名/可选性必须一致。
 */

export type RouteCategory = "safety" | "order" | "repair" | "general";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface KnowledgeSourceItem {
  title: string;
  section: string;
  sourceFile: string;
  documentVersion: string;
  vectorScore: number;
  rerankScore: number | null;
}

export interface OrderStatus {
  found: boolean;
  partial?: boolean;
  missingFields?: string[];
  error?: "not_found" | "timeout" | "server_error" | "network_error";
}

export interface ChatResponseBody {
  reply: string;
  route: RouteCategory;
  toolCalls: ToolCallRecord[];
  sources?: KnowledgeSourceItem[];
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  order?: OrderStatus;
  traceId: string;
  latencyMs: number;
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** /customer-service/stream 的 SSE 事件（event 字段决定 data 的形状）。*/
export type StreamEvent =
  | { event: "meta"; data: { traceId: string } }
  | { event: "tool-result"; data: ToolCallRecord }
  | { event: "text-delta"; data: { delta: string } }
  | { event: "done"; data: ChatResponseBody }
  | { event: "error"; data: { message: string; traceId: string } };
