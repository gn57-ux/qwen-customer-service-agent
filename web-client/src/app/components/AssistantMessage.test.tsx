import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantMessage } from "./AssistantMessage.tsx";
import type { AssistantTurn } from "../chat-types.ts";

afterEach(() => {
  cleanup();
});

function turnOf(overrides: Partial<AssistantTurn>): AssistantTurn {
  return { phase: "streaming", text: "", toolCalls: [], ...overrides };
}

describe("AssistantMessage", () => {
  it("streaming 阶段展示累积的 text，不展示操作行", () => {
    const { getByText, queryByRole } = render(
      <AssistantMessage turn={turnOf({ phase: "streaming", text: "生成中的部分内容" })} />,
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
    const { getByText, getByRole } = render(<AssistantMessage turn={turn} onRegenerate={() => {}} />);
    expect(getByText("结构化最终回复")).toBeTruthy();
    expect(getByRole("button", { name: "复制" })).toBeTruthy();
    expect(getByRole("button", { name: "重新生成" })).toBeTruthy();
  });

  it("error 阶段保留部分正文并展示错误提示（AC-004）", () => {
    const { getByText } = render(
      <AssistantMessage turn={turnOf({ phase: "error", text: "已生成的部分", errorMessage: "网络错误" })} />,
    );
    expect(getByText("已生成的部分")).toBeTruthy();
    expect(getByText("网络错误")).toBeTruthy();
  });

  it("aborted 阶段不展示错误提示，保留已生成内容（AC-003）", () => {
    const { getByText, queryByText } = render(
      <AssistantMessage turn={turnOf({ phase: "aborted", text: "已生成的部分" })} />,
    );
    expect(getByText("已生成的部分")).toBeTruthy();
    expect(queryByText(/错误|失败/)).toBeNull();
  });

  it("点击复制/重新生成触发回调", () => {
    const onCopy = vi.fn();
    const onRegenerate = vi.fn();
    const { getByRole } = render(
      <AssistantMessage
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
});
