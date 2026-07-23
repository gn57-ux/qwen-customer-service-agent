import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const mockBackendUrl =
  process.env.MOCK_BACKEND_URL ?? "http://127.0.0.1:8001";

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
    order: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ orderId }) => {
    const normalizedOrderId = orderId.trim().toUpperCase();
    const response = await fetch(
      `${mockBackendUrl}/api/orders/${encodeURIComponent(normalizedOrderId)}`,
    );

    if (response.status === 404) {
      return {
        found: false,
        message: `未找到订单 ${normalizedOrderId}，请客户核对订单号。`,
      };
    }

    if (!response.ok) {
      throw new Error(`订单后端请求失败，HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };

    return {
      found: true,
      order: body.data,
    };
  },
});
