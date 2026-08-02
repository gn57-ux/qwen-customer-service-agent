import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./ChatHeader.tsx";

afterEach(() => {
  cleanup();
});

describe("ChatHeader", () => {
  it("渲染标题、副标题与三枚能力徽章（F-001）", () => {
    const { getByText } = render(<ChatHeader />);
    expect(getByText("家电售后智能客服")).toBeTruthy();
    expect(getByText("可咨询冰箱、彩电、显示器维修问题")).toBeTruthy();
    ["QLoRA", "RAG", "Tools"].forEach((badge) => expect(getByText(badge)).toBeTruthy());
  });

  it("不传 onOpenEvidence 时不渲染处理依据入口", () => {
    const { queryByRole } = render(<ChatHeader />);
    expect(queryByRole("button", { name: "查看处理依据" })).toBeNull();
  });

  it("传入 onOpenEvidence 时渲染入口，可见性为 min-[1100px]:hidden（F-012）", () => {
    const onOpenEvidence = vi.fn();
    const { getByRole } = render(<ChatHeader onOpenEvidence={onOpenEvidence} />);
    const button = getByRole("button", { name: "查看处理依据" });
    expect(button.className).toContain("min-[1100px]:hidden");
    fireEvent.click(button);
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });
});
