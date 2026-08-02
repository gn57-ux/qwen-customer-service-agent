import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepTimeline } from "./StepTimeline.tsx";

afterEach(() => {
  cleanup();
});

describe("StepTimeline", () => {
  it("空数组时展示占位文案，不渲染 ul", () => {
    const { getByText, container } = render(<StepTimeline steps={[]} emptyText="暂无处理记录" />);
    expect(getByText("暂无处理记录")).toBeTruthy();
    expect(container.querySelector("ul")).toBeNull();
  });

  it("按 tone 渲染节点圆点颜色，safety 节点加粗", () => {
    const { container, getByText } = render(
      <StepTimeline
        steps={[
          { label: "已识别 · 安全咨询", tone: "success" },
          { label: "已召回 · 3 个候选片段", tone: "brand" },
          { label: "已触发 · 安全策略", tone: "safety", bold: true },
        ]}
        emptyText="占位"
      />,
    );
    expect(container.querySelector("span.bg-success-green")).toBeTruthy();
    expect(container.querySelector("span.bg-brand-primary")).toBeTruthy();
    expect(container.querySelector("span.bg-safety-text")).toBeTruthy();
    expect(getByText("已触发 · 安全策略").className).toContain("font-bold");
  });

  it("圆点不额外写 rounded-* 类（0 圆角由全局样式保证）", () => {
    const { container } = render(
      <StepTimeline steps={[{ label: "已生成", tone: "brand" }]} emptyText="占位" />,
    );
    const dot = container.querySelector("span.bg-brand-primary")!;
    expect(dot.className).not.toMatch(/rounded/);
  });

  it("同一 label 重复出现（工具被重复调用）时，每个节点独立渲染，不触发 React 重复 key 警告（Codex Review P2）", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, getAllByText } = render(
      <StepTimeline
        steps={[
          { label: "已调用 · 订单服务", tone: "success" },
          { label: "已调用 · 订单服务", tone: "success" },
          { label: "已调用 · 订单服务", tone: "success" },
        ]}
        emptyText="占位"
      />,
    );

    expect(getAllByText("已调用 · 订单服务")).toHaveLength(3);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    const duplicateKeyWarning = consoleError.mock.calls.some((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("key")),
    );
    expect(duplicateKeyWarning).toBe(false);
    consoleError.mockRestore();
  });
});
