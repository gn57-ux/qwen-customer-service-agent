import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ModeCard } from "./ModeCard.tsx";

afterEach(() => {
  cleanup();
});

describe("ModeCard", () => {
  it("渲染全部 chip 与图标", () => {
    const { getByText, container } = render(
      <ModeCard
        modes={[
          { label: "本地QLoRA", tone: "neutral" },
          { label: "RAG知识增强", tone: "neutral" },
          { label: "安全策略介入", tone: "safety", icon: "gpp_maybe" },
        ]}
      />,
    );
    expect(getByText("本地QLoRA")).toBeTruthy();
    expect(getByText("RAG知识增强")).toBeTruthy();
    expect(getByText("安全策略介入")).toBeTruthy();
    expect(container.querySelector(".material-symbols-outlined")?.textContent).toBe("gpp_maybe");
  });

  it("degradedReason 存在时展示原因文案（F-008）", () => {
    const { getByText } = render(
      <ModeCard modes={[{ label: "降级运行", tone: "safety", icon: "gpp_maybe" }]} degradedReason="重排服务超时" />,
    );
    expect(getByText("重排服务超时")).toBeTruthy();
  });

  it("degradedReason 不存在时不渲染原因段落", () => {
    const { container } = render(<ModeCard modes={[{ label: "本地QLoRA", tone: "neutral" }]} />);
    expect(container.querySelector("p")).toBeNull();
  });
});
