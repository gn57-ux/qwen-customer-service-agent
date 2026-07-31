import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UserBubble } from "./UserBubble.tsx";

afterEach(() => {
  cleanup();
});

describe("UserBubble", () => {
  it("右对齐气泡渲染文本内容（F-003）", () => {
    const { container, getByText } = render(<UserBubble content="冰箱不制冷怎么办" />);
    expect(container.querySelector(".justify-end")).toBeTruthy();
    expect(getByText("冰箱不制冷怎么办")).toBeTruthy();
  });
});
