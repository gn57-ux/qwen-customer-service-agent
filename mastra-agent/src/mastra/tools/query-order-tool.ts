import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const mockBackendUrl =
  process.env.MOCK_BACKEND_URL ?? "http://127.0.0.1:8001";

/** 订单后端超时上限；超时/网络错误/5xx/字段缺失一律不编造订单状态，如实返回可执行的错误分类 */
const REQUEST_TIMEOUT_MS = Number(process.env.QUERY_ORDER_TIMEOUT_MS || 8000);

const errorReasonSchema = z.enum(["not_found", "timeout", "server_error", "network_error"]);

/**
 * 关键字段：按 services/mock_backend.py 的真实 schema 定义——ORDERS 里每条
 * 记录固定含 order_id/status/status_text/created_at/carrier/tracking_number/
 * latest_logistics/estimated_delivery/can_cancel/customer_tip。其中
 * carrier/tracking_number/latest_logistics/estimated_delivery 在未发货订单
 * 上本来就是 null（例如 ORD1001，status=paid，尚未出库）——这是订单所处阶段
 * 决定的正常状态，不算"字段缺失"，不能一律当成 partial。
 * 只有 order_id/status/status_text 这三个"回答订单状态必须要有"的字段缺失时
 * 才算 partial=true，避免把"物流信息还没有"误判成"系统数据不完整"。
 */
const KEY_FIELDS = ["order_id", "status", "status_text"] as const;

function computeMissingFields(order: Record<string, unknown>): string[] {
  return KEY_FIELDS.filter((f) => order[f] === undefined || order[f] === null || order[f] === "");
}

interface QueryOrderResult {
  found: boolean;
  partial?: boolean;
  order?: Record<string, unknown>;
  missingFields?: string[];
  message?: string;
  error?: "not_found" | "timeout" | "server_error" | "network_error";
}

export const queryOrderTool = createTool({
  id: "query-order",
  description:
    "根据订单号查询真实的订单状态、物流进度、预计送达时间和可执行的客服操作。用户提供订单号后必须使用此工具，禁止猜测订单信息。",
  inputSchema: z.object({
    orderId: z
      .string()
      .min(1)
      .describe("客户提供的订单号，例如 ORD1001"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    partial: z.boolean().optional(),
    order: z.record(z.string(), z.unknown()).optional(),
    missingFields: z.array(z.string()).optional(),
    message: z.string().optional(),
    error: errorReasonSchema.optional(),
  }),
  execute: async ({ orderId }): Promise<QueryOrderResult> => {
    const normalizedOrderId = orderId.trim().toUpperCase();

    let response: Response;
    try {
      response = await fetch(
        `${mockBackendUrl}/api/orders/${encodeURIComponent(normalizedOrderId)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    } catch (cause) {
      // AbortSignal.timeout() 触发时 fetch 抛出 name === "TimeoutError"；
      // 真正的连接失败（服务未启动等）不会带这个 name，要分开报告原因。
      const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
      const errorKind: "timeout" | "network_error" = isTimeout ? "timeout" : "network_error";
      return {
        found: false,
        error: errorKind,
        message: isTimeout
          ? `查询订单 ${normalizedOrderId} 超时（超过 ${REQUEST_TIMEOUT_MS}ms），未获得任何结果，` +
            `不得编造订单状态；请如实告知用户系统繁忙，建议稍后重试或转人工核实。`
          : `无法连接订单系统查询 ${normalizedOrderId}：${(cause as Error).message}，` +
            `不得编造订单状态；请如实告知用户暂时无法查询，建议稍后重试或转人工核实。`,
      };
    }

    if (response.status === 404) {
      return {
        found: false,
        error: "not_found",
        message: `未找到订单 ${normalizedOrderId}，请客户核对订单号。`,
      };
    }

    if (!response.ok) {
      return {
        found: false,
        error: "server_error",
        message: `订单系统查询 ${normalizedOrderId} 失败（HTTP ${response.status}），` +
          `不得编造订单状态；请如实告知用户系统异常，建议稍后重试或转人工核实。`,
      };
    }

    let body: { success?: boolean; data?: Record<string, unknown> };
    try {
      body = (await response.json()) as { success?: boolean; data?: Record<string, unknown> };
    } catch {
      return {
        found: false,
        error: "server_error",
        message: `订单系统返回了无法解析的响应，不得编造订单状态；请如实告知用户系统异常，建议稍后重试或转人工核实。`,
      };
    }

    if (!body.data || typeof body.data !== "object") {
      return {
        found: false,
        error: "server_error",
        message: `订单系统响应缺少订单数据字段，不得编造订单状态；请如实告知用户系统异常，建议稍后重试或转人工核实。`,
      };
    }

    const missingFields = computeMissingFields(body.data);
    if (missingFields.length > 0) {
      return {
        found: true,
        partial: true,
        order: body.data,
        missingFields,
        message:
          `订单 ${normalizedOrderId} 存在，但系统未提供以下字段：${missingFields.join("、")}。` +
          `只能说明已知字段，不得把这个部分结果当作完整结果处理，也不得编造缺失字段的内容。`,
      };
    }

    return {
      found: true,
      partial: false,
      order: body.data,
    };
  },
});
