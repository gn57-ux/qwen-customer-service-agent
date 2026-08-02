import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceList } from "./SourceList.tsx";
import { citationElementId } from "../citation.ts";

afterEach(() => {
  cleanup();
});

describe("SourceList", () => {
  it("空列表时展示「本次回答未引用知识库」占位文案（AC-010）", () => {
    const { getByText } = render(<SourceList sources={[]} emptyText="本次回答未引用知识库" />);
    expect(getByText("本次回答未引用知识库")).toBeTruthy();
  });

  it("渲染标题与元信息，高优项追加标记，边框色按 tone 区分", () => {
    const { container, getByText } = render(
      <SourceList
        sources={[
          { title: "冰箱常见故障排查", meta: "DOC-8821 · v3", highlighted: false, tone: "brand" },
          { title: "家电维修安全规范", meta: "DOC-9904 · v1", highlighted: true, tone: "safety" },
        ]}
        emptyText="占位"
      />,
    );
    expect(getByText("冰箱常见故障排查")).toBeTruthy();
    expect(getByText(/DOC-8821 · v3/)).toBeTruthy();
    expect(getByText(/DOC-9904 · v1/).textContent).toContain("高优");

    const buttons = container.querySelectorAll("button");
    expect(buttons[0]!.className).toContain("border-l-brand-primary");
    // Stitch v2 起高优先级左边框改用 #C55B51（与 SafetyCard 一致），不再是 safety-text token。
    expect(buttons[1]!.className).toContain("border-l-[#C55B51]");
  });

  it("点击某一项会滚动定位到 messageId 对应的引用角标（Codex Review P2：解决之前只有视觉没有行为的问题）", () => {
    const scrollIntoView = vi.fn();
    // jsdom 没有实现 scrollIntoView，手动打桩到 Element.prototype 上
    Element.prototype.scrollIntoView = scrollIntoView;
    const anchor = document.createElement("div");
    anchor.id = citationElementId("msg-1", 1);
    document.body.appendChild(anchor);

    const { getByText } = render(
      <SourceList
        messageId="msg-1"
        sources={[
          { title: "A", meta: "f1 · v1", highlighted: false, tone: "brand" },
          { title: "B", meta: "f2 · v1", highlighted: false, tone: "brand" },
        ]}
        emptyText="占位"
      />,
    );

    fireEvent.click(getByText("B"));
    expect(scrollIntoView).toHaveBeenCalledOnce();

    anchor.remove();
  });

  it("没有 messageId（如仍在流式中）时点击不报错，按钮 disabled", () => {
    const { getByText } = render(
      <SourceList
        sources={[{ title: "A", meta: "f1 · v1", highlighted: false, tone: "brand" }]}
        emptyText="占位"
      />,
    );
    const button = getByText("A").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});
