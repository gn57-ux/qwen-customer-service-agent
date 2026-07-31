import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Header } from "./Header.tsx";
import type { ServiceState, ServiceStatusBody } from "../../types.ts";

afterEach(() => {
  cleanup();
});

function statusOf(state: ServiceState): ServiceStatusBody {
  return { localModel: state, knowledgeBase: state, orderService: state };
}

const noop = () => {};

describe("Header", () => {
  it("固定顶栏结构：fixed top-0 w-full z-50 h-16（AC-001）", () => {
    const { container } = render(<Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} />);
    const header = container.querySelector("header")!;
    expect(header.className).toContain("fixed");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("w-full");
    expect(header.className).toContain("z-50");
    expect(header.className).toContain("h-16");
  });

  it("副标题使用 JetBrains Mono（font-code），标题使用 Inter（font-h2）（AC-002）", () => {
    const { getByText } = render(<Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} />);
    expect(getByText("智修客服").className).toContain("font-h2");
    expect(getByText("家电售后智能助手").className).toContain("font-code");
  });

  it.each([
    ["unknown", "未知", "bg-text-muted"],
    ["online", "在线", "bg-success-green"],
    ["degraded", "降级", "bg-safety-text"],
    ["error", "异常", "bg-safety-text"],
  ] as const)("四态映射正确：%s → %s / %s（AC-004）", (state, label, dotClass) => {
    const { getByText, container } = render(
      <Header status={statusOf(state)} onClearSession={() => {}} onRetryStatus={noop} />,
    );
    expect(getByText(`本地模型: ${label}`)).toBeTruthy();
    const dots = container.querySelectorAll(`span.${dotClass}`);
    expect(dots.length).toBeGreaterThan(0);
  });

  it("degraded 与 error 状态点同色但文案不同（可访问性：不单靠颜色区分）", () => {
    const degraded = render(<Header status={statusOf("degraded")} onClearSession={() => {}} onRetryStatus={noop} />);
    expect(within(degraded.container).getByText("本地模型: 降级")).toBeTruthy();
    degraded.unmount();

    const error = render(<Header status={statusOf("error")} onClearSession={() => {}} onRetryStatus={noop} />);
    expect(within(error.container).getByText("本地模型: 异常")).toBeTruthy();
  });

  it("状态点为 0 圆角方块（AC-010，由全局 * {border-radius:0} 保证，这里验证未额外写 rounded-*）", () => {
    const { container } = render(<Header status={statusOf("online")} onClearSession={() => {}} onRetryStatus={noop} />);
    const dot = container.querySelector("span.bg-success-green")!;
    expect(dot.className).not.toMatch(/rounded/);
  });

  it("清空会话按钮点击触发回调，图标 18px，文案 hidden md:inline", () => {
    const onClearSession = vi.fn();
    const { getByRole } = render(<Header status={statusOf("unknown")} onClearSession={onClearSession} onRetryStatus={noop} />);
    const button = getByRole("button", { name: /清空会话/ });
    fireEvent.click(button);
    expect(onClearSession).toHaveBeenCalledOnce();

    const icon = button.querySelector(".material-symbols-outlined")!;
    expect(icon.className).toContain("text-[18px]");
    expect(icon.textContent).toBe("delete");

    const label = button.querySelector("span.hidden.md\\:inline")!;
    expect(label.textContent).toBe("清空会话");
  });

  it("移动端清空会话按钮有可访问名称（图标对 AT 隐藏，靠 aria-label 提供名称）", () => {
    const { getByRole } = render(
      <Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} />,
    );
    const button = getByRole("button", { name: "清空会话" });
    const icon = button.querySelector(".material-symbols-outlined")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("点击状态区触发手动重试（F-008 手动刷新入口）", () => {
    const onRetryStatus = vi.fn();
    const { getByRole } = render(
      <Header status={statusOf("error")} onClearSession={() => {}} onRetryStatus={onRetryStatus} />,
    );
    fireEvent.click(getByRole("button", { name: "重新探测服务状态" }));
    expect(onRetryStatus).toHaveBeenCalledOnce();
  });
});
