import { describe, expect, it } from "vitest";

import { deriveEvidence, deriveInterimSteps } from "./derive.ts";
import type { ChatResponseBody } from "../../types.ts";

function baseBody(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    reply: "占位回复——推导层不应该读这个字段",
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "trace-1",
    latencyMs: 1234,
    ...overrides,
  };
}

describe("deriveEvidence", () => {
  it("route=general 且无工具调用：只有「已识别」+「已生成」两个节点（design.md 回归场景）", () => {
    const view = deriveEvidence(baseBody({ route: "general" }));
    expect(view.steps).toEqual([
      { label: "已识别 · 一般咨询", tone: "success" },
      { label: "已生成", tone: "brand" },
    ]);
    expect(view.modes).toEqual([{ label: "本地QLoRA", tone: "neutral" }]);
    expect(view.sources).toEqual([]);
  });

  it.each([
    ["safety", "安全咨询"],
    ["order", "订单查询"],
    ["repair", "维修排查"],
    ["general", "一般咨询"],
  ] as const)("route=%s 映射为「已识别 · %s」", (route, label) => {
    const view = deriveEvidence(baseBody({ route }));
    expect(view.steps[0]).toEqual({ label: `已识别 · ${label}`, tone: "success" });
  });

  it("route=safety 追加安全节点（safety 色 + bold）与「安全策略介入」chip（AC-006）", () => {
    const view = deriveEvidence(baseBody({ route: "safety" }));
    expect(view.steps.at(-1)).toEqual({ label: "已触发 · 安全策略", tone: "safety", bold: true });
    expect(view.modes).toContainEqual({ label: "安全策略介入", tone: "safety", icon: "gpp_maybe" });
  });

  it("toolCalls 每个工具生成一个「已调用」节点，未知工具名原样透传", () => {
    const view = deriveEvidence(
      baseBody({
        toolCalls: [
          { name: "searchKnowledgeBase", arguments: {}, result: {} },
          { name: "queryOrderTool", arguments: {}, result: {} },
          { name: "someFutureTool", arguments: {}, result: {} },
        ],
      }),
    );
    expect(view.steps).toContainEqual({ label: "已调用 · 维修知识库", tone: "success" });
    expect(view.steps).toContainEqual({ label: "已调用 · 订单服务", tone: "success" });
    expect(view.steps).toContainEqual({ label: "已调用 · someFutureTool", tone: "success" });
  });

  it("retrievedCount === 0 时不渲染「已召回」节点（AC-005），且不硬编码 20", () => {
    const view = deriveEvidence(baseBody({ retrievedCount: 0 }));
    expect(view.steps.some((s) => s.label.includes("已召回"))).toBe(false);
  });

  it("retrievedCount > 0 时渲染「已召回 · N 个候选片段」，N 取自字段本身", () => {
    const view = deriveEvidence(baseBody({ retrievedCount: 7 }));
    expect(view.steps).toContainEqual({ label: "已召回 · 7 个候选片段", tone: "brand" });
  });

  it("reranked !== true 时不渲染「重排完成」节点，即便 returnedCount 有值（AC-004）", () => {
    const view = deriveEvidence(baseBody({ retrievedCount: 10, returnedCount: 5, reranked: false }));
    expect(view.steps.some((s) => s.label.includes("重排完成"))).toBe(false);
  });

  it("reranked === true 时渲染「重排完成 · Top N」，N 取自 returnedCount，不硬编码 5", () => {
    const view = deriveEvidence(baseBody({ retrievedCount: 10, returnedCount: 3, reranked: true }));
    expect(view.steps).toContainEqual({ label: "重排完成 · Top 3", tone: "brand" });
  });

  it("sources 非空时出现「RAG知识增强」chip", () => {
    const view = deriveEvidence(
      baseBody({
        sources: [
          {
            title: "冰箱常见故障排查",
            section: "不制冷",
            sourceFile: "DOC-8821",
            documentVersion: "v3",
            vectorScore: 0.9,
            rerankScore: 0.95,
          },
        ],
      }),
    );
    expect(view.modes).toContainEqual({ label: "RAG知识增强", tone: "neutral" });
  });

  it("degraded === true 追加「降级运行」chip 并展示 degradedReason（默认文案兜底）", () => {
    const withReason = deriveEvidence(baseBody({ degraded: true, degradedReason: "重排服务超时" }));
    expect(withReason.modes).toContainEqual({ label: "降级运行", tone: "safety", icon: "gpp_maybe" });
    expect(withReason.degradedReason).toBe("重排服务超时");

    const withoutReason = deriveEvidence(baseBody({ degraded: true }));
    expect(withoutReason.degradedReason).toBe("未提供降级原因");

    const notDegraded = deriveEvidence(baseBody({ degraded: false }));
    expect(notDegraded.degradedReason).toBeUndefined();
  });

  it("「高优」只判给 reranked===true 且 rerankScore 最大的那一项（AC-007）", () => {
    const view = deriveEvidence(
      baseBody({
        route: "general",
        reranked: true,
        sources: [
          { title: "A", section: "", sourceFile: "f1", documentVersion: "v1", vectorScore: 0.5, rerankScore: 0.8 },
          { title: "B", section: "", sourceFile: "f2", documentVersion: "v1", vectorScore: 0.6, rerankScore: 0.95 },
          { title: "C", section: "", sourceFile: "f3", documentVersion: "v1", vectorScore: 0.4, rerankScore: null },
        ],
      }),
    );
    expect(view.sources.map((s) => s.highlighted)).toEqual([false, true, false]);
    expect(view.sources.map((s) => s.tone)).toEqual(["brand", "brand", "brand"]);
  });

  it("reranked===false 时全部 rerankScore 为 null（边界），没有任何一项被标为高优", () => {
    const view = deriveEvidence(
      baseBody({
        reranked: false,
        sources: [
          { title: "A", section: "", sourceFile: "f1", documentVersion: "v1", vectorScore: 0.5, rerankScore: null },
          { title: "B", section: "", sourceFile: "f2", documentVersion: "v1", vectorScore: 0.6, rerankScore: null },
        ],
      }),
    );
    expect(view.sources.every((s) => !s.highlighted)).toBe(true);
  });

  it("route===safety 时高优项左边框为 safety 色，其余为 brand（F-011）", () => {
    const view = deriveEvidence(
      baseBody({
        route: "safety",
        reranked: true,
        sources: [
          { title: "A", section: "", sourceFile: "f1", documentVersion: "v1", vectorScore: 0.5, rerankScore: 0.6 },
          { title: "B", section: "", sourceFile: "f2", documentVersion: "v1", vectorScore: 0.5, rerankScore: 0.9 },
        ],
      }),
    );
    expect(view.sources.map((s) => s.tone)).toEqual(["brand", "safety"]);
  });

  it("rerankScore 并列最高时只有一项被判高优，取第一个达到最大值的下标（Codex Review P2）", () => {
    const view = deriveEvidence(
      baseBody({
        route: "general",
        reranked: true,
        sources: [
          { title: "A", section: "", sourceFile: "f1", documentVersion: "v1", vectorScore: 0.5, rerankScore: 0.9 },
          { title: "B", section: "", sourceFile: "f2", documentVersion: "v1", vectorScore: 0.6, rerankScore: 0.9 },
          { title: "C", section: "", sourceFile: "f3", documentVersion: "v1", vectorScore: 0.4, rerankScore: 0.5 },
        ],
      }),
    );
    expect(view.sources.map((s) => s.highlighted)).toEqual([true, false, false]);
    expect(view.sources.filter((s) => s.highlighted)).toHaveLength(1);
  });

  it("sources 为空数组时不产生任何来源项", () => {
    const view = deriveEvidence(baseBody({ sources: [] }));
    expect(view.sources).toEqual([]);
  });

  it("底部栏格式化：traceId 原样透传，latencyMs 转为 x.xs（AC-009）", () => {
    const view = deriveEvidence(baseBody({ traceId: "trace-abc", latencyMs: 2800 }));
    expect(view.traceId).toBe("trace-abc");
    expect(view.latencyText).toBe("2.8s");
  });
});

describe("deriveInterimSteps", () => {
  it("空 toolCalls 时返回空数组（流式尚未收到 tool-result）", () => {
    expect(deriveInterimSteps([])).toEqual([]);
  });

  it("每个 tool-result 事件转为一个「已调用」节点，按到达顺序排列（AC-011）", () => {
    const steps = deriveInterimSteps([
      { name: "searchKnowledgeBase", arguments: {}, result: {} },
      { name: "queryOrderTool", arguments: {}, result: {} },
    ]);
    expect(steps).toEqual([
      { label: "已调用 · 维修知识库", tone: "success" },
      { label: "已调用 · 订单服务", tone: "success" },
    ]);
  });
});
