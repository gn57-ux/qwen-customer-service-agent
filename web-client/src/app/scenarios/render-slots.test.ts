import { describe, expect, it } from "vitest";

import { resolveSlots } from "./render-slots.ts";
import type { ChatResponseBody } from "../../types.ts";

function baseBody(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    reply: "占位",
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "t1",
    latencyMs: 1,
    ...overrides,
  };
}

describe("resolveSlots", () => {
  it("route=safety 时 safetyCard 恒为 true，即便没有工具调用", () => {
    expect(resolveSlots(baseBody({ route: "safety" })).safetyCard).toBe(true);
  });

  it("非 safety 时 safetyCard 为 false", () => {
    expect(resolveSlots(baseBody({ route: "repair" })).safetyCard).toBe(false);
  });

  it("route=order 但未调用 queryOrderTool（追问场景）时 orderCard 为 false（F-002/AC-002）", () => {
    const view = resolveSlots(baseBody({ route: "order", toolCalls: [], order: undefined }));
    expect(view.orderCard).toBe(false);
  });

  it("route=order 调用了 queryOrderTool 但 order 字段缺失时仍为 false（双条件）", () => {
    const view = resolveSlots(
      baseBody({
        route: "order",
        toolCalls: [{ name: "queryOrderTool", arguments: {}, result: {} }],
        order: undefined,
      }),
    );
    expect(view.orderCard).toBe(false);
  });

  it("route=order 且调用了 queryOrderTool 且 order 存在时 orderCard 为 true", () => {
    const view = resolveSlots(
      baseBody({
        route: "order",
        toolCalls: [{ name: "queryOrderTool", arguments: {}, result: {} }],
        order: { found: true },
      }),
    );
    expect(view.orderCard).toBe(true);
  });

  it("非 order route 即便恰好带 queryOrderTool 调用与 order 字段也不渲染订单卡（Codex Review P2：三条件缺一不可）", () => {
    const view = resolveSlots(
      baseBody({
        route: "safety",
        toolCalls: [{ name: "queryOrderTool", arguments: {}, result: {} }],
        order: { found: true },
      }),
    );
    expect(view.orderCard).toBe(false);
  });

  it("route=general 时 citations 恒为 false，即便 sources 非空（F-005）", () => {
    const view = resolveSlots(
      baseBody({
        route: "general",
        sources: [
          {
            title: "A",
            section: "",
            sourceFile: "f",
            documentVersion: "v1",
            vectorScore: 0.1,
            rerankScore: null,
          },
        ],
      }),
    );
    expect(view.citations).toBe(false);
  });

  it("非 general 且 sources 非空时 citations 为 true；sources 为空时为 false（F-003/AC-005）", () => {
    const withSources = resolveSlots(
      baseBody({
        route: "repair",
        sources: [
          {
            title: "A",
            section: "",
            sourceFile: "f",
            documentVersion: "v1",
            vectorScore: 0.1,
            rerankScore: null,
          },
        ],
      }),
    );
    expect(withSources.citations).toBe(true);

    const withoutSources = resolveSlots(baseBody({ route: "repair", sources: [] }));
    expect(withoutSources.citations).toBe(false);
  });
});
