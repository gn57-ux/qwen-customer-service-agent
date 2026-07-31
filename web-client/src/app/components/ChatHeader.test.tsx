import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
});
