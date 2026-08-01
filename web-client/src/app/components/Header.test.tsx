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
  it("顶栏结构：Stitch v2 起改为主容器 flex 流内的毛玻璃顶栏（不再 fixed），w-full z-50 h-16 shrink-0", () => {
    const { container } = render(<Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} />);
    const header = container.querySelector("header")!;
    // 不再 fixed/top-0——顶栏现在是主容器（App.tsx 的悬浮卡片 div）flex 流
    // 里的第一个子元素，跟随主容器一起留白/圆角/阴影，而不是独立铺满视口。
    expect(header.className).not.toContain("fixed");
    expect(header.className).toContain("w-full");
    expect(header.className).toContain("z-50");
    expect(header.className).toContain("h-16");
    expect(header.className).toContain("shrink-0");
    // Stitch v2 毛玻璃质感：半透明背景 + 模糊 + 60% 透明度底边框。
    expect(header.className).toContain("bg-content-bg/80");
    expect(header.className).toContain("backdrop-blur-md");
    expect(header.className).toContain("border-border-color/60");
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

  it("Stitch v2 起状态点为圆形（w-1.5 h-1.5 rounded-full），在线态额外带 glow-green 辉光", () => {
    const online = render(<Header status={statusOf("online")} onClearSession={() => {}} onRetryStatus={noop} />);
    const onlineDot = online.container.querySelector("span.bg-success-green")!;
    expect(onlineDot.className).toContain("rounded-full");
    expect(onlineDot.className).toContain("w-1.5");
    expect(onlineDot.className).toContain("glow-green");
    online.unmount();

    // 非在线态不带辉光——辉光语义是"一切正常"，不该出现在异常/未知状态上。
    const degraded = render(<Header status={statusOf("degraded")} onClearSession={() => {}} onRetryStatus={noop} />);
    const degradedDot = degraded.container.querySelector("span.bg-safety-text")!;
    expect(degradedDot.className).not.toContain("glow-green");
  });

  it("清空会话按钮点击触发回调，图标 20px，文案 hidden md:inline", () => {
    const onClearSession = vi.fn();
    const { getByRole } = render(<Header status={statusOf("unknown")} onClearSession={onClearSession} onRetryStatus={noop} />);
    const button = getByRole("button", { name: /清空会话/ });
    fireEvent.click(button);
    expect(onClearSession).toHaveBeenCalledOnce();

    const icon = button.querySelector(".material-symbols-outlined")!;
    expect(icon.className).toContain("text-[20px]");
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

  it("不传 onOpenSessions 时不渲染菜单入口", () => {
    const { queryByRole } = render(<Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} />);
    expect(queryByRole("button", { name: "打开会话列表" })).toBeNull();
  });

  it("传入 onOpenSessions 时渲染菜单入口，可见性为 md:hidden（F-013）", () => {
    const onOpenSessions = vi.fn();
    const { getByRole } = render(
      <Header status={statusOf("unknown")} onClearSession={() => {}} onRetryStatus={noop} onOpenSessions={onOpenSessions} />,
    );
    const button = getByRole("button", { name: "打开会话列表" });
    expect(button.className).toContain("md:hidden");
    fireEvent.click(button);
    expect(onOpenSessions).toHaveBeenCalledOnce();
  });
});
