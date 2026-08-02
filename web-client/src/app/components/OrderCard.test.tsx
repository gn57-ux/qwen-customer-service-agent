import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrderCard } from "./OrderCard.tsx";
import type { OrderDetails, OrderStatus } from "../../types.ts";

afterEach(() => {
  cleanup();
});

function fullDetails(overrides: Partial<OrderDetails> = {}): OrderDetails {
  return {
    orderId: "ORD1002",
    status: "shipped",
    statusText: "已发货",
    createdAt: "2026-07-20",
    carrier: "顺丰速运",
    trackingNumber: "SF1234567890",
    latestLogistics: "已到达本地转运中心",
    estimatedDelivery: "2026-07-25",
    canCancel: false,
    customerTip: "包裹已发出，无法取消",
    ...overrides,
  };
}

describe("OrderCard", () => {
  it("成功态：完整字段全部展示，左边框 success-green（AC-002a）", () => {
    const order: OrderStatus = { found: true, details: fullDetails() };
    const { container, getByText } = render(<OrderCard order={order} />);

    expect(getByText("ORD1002")).toBeTruthy();
    expect(getByText("已发货")).toBeTruthy();
    expect(getByText("2026-07-20")).toBeTruthy();
    expect(getByText("顺丰速运")).toBeTruthy();
    expect(getByText("SF1234567890")).toBeTruthy();
    expect(getByText("已到达本地转运中心")).toBeTruthy();
    expect(getByText("2026-07-25")).toBeTruthy();
    expect(getByText("否")).toBeTruthy();
    expect(getByText("包裹已发出，无法取消")).toBeTruthy();

    const card = container.firstElementChild!;
    expect(card.className).toContain("border-l-success-green");
  });

  it("部分缺失：展示缺失字段提示，且缺失字段对应行隐藏（AC-002b，ORD1001 场景）", () => {
    const order: OrderStatus = {
      found: true,
      partial: true,
      missingFields: ["carrier", "trackingNumber"],
      details: fullDetails({ carrier: null, trackingNumber: null }),
    };
    const { queryByText, getByText } = render(<OrderCard order={order} />);

    expect(getByText("部分信息缺失：carrier、trackingNumber")).toBeTruthy();
    expect(queryByText("顺丰速运")).toBeNull();
    expect(queryByText("SF1234567890")).toBeNull();
    // 未缺失的字段仍正常展示
    expect(getByText("ORD1002")).toBeTruthy();
  });

  it("canCancel 为 null 时该行隐藏，不得当作 false（关键防坑：不确定≠不能取消）", () => {
    const order: OrderStatus = { found: true, details: fullDetails({ canCancel: null }) };
    const { queryByText } = render(<OrderCard order={order} />);
    expect(queryByText("否")).toBeNull();
    expect(queryByText("是")).toBeNull();
  });

  it("canCancel 为 true 时展示「是」", () => {
    const order: OrderStatus = { found: true, details: fullDetails({ canCancel: true }) };
    const { getByText } = render(<OrderCard order={order} />);
    expect(getByText("是")).toBeTruthy();
  });

  it("statusText 为空时回落展示 status；两者皆空时该行隐藏", () => {
    const withStatusOnly = render(
      <OrderCard order={{ found: true, details: fullDetails({ statusText: null, status: "shipped" }) }} />,
    );
    expect(withStatusOnly.getByText("shipped")).toBeTruthy();
    withStatusOnly.unmount();

    const withNeither = render(
      <OrderCard order={{ found: true, details: fullDetails({ statusText: null, status: null }) }} />,
    );
    expect(withNeither.queryByText(/^(shipped|已发货)$/)).toBeNull();
  });

  it("details 为 undefined 时只渲染状态卡，不渲染详情区（AC-002c）", () => {
    const order: OrderStatus = { found: true };
    const { container } = render(<OrderCard order={order} />);
    expect(container.querySelector("dl")).toBeNull();
  });

  it.each([
    ["not_found", "订单不存在，请核对订单号", false],
    ["timeout", "订单服务响应超时", true],
    ["server_error", "订单服务异常，请稍后再试", false],
    ["network_error", "网络异常，无法连接订单服务", true],
  ] as const)("error=%s 展示对应文案，retryable=%s 时才出现重试按钮（AC-001）", (error, text, retryable) => {
    const onRetry = vi.fn();
    const order: OrderStatus = { found: false, error };
    const { getByText, queryByRole, getByRole } = render(<OrderCard order={order} onRetry={onRetry} />);
    expect(getByText(text)).toBeTruthy();

    if (retryable) {
      const button = getByRole("button", { name: /重试/ });
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledOnce();
    } else {
      expect(queryByRole("button", { name: /重试/ })).toBeNull();
    }
  });

  it("error 态下即使 retryable 但未传 onRetry，也不渲染重试按钮", () => {
    const order: OrderStatus = { found: false, error: "timeout" };
    const { queryByRole } = render(<OrderCard order={order} />);
    expect(queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
