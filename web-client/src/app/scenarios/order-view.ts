/**
 * 订单卡片状态机（design.md 模块 2）。⛔ v1 方案（解析泛型 `toolCalls[].result`）
 * 已作废——详情只读契约层白名单 `order.details`，本文件不接触 `toolCalls`。
 */
import type { OrderStatus } from "../../types.ts";

export type OrderView =
  | { kind: "ok" }
  | { kind: "partial"; missing: string[] }
  | { kind: "error"; text: string; retryable: boolean };

const ORDER_ERROR: Record<NonNullable<OrderStatus["error"]>, { text: string; retryable: boolean }> = {
  // not_found 是确定性结果——换个订单号才有意义，重试无用
  not_found: { text: "订单不存在，请核对订单号", retryable: false },
  // timeout/network_error 是瞬时故障，重试有意义
  timeout: { text: "订单服务响应超时", retryable: true },
  server_error: { text: "订单服务异常，请稍后再试", retryable: false },
  network_error: { text: "网络异常，无法连接订单服务", retryable: true },
};

export function deriveOrderView(order: OrderStatus): OrderView {
  if (order.error) {
    return { kind: "error", ...ORDER_ERROR[order.error] };
  }
  // found 是权威结果，error 只是可选的补充说明——契约允许 found:false 且没带
  // error（防御性分支：正常情况下服务端总会一起给出 error），这种情况绝不能
  // 落到下面的 ok/partial 分支，否则会把"没查到"渲染成一张空的成功卡片
  // （Codex Review P2）。
  if (!order.found) {
    return { kind: "error", text: "未找到订单信息", retryable: false };
  }
  if (order.partial) {
    return { kind: "partial", missing: order.missingFields ?? [] };
  }
  return { kind: "ok" };
}
