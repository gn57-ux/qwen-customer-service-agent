import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageList } from "./MessageList.tsx";
import type { Message } from "../chat-types.ts";

/** jsdom 不做真实布局，scrollHeight/clientHeight/scrollTop 需要手动打桩模拟。 */
function stubScrollMetrics(el: HTMLElement, initial: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  let scrollHeight = initial.scrollHeight;
  let scrollTop = initial.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: initial.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return {
    setScrollHeight: (v: number) => {
      scrollHeight = v;
    },
    setScrollTop: (v: number) => {
      scrollTop = v;
    },
    getScrollTop: () => scrollTop,
  };
}

afterEach(() => {
  cleanup();
});

function messages(): Message[] {
  return [
    { id: "u1", role: "user", content: "冰箱不制冷" },
    { id: "a1", role: "assistant", turn: { phase: "done", text: "先检查电源", toolCalls: [] } },
  ];
}

describe("MessageList", () => {
  it("容器带 pb-40 为输入区避让，且不可省略（AC-007）", () => {
    const { container } = render(<MessageList messages={messages()} />);
    const scrollContainer = container.firstElementChild as HTMLElement;
    expect(scrollContainer.className).toContain("pb-40");
    expect(scrollContainer.className).toContain("overflow-y-auto");
  });

  it("按顺序渲染用户与 AI 消息", () => {
    const { getByText } = render(<MessageList messages={messages()} />);
    expect(getByText("冰箱不制冷")).toBeTruthy();
    expect(getByText("先检查电源")).toBeTruthy();
  });

  it("只把 onRegenerate 传给最后一条 AI 消息，历史消息不出现重新生成按钮", () => {
    const list: Message[] = [
      { id: "u1", role: "user", content: "第一问" },
      { id: "a1", role: "assistant", turn: { phase: "done", text: "第一答", toolCalls: [] } },
      { id: "u2", role: "user", content: "第二问" },
      { id: "a2", role: "assistant", turn: { phase: "done", text: "第二答", toolCalls: [] } },
    ];
    const { getAllByRole } = render(<MessageList messages={list} onRegenerate={() => {}} />);
    const regenerateButtons = getAllByRole("button", { name: "重新生成" });
    expect(regenerateButtons).toHaveLength(1);
  });

  it("贴底时即使新内容一次性大幅增高，仍会跟随滚到底（Codex Review P2 修复）", () => {
    const { container, rerender } = render(<MessageList messages={messages()} />);
    const el = container.firstElementChild as HTMLElement;
    // scrollHeight - scrollTop - clientHeight = 1000 - 600 - 400 = 0，即"当前在底部附近"
    const stub = stubScrollMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    // 打桩是在挂载之后才生效的，用一次真实 scroll 事件让组件记录"此刻确实在
    // 底部附近"（供下一次内容增高时参考），而不是依赖挂载时机的副作用。
    fireEvent.scroll(el);

    // 新内容一次性让 scrollHeight 暴涨 500px（远超 80px 阈值）——若在渲染后才
    // 重新用"新 scrollHeight - 旧 scrollTop"现测，会被误判为"不在底部"从而不跟随。
    stub.setScrollHeight(1500);
    const grown: Message[] = [
      ...messages(),
      { id: "u2", role: "user", content: "第二问" },
      { id: "a2", role: "assistant", turn: { phase: "streaming", text: "很长很长的新增内容", toolCalls: [] } },
    ];
    rerender(<MessageList messages={grown} />);

    expect(stub.getScrollTop()).toBe(1500);
  });

  it("用户手动上滚后，新内容到达不会被强行拉回底部（AC-006）", () => {
    const { container, rerender } = render(<MessageList messages={messages()} />);
    const el = container.firstElementChild as HTMLElement;
    const stub = stubScrollMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(el); // 记录"此刻在底部附近"

    // 用户手动上滚到顶部，浏览器派发 scroll 事件
    stub.setScrollTop(0);
    fireEvent.scroll(el);

    // 新内容到达，scrollHeight 继续增长
    stub.setScrollHeight(1800);
    const grown: Message[] = [
      ...messages(),
      { id: "a2", role: "assistant", turn: { phase: "streaming", text: "新内容", toolCalls: [] } },
    ];
    rerender(<MessageList messages={grown} />);

    // 不应被强行拉回底部
    expect(stub.getScrollTop()).toBe(0);
  });
});
