/**
 * 客服 Agent 对外响应契约：/customer-service/chat 与 /customer-service/stream
 * 共用同一套结构化字段。这里是唯一权威定义——工具状态、RAG 来源、订单状态全部
 * 从 queryOrderTool/searchKnowledgeBaseTool 自己的结构化 outputSchema 里取，
 * 不从模型的自然语言回复里用正则猜。
 *
 * web-client/src/types.ts 里有一份类型镜像供前端独立使用（不与本文件共享
 * TS 编译单元，web-client 是独立的最小包），字段必须与这里保持一致——
 * 改这里的字段时同步改那边。
 */

import type { RouteCategory, ToolCallRecord } from "./orchestration.ts";

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
  /** 只有调用过 searchKnowledgeBase 时才有值 */
  sources?: KnowledgeSourceItem[];
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  /** 只有调用过 queryOrderTool 时才有值（多次调用取最后一次） */
  order?: OrderStatus;
  traceId: string;
  latencyMs: number;
}

interface SearchKnowledgeBaseToolResult {
  reranked: boolean;
  degraded: boolean;
  degradedReason?: string;
  results: KnowledgeSourceItem[];
}

interface QueryOrderToolResult {
  found: boolean;
  partial?: boolean;
  missingFields?: string[];
  error?: "not_found" | "timeout" | "server_error" | "network_error";
}

/** 从真实工具调用结果里结构化提取——不解析自然语言文本。 */
export function buildContractExtras(toolCalls: ToolCallRecord[]): {
  sources?: KnowledgeSourceItem[];
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  order?: OrderStatus;
} {
  const kbCall = [...toolCalls].reverse().find((c) => c.name === "searchKnowledgeBase");
  const orderCall = [...toolCalls].reverse().find((c) => c.name === "queryOrderTool");

  const extras: ReturnType<typeof buildContractExtras> = {};

  if (kbCall) {
    const r = kbCall.result as SearchKnowledgeBaseToolResult;
    extras.sources = r.results;
    extras.reranked = r.reranked;
    extras.degraded = r.degraded;
    if (r.degradedReason) extras.degradedReason = r.degradedReason;
  }

  if (orderCall) {
    const r = orderCall.result as QueryOrderToolResult;
    extras.order = {
      found: r.found,
      ...(r.partial !== undefined ? { partial: r.partial } : {}),
      ...(r.missingFields ? { missingFields: r.missingFields } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  return extras;
}

export function newTraceId(): string {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
