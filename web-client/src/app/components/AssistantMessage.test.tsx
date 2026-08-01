import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantMessage } from "./AssistantMessage.tsx";
import type { AssistantTurn } from "../chat-types.ts";
import type { ChatResponseBody, OrderStatus } from "../../types.ts";

afterEach(() => {
  cleanup();
});

function turnOf(overrides: Partial<AssistantTurn>): AssistantTurn {
  return { phase: "streaming", text: "", toolCalls: [], ...overrides };
}

function doneBody(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    reply: "占位回复",
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "t1",
    latencyMs: 1,
    ...overrides,
  };
}

function doneTurn(overrides: Partial<ChatResponseBody> = {}): AssistantTurn {
  return { phase: "done", text: "", toolCalls: [], body: doneBody(overrides) };
}

describe("AssistantMessage", () => {
  it("streaming 阶段展示累积的 text，不展示操作行", () => {
    const { getByText, queryByRole } = render(
      <AssistantMessage messageId="m1" turn={turnOf({ phase: "streaming", text: "生成中的部分内容" })} />,
    );
    expect(getByText("生成中的部分内容")).toBeTruthy();
    expect(queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("done 阶段以 body.reply 为真源展示正文，且出现操作行（AC-002）", () => {
    const turn = turnOf({
      phase: "done",
      text: "流式片段",
      body: {
        reply: "结构化最终回复",
        route: "general",
        toolCalls: [],
        retrievedCount: 0,
        returnedCount: 0,
        traceId: "t1",
        latencyMs: 1,
      },
    });
    const { getByText, getByRole } = render(<AssistantMessage messageId="m1" turn={turn} onRegenerate={() => {}} />);
    expect(getByText("结构化最终回复")).toBeTruthy();
    expect(getByRole("button", { name: "复制" })).toBeTruthy();
    expect(getByRole("button", { name: "重新生成" })).toBeTruthy();
  });

  it("error 阶段保留部分正文并展示错误提示（AC-004）", () => {
    const { getByText } = render(
      <AssistantMessage messageId="m1" turn={turnOf({ phase: "error", text: "已生成的部分", errorMessage: "网络错误" })} />,
    );
    expect(getByText("已生成的部分")).toBeTruthy();
    expect(getByText("网络错误")).toBeTruthy();
  });

  it("aborted 阶段不展示错误提示，保留已生成内容（AC-003）", () => {
    const { getByText, queryByText } = render(
      <AssistantMessage messageId="m1" turn={turnOf({ phase: "aborted", text: "已生成的部分" })} />,
    );
    expect(getByText("已生成的部分")).toBeTruthy();
    expect(queryByText(/错误|失败/)).toBeNull();
  });

  it("点击复制/重新生成触发回调", () => {
    const onCopy = vi.fn();
    const onRegenerate = vi.fn();
    const { getByRole } = render(
      <AssistantMessage
        messageId="m1"
        turn={turnOf({ phase: "done", text: "内容" })}
        onCopy={onCopy}
        onRegenerate={onRegenerate}
      />,
    );
    fireEvent.click(getByRole("button", { name: "复制" }));
    expect(onCopy).toHaveBeenCalledWith("内容");
    fireEvent.click(getByRole("button", { name: "重新生成" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it("done 且有 sources 时渲染引用角标，id 与 citationElementId() 一致（Codex Review P2：供右栏点击滚动定位）", () => {
    const turn = turnOf({
      phase: "done",
      text: "",
      body: {
        reply: "结构化最终回复",
        route: "repair",
        toolCalls: [],
        retrievedCount: 1,
        returnedCount: 1,
        traceId: "t1",
        latencyMs: 1,
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
      },
    });
    const { container, getByText } = render(<AssistantMessage messageId="msg-42" turn={turn} />);
    expect(getByText(/冰箱常见故障排查/)).toBeTruthy();
    expect(container.querySelector("#citation-msg-42-0")).toBeTruthy();
  });

  it("没有 sources（或未 done）时不渲染引用角标区域", () => {
    const { container } = render(
      <AssistantMessage messageId="m1" turn={turnOf({ phase: "streaming", text: "生成中" })} />,
    );
    expect(container.querySelector('[id^="citation-"]')).toBeNull();
  });

  it("route=safety 时正文以安全卡呈现，话术就是 body.reply（F-004/AC-003）", () => {
    const turn = doneTurn({ route: "safety", reply: "先不要自行拆机，请联系官方售后。" });
    const { container, getByText } = render(<AssistantMessage messageId="m1" turn={turn} />);
    expect(getByText("先不要自行拆机，请联系官方售后。")).toBeTruthy();
    expect(container.querySelector(".border-l-\\[\\#C55B51\\]")).toBeTruthy();
    // 安全卡替换了普通段落，不应该同时出现两份正文
    expect(container.querySelectorAll("p").length).toBe(1);
  });

  it("非 safety 场景不渲染安全卡，正文为普通段落", () => {
    const turn = doneTurn({ route: "repair", reply: "维修建议正文" });
    const { container, getByText } = render(<AssistantMessage messageId="m1" turn={turn} />);
    expect(getByText("维修建议正文")).toBeTruthy();
    expect(container.querySelector(".border-l-\\[\\#C55B51\\]")).toBeNull();
  });

  it("route=order 且调用了 queryOrderTool 且 order 存在时渲染订单卡（F-001/AC-002a）", () => {
    const order: OrderStatus = {
      found: true,
      details: {
        orderId: "ORD1002",
        status: null,
        statusText: null,
        createdAt: null,
        carrier: null,
        trackingNumber: null,
        latestLogistics: null,
        estimatedDelivery: null,
        canCancel: null,
        customerTip: null,
      },
    };
    const turn = doneTurn({
      route: "order",
      toolCalls: [{ name: "queryOrderTool", arguments: {}, result: {} }],
      order,
    });
    const { getByText } = render(<AssistantMessage messageId="m1" turn={turn} />);
    expect(getByText("ORD1002")).toBeTruthy();
  });

  it("route=order 但未调用 queryOrderTool（追问场景）时不渲染订单卡（F-002/AC-002）", () => {
    const turn = doneTurn({ route: "order", toolCalls: [], order: undefined, reply: "请提供订单号" });
    const { queryByText, getByText } = render(<AssistantMessage messageId="m1" turn={turn} />);
    expect(getByText("请提供订单号")).toBeTruthy();
    expect(queryByText(/部分信息缺失|订单号/)).not.toBeNull(); // 只是正文里提到"订单号"，不是订单卡
  });

  it("引用角标图标按 route 区分：safety 用 security，其余用 description（F-003/F-004）", () => {
    const sourcesArg: ChatResponseBody["sources"] = [
      { title: "A", section: "s", sourceFile: "f", documentVersion: "v1", vectorScore: 0.5, rerankScore: null },
    ];
    const safetyTurn = doneTurn({ route: "safety", sources: sourcesArg });
    const safety = render(<AssistantMessage messageId="m1" turn={safetyTurn} />);
    expect(safety.container.querySelector("#citation-m1-0 .material-symbols-outlined")?.textContent).toBe("security");
    safety.unmount();

    const repairTurn = doneTurn({ route: "repair", sources: sourcesArg });
    const repair = render(<AssistantMessage messageId="m1" turn={repairTurn} />);
    expect(repair.container.querySelector("#citation-m1-0 .material-symbols-outlined")?.textContent).toBe(
      "description",
    );
  });

  it("route=general 时无角标/安全卡/订单卡，只有正文与操作行（F-005/AC-004）", () => {
    const turn = doneTurn({
      route: "general",
      reply: "你好，有什么可以帮你？",
      sources: [{ title: "A", section: "s", sourceFile: "f", documentVersion: "v1", vectorScore: 0.5, rerankScore: null }],
    });
    const { container, getByText } = render(<AssistantMessage messageId="m1" turn={turn} onRegenerate={() => {}} />);
    expect(getByText("你好，有什么可以帮你？")).toBeTruthy();
    expect(container.querySelector(".border-l-\\[\\#C55B51\\]")).toBeNull();
    expect(container.querySelector('[id^="citation-"]')).toBeNull();
  });

  it("error 阶段展示完整错误卡：图标+标题+message+traceId+重试按钮（F-008）", () => {
    const onRegenerate = vi.fn();
    const turn = turnOf({
      phase: "error",
      text: "已生成的部分",
      traceId: "trace-err-1",
      errorMessage: "上游服务异常",
    });
    const { getByText, getByRole } = render(
      <AssistantMessage messageId="m1" turn={turn} onRegenerate={onRegenerate} />,
    );
    expect(getByText("已生成的部分")).toBeTruthy();
    expect(getByText("回复生成失败")).toBeTruthy();
    expect(getByText("上游服务异常")).toBeTruthy();
    expect(getByText("trace-err-1")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /重试/ }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});
