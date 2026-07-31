import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SafetyCard } from "./SafetyCard.tsx";

afterEach(() => {
  cleanup();
});

describe("SafetyCard", () => {
  it("展示服务端提供的文本，不硬编码话术（F-004）", () => {
    const { getByText, container } = render(
      <SafetyCard text="先不要自行拆机，请联系官方售后。" />,
    );
    expect(getByText("先不要自行拆机，请联系官方售后。")).toBeTruthy();
    expect(container.querySelector(".material-symbols-outlined")?.textContent).toBe("warning");
  });

  it("样式符合规格：safety-border + safety-bg + p-3", () => {
    const { container } = render(<SafetyCard text="文本" />);
    const card = container.firstElementChild!;
    expect(card.className).toContain("border-safety-border");
    expect(card.className).toContain("bg-safety-bg");
    expect(card.className).toContain("p-3");
  });
});
