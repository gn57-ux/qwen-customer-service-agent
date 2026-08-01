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

  it("样式符合 Stitch v2 规格：独立任意值配色 + 12px 圆角 + 3px 左强调边框", () => {
    const { container } = render(<SafetyCard text="文本" />);
    const card = container.firstElementChild!;
    expect(card.className).toContain("border-[#F2C5BE]");
    expect(card.className).toContain("bg-[#FDF5F3]");
    expect(card.className).toContain("rounded-[12px]");
    expect(card.className).toContain("border-l-[3px]");
    expect(card.className).toContain("border-l-[#C55B51]");
  });
});
