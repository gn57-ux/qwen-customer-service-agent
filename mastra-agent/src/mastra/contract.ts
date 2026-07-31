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

/**
 * 订单详情类型化白名单：只从 queryOrderTool 返回的泛型 order 记录里映射这 10 个
 * 字段。字段名之外的键一律丢弃——不透传，避免后端新增内部字段（成本价、供应商、
 * 内部备注等）意外流向前端。10 个键**全部必填**（非可选）：字段缺失或类型不符
 * 时显式落 null，绝不省略为 undefined——省略会让前端无法区分「服务端没给」与
 * 「映射函数漏了」，必填 + 显式 null 让两者都能被类型系统与测试捕捉到。
 */
export interface OrderDetails {
  orderId: string | null;
  status: string | null;
  statusText: string | null;
  createdAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  latestLogistics: string | null;
  estimatedDelivery: string | null;
  canCancel: boolean | null;
  customerTip: string | null;
}

export interface OrderStatus {
  found: boolean;
  partial?: boolean;
  missingFields?: string[];
  error?: "not_found" | "timeout" | "server_error" | "network_error";
  details?: OrderDetails;
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
  /** 向量检索实际命中数；未调用 searchKnowledgeBase 时为 0 */
  retrievedCount: number;
  /** 最终返回条数；未调用 searchKnowledgeBase 时为 0 */
  returnedCount: number;
  traceId: string;
  latencyMs: number;
}

interface SearchKnowledgeBaseToolResult {
  reranked: boolean;
  degraded: boolean;
  degradedReason?: string;
  retrievedCount: number;
  returnedCount: number;
  results: KnowledgeSourceItem[];
}

interface QueryOrderToolResult {
  found: boolean;
  partial?: boolean;
  order?: Record<string, unknown>;
  missingFields?: string[];
  error?: "not_found" | "timeout" | "server_error" | "network_error";
}

/** snake_case 源键 → camelCase 目标键，仅这 10 个字段白名单放行。 */
const ORDER_DETAILS_FIELD_MAP: Record<string, keyof OrderDetails> = {
  order_id: "orderId",
  status: "status",
  status_text: "statusText",
  created_at: "createdAt",
  carrier: "carrier",
  tracking_number: "trackingNumber",
  latest_logistics: "latestLogistics",
  estimated_delivery: "estimatedDelivery",
  can_cancel: "canCancel",
  customer_tip: "customerTip",
};

const ORDER_DETAILS_BOOLEAN_FIELDS = new Set<keyof OrderDetails>(["canCancel"]);

/**
 * 把 queryOrderTool 返回的泛型 order 记录映射为类型化白名单 OrderDetails。
 * 非对象直接返回 undefined（不构造空壳）；白名单外的键丢弃；10 个键**全部显式
 * 赋值**——字段缺失或类型不符时落 null，绝不省略（省略等于让 TS 的必填约束
 * 形同虚设）；canCancel 按布尔收窄，非预期类型一律落 null 而非强转。
 */
function toOrderDetails(order: unknown): OrderDetails | undefined {
  if (!order || typeof order !== "object") return undefined;
  const src = order as Record<string, unknown>;
  const out: Record<string, string | boolean | null> = {};
  for (const [from, to] of Object.entries(ORDER_DETAILS_FIELD_MAP)) {
    const value = src[from];
    if (ORDER_DETAILS_BOOLEAN_FIELDS.has(to)) {
      out[to] = typeof value === "boolean" ? value : null;
    } else {
      // 非预期类型不强转，一律落 null——不臆造格式正确但内容错误的值
      out[to] = typeof value === "string" ? value : null;
    }
  }
  // out 的键在循环里已按 ORDER_DETAILS_FIELD_MAP（与 OrderDetails 的 10 个字段一一对应）
  // 逐一显式赋值，运行时形状与 OrderDetails 一致；TS 无法从 Record<string, ...> 的索引
  // 签名静态验证这一点，经 unknown 收窄一次是必要的双重断言，不是绕过检查。
  return out as unknown as OrderDetails;
}

/** 从真实工具调用结果里结构化提取——不解析自然语言文本。 */
export function buildContractExtras(toolCalls: ToolCallRecord[]): {
  sources?: KnowledgeSourceItem[];
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  order?: OrderStatus;
  retrievedCount: number;
  returnedCount: number;
} {
  const kbCall = [...toolCalls].reverse().find((c) => c.name === "searchKnowledgeBase");
  const orderCall = [...toolCalls].reverse().find((c) => c.name === "queryOrderTool");

  const extras: ReturnType<typeof buildContractExtras> = { retrievedCount: 0, returnedCount: 0 };

  if (kbCall) {
    const r = kbCall.result as SearchKnowledgeBaseToolResult;
    extras.sources = r.results;
    extras.reranked = r.reranked;
    extras.degraded = r.degraded;
    if (r.degradedReason) extras.degradedReason = r.degradedReason;
    extras.retrievedCount = r.retrievedCount;
    extras.returnedCount = r.returnedCount;
  }

  if (orderCall) {
    const r = orderCall.result as QueryOrderToolResult;
    // 只有 found === true 才允许提取 details——found:false 时（not_found/timeout/
    // server_error/network_error）即便 order 字段意外带了数据，也绝不能透出，
    // 否则前端会把一次失败查询误当作真实订单展示给客服坐席。
    const details = r.found ? toOrderDetails(r.order) : undefined;
    extras.order = {
      found: r.found,
      ...(r.partial !== undefined ? { partial: r.partial } : {}),
      ...(r.missingFields ? { missingFields: r.missingFields } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }

  return extras;
}

export function newTraceId(): string {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
