import { describe, expect, it } from "vitest";

import { deriveOrderView } from "./order-view.ts";
import type { OrderStatus } from "../../types.ts";

describe("deriveOrderView", () => {
  it("found && !partial → ok", () => {
    const order: OrderStatus = { found: true };
    expect(deriveOrderView(order)).toEqual({ kind: "ok" });
  });

  it("found && partial === true → partial，携带 missingFields", () => {
    const order: OrderStatus = { found: true, partial: true, missingFields: ["carrier", "trackingNumber"] };
    expect(deriveOrderView(order)).toEqual({ kind: "partial", missing: ["carrier", "trackingNumber"] });
  });

  it("partial 但 missingFields 缺失时 missing 兜底为空数组", () => {
    const order: OrderStatus = { found: true, partial: true };
    expect(deriveOrderView(order)).toEqual({ kind: "partial", missing: [] });
  });

  it.each([
    ["not_found", "订单不存在，请核对订单号", false],
    ["timeout", "订单服务响应超时", true],
    ["server_error", "订单服务异常，请稍后再试", false],
    ["network_error", "网络异常，无法连接订单服务", true],
  ] as const)("error=%s → text=%s, retryable=%s（AC-001）", (error, text, retryable) => {
    const order: OrderStatus = { found: false, error };
    expect(deriveOrderView(order)).toEqual({ kind: "error", text, retryable });
  });

  it("found:false 且没有 error（契约允许的边界值）不得落到 ok，必须是非成功态（Codex Review P2）", () => {
    const order: OrderStatus = { found: false };
    const view = deriveOrderView(order);
    expect(view.kind).toBe("error");
    expect(view.kind === "error" && view.retryable).toBe(false);
  });
});
