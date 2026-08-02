import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EvidenceFooter } from "./EvidenceFooter.tsx";

afterEach(() => {
  cleanup();
});

describe("EvidenceFooter", () => {
  it("有数据时展示 traceId 与耗时", () => {
    const { getByText } = render(<EvidenceFooter traceId="TRACE-A84F21" latencyText="2.8s" />);
    expect(getByText("TRACE-A84F21")).toBeTruthy();
    expect(getByText("2.8s")).toBeTruthy();
  });

  it("无数据时两侧都显示「—」（AC-010）", () => {
    const { getAllByText } = render(<EvidenceFooter />);
    expect(getAllByText("—")).toHaveLength(2);
  });
});
