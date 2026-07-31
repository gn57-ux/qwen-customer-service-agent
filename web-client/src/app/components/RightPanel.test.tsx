import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RightPanel } from "./RightPanel.tsx";
import { citationElementId } from "../citation.ts";
import type { AssistantTurn } from "../chat-types.ts";
import type { ChatResponseBody } from "../../types.ts";

afterEach(() => {
  cleanup();
});

function doneBody(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    reply: "占位",
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "trace-1",
    latencyMs: 1000,
    ...overrides,
  };
}

describe("RightPanel", () => {
  it("宽度 300px（xl 320px）、断点 min-[1100px]（AC-001，⛔ 不是 lg/1024）", () => {
    const { container } = render(<RightPanel />);
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("min-[1100px]:flex");
    expect(aside.className).toContain("w-[300px]");
    expect(aside.className).toContain("xl:w-[320px]");
    expect(aside.className).not.toMatch(/\blg:/);
  });

  it("内容区字体为 JetBrains Mono（AC-002）", () => {
    const { container } = render(
      <RightPanel turn={{ phase: "done", text: "", toolCalls: [], body: doneBody() }} />,
    );
    expect(container.querySelector(".font-code")).toBeTruthy();
  });

  it("没有任何 AI 消息时展示整体空状态，traceId/耗时为 —（AC-010）", () => {
    const { getByText, getAllByText } = render(<RightPanel />);
    expect(getByText("暂无处理记录，发送问题后展示执行链路")).toBeTruthy();
    expect(getAllByText("—")).toHaveLength(2);
  });

  it("流式期间只展示 tool-result 累积的临时节点，不出现回答模式卡/引用来源（AC-011）", () => {
    const turn: AssistantTurn = {
      phase: "streaming",
      traceId: "trace-live",
      text: "生成中",
      toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
    };
    const { getByText, queryByText } = render(<RightPanel turn={turn} />);
    expect(getByText("已调用 · 维修知识库")).toBeTruthy();
    expect(queryByText("回答模式")).toBeNull();
    expect(queryByText("引用来源")).toBeNull();
  });

  it("done 后用结构化 body 全量覆盖，出现回答模式卡与引用来源（AC-011）", () => {
    const turn: AssistantTurn = {
      phase: "done",
      traceId: "trace-1",
      text: "",
      toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
      body: doneBody({
        route: "safety",
        toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
        // 故意用非 20/5 的构造值——门禁 6（gate-no-hardcoded-count.sh）按文案
        // 正则扫描召回/重排计数，若测试也写 20/5 会把真实来源于字段的正确实现
        // 跟"凑巧写死 20/5"混为一谈，不足以证明数值确实来自 retrievedCount/
        // returnedCount 字段而非硬编码（design.md 模块 2 的補偿手段）。
        retrievedCount: 17,
        returnedCount: 3,
        reranked: true,
        traceId: "TRACE-A84F21",
        latencyMs: 2800,
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
    };
    const { getByText } = render(<RightPanel turn={turn} />);

    expect(getByText("已识别 · 安全咨询")).toBeTruthy();
    expect(getByText("已召回 · 17 个候选片段")).toBeTruthy();
    expect(getByText("重排完成 · Top 3")).toBeTruthy();
    expect(getByText("已触发 · 安全策略")).toBeTruthy();
    expect(getByText("回答模式")).toBeTruthy();
    expect(getByText("安全策略介入")).toBeTruthy();
    expect(getByText("冰箱常见故障排查")).toBeTruthy();
    expect(getByText("TRACE-A84F21")).toBeTruthy();
    expect(getByText("2.8s")).toBeTruthy();
  });

  it("degraded: true 时展示「降级运行」chip 与原因，不影响本组件之外的任何状态（AC-008）", () => {
    const turn: AssistantTurn = {
      phase: "done",
      text: "",
      toolCalls: [],
      body: doneBody({ degraded: true, degradedReason: "本地模型响应超时" }),
    };
    const { getByText } = render(<RightPanel turn={turn} />);
    expect(getByText("降级运行")).toBeTruthy();
    expect(getByText("本地模型响应超时")).toBeTruthy();
  });

  it("sources 为空时引用来源区展示占位文案（AC-010）", () => {
    const turn: AssistantTurn = { phase: "done", text: "", toolCalls: [], body: doneBody() };
    const { getByText } = render(<RightPanel turn={turn} />);
    expect(getByText("本次回答未引用知识库")).toBeTruthy();
  });

  it("messageId 透传给 SourceList，点击引用来源项真的会滚动定位（Codex Review P2）", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const anchor = document.createElement("div");
    anchor.id = citationElementId("msg-99", 0);
    document.body.appendChild(anchor);

    const turn: AssistantTurn = {
      phase: "done",
      text: "",
      toolCalls: [],
      body: doneBody({
        sources: [
          {
            title: "冰箱常见故障排查",
            section: "不制冷",
            sourceFile: "DOC-8821",
            documentVersion: "v3",
            vectorScore: 0.9,
            rerankScore: null,
          },
        ],
      }),
    };
    const { getByText } = render(<RightPanel turn={turn} messageId="msg-99" />);
    fireEvent.click(getByText("冰箱常见故障排查"));
    expect(scrollIntoView).toHaveBeenCalledOnce();

    anchor.remove();
  });

  it("error 收尾时右栏保留已收到节点并追加红色「已中断 · 生成失败」（F-008/AC-007）", () => {
    const turn: AssistantTurn = {
      phase: "error",
      text: "已生成的部分",
      errorMessage: "上游服务异常",
      toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
    };
    const { getByText, container } = render(<RightPanel turn={turn} />);
    expect(getByText("已调用 · 维修知识库")).toBeTruthy();
    const interrupted = getByText("已中断 · 生成失败");
    expect(interrupted).toBeTruthy();
    expect(interrupted.className).toContain("font-bold");
    expect(container.querySelector("span.bg-safety-text")).toBeTruthy();
  });

  it("aborted 收尾时不追加「已中断」节点，只保留已有的 tool-result 节点", () => {
    const turn: AssistantTurn = {
      phase: "aborted",
      text: "部分回答",
      toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
    };
    const { getByText, queryByText } = render(<RightPanel turn={turn} />);
    expect(getByText("已调用 · 维修知识库")).toBeTruthy();
    expect(queryByText("已中断 · 生成失败")).toBeNull();
  });
});
