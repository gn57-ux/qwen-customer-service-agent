import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LeftSidebar } from "./LeftSidebar.tsx";
import type { Session } from "../session.ts";

afterEach(() => {
  cleanup();
});

function sessions(): Session[] {
  return [
    { id: "a", title: "冰箱到货后需要静置多久这是一个非常长的会话标题用来测试截断", messages: [] },
    { id: "b", title: "电视开机后黑屏", messages: [] },
  ];
}

describe("LeftSidebar", () => {
  it("固定宽度 220px 且不被压缩（AC-007 前置：flex-shrink-0）", () => {
    const { container } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("w-[220px]");
    expect(aside.className).toContain("flex-shrink-0");
  });

  it("激活项具备左侧竖条 + bold（AC-007），非激活项无该样式", () => {
    const { getByText } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    const active = getByText(sessions()[0]!.title);
    const inactive = getByText(sessions()[1]!.title);
    expect(active.className).toContain("border-l-2");
    expect(active.className).toContain("font-bold");
    expect(inactive.className).not.toContain("border-l-2");
  });

  it("长标题项使用 truncate 防止撑破宽度（AC-008）", () => {
    const { getByText } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    expect(getByText(sessions()[0]!.title).className).toContain("truncate");
  });

  it("底部固定文案存在", () => {
    const { getByText } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    expect(getByText("本地运行 · 数据不会离开当前设备")).toBeTruthy();
  });

  it("点击会话项触发 onSelect，点击新建会话触发 onNewSession", () => {
    const onSelect = vi.fn();
    const onNewSession = vi.fn();
    const { getByText, getByRole } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={onSelect} onNewSession={onNewSession} />,
    );
    fireEvent.click(getByText(sessions()[1]!.title));
    expect(onSelect).toHaveBeenCalledWith("b");

    fireEvent.click(getByRole("button", { name: /新建会话/ }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it("会话项是可键盘聚焦/激活的 <button>（键盘与屏幕阅读器可操作）", () => {
    const { getByRole } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    const active = getByRole("button", { name: sessions()[0]!.title });
    expect(active.tagName).toBe("BUTTON");
    expect(active.getAttribute("aria-current")).toBe("true");

    const inactive = getByRole("button", { name: sessions()[1]!.title });
    expect(inactive.getAttribute("aria-current")).toBeNull();
  });

  it("容器可滚动但滚动条隐藏（overflow-y-auto no-scrollbar）（AC-009）", () => {
    const { container } = render(
      <LeftSidebar sessions={sessions()} activeId="a" onSelect={() => {}} onNewSession={() => {}} />,
    );
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("overflow-y-auto");
    expect(aside.className).toContain("no-scrollbar");
  });
});
