/**
 * App 空壳骨架的冒烟测试。本 feature（3.workbench-app-scaffold）只出占位结构，
 * 具体交互留给 feature 4-6；这里只验证：能挂载、ClientProvider 正确下发、
 * 根容器满足"不出现 body 级滚动"的结构性前提（h-screen + overflow-hidden）。
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.tsx";
import { ClientProvider, useClient } from "./client-context.tsx";
import type { CustomerServiceClient } from "../client.ts";
import type { ChatResponseBody } from "../types.ts";

function fakeClient(streamChat?: CustomerServiceClient["streamChat"]): CustomerServiceClient {
  return {
    chat: async () => {
      throw new Error("not implemented in fake");
    },
    streamChat:
      streamChat ??
      (async () => {
        throw new Error("not implemented in fake");
      }),
    status: async () => ({ localModel: "unknown", knowledgeBase: "unknown", orderService: "unknown" }),
  };
}

function immediateDoneResponse(reply: string): ChatResponseBody {
  return {
    reply,
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "trace-1",
    latencyMs: 1,
  };
}

describe("App", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("挂载不抛出异常", () => {
    expect(() => render(<App client={fakeClient()} />)).not.toThrow();
  });

  it("根容器具备 h-screen + overflow-hidden（body 级不滚动的结构前提）", () => {
    const { container } = render(<App client={fakeClient()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("h-screen");
    expect(root.className).toContain("overflow-hidden");
  });

  it("三栏骨架的断点显隐类与设计稿一致（左栏 md、右栏 min-[1100px]）", () => {
    const { container } = render(<App client={fakeClient()} />);
    const asides = container.querySelectorAll("aside");
    expect(asides.length).toBe(2);
    expect(asides[0]!.className).toContain("md:flex");
    expect(asides[0]!.className).toContain("w-[220px]");
    expect(asides[1]!.className).toContain("min-[1100px]:flex");
    expect(asides[1]!.className).toContain("w-[300px]");
  });
});

describe("Workbench 会话集成（Codex Review P1/P2 修复）", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("发送首条消息后，左栏标题从「新会话」派生为消息截断文本", async () => {
    const streamChat: CustomerServiceClient["streamChat"] = async (message, _h, onEvent) => {
      const body = immediateDoneResponse(`回答:${message}`);
      onEvent({ event: "done", data: body });
      return body;
    };
    // 避开 Composer 的 4 个快捷 chip 文案，防止 getByRole 匹配到同名按钮产生歧义
    const question = "空调不制热怎么办";
    const { container, getByPlaceholderText, getByRole, getAllByText } = render(
      <App client={fakeClient(streamChat)} />,
    );
    const chatArea = () => container.querySelector("main")!;

    fireEvent.change(getByPlaceholderText(/请输入维修问题/), { target: { value: question } });
    fireEvent.click(getByRole("button", { name: "发送" }));

    await waitFor(() => expect(chatArea().textContent).toContain(question));
    // 左栏原「新会话」标题应已替换为消息截断文本，且消息区与左栏各出现一次
    expect(getAllByText(question)).toHaveLength(2);
  });

  it("新建会话后切回第一个会话，原会话消息仍在（不再被全局 reset() 清空，Codex Review P1）", async () => {
    const streamChat: CustomerServiceClient["streamChat"] = async (message, _h, onEvent) => {
      const body = immediateDoneResponse(`回答:${message}`);
      onEvent({ event: "done", data: body });
      return body;
    };
    const firstQuestion = "空调不制热怎么办";
    const { container, getByPlaceholderText, getByRole } = render(
      <App client={fakeClient(streamChat)} />,
    );
    const chatArea = () => container.querySelector("main")!;

    fireEvent.change(getByPlaceholderText(/请输入维修问题/), { target: { value: firstQuestion } });
    fireEvent.click(getByRole("button", { name: "发送" }));
    await waitFor(() => expect(chatArea().textContent).toContain(firstQuestion));

    fireEvent.click(getByRole("button", { name: "新建会话" }));
    // 新会话是空的：刚才那句话不应再出现在可见对话区（左栏仍保留该会话的标题项，
    // 所以不能用整页 queryByText，要把断言范围限定在 <main> 对话区内）
    expect(chatArea().textContent).not.toContain(firstQuestion);

    // 切回第一个会话（左栏里以问题文本作为标题的那一项）
    fireEvent.click(getByRole("button", { name: firstQuestion }));
    await waitFor(() => expect(chatArea().textContent).toContain(firstQuestion));
  });

  it("流式生成中点击清空会话：请求立刻释放，Composer 立刻解锁（Codex Review P2 [2]）", async () => {
    let releaseStream: (() => void) | undefined;
    const streamChat: CustomerServiceClient["streamChat"] = async (_message, _h, onEvent) => {
      onEvent({ event: "text-delta", data: { delta: "生成中的一部分" } });
      // 挂起，模拟"清空会话时请求还没完成"——只有清空动作本身触发的同步收尾
      // 才能让 Composer 立刻解锁；如果只是等这个 promise 自然结束，测试会一直挂住。
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      throw new DOMException("aborted", "AbortError");
    };
    const { getByPlaceholderText, getByRole, queryByRole } = render(<App client={fakeClient(streamChat)} />);

    fireEvent.change(getByPlaceholderText(/请输入维修问题/), { target: { value: "冰箱异响" } });
    fireEvent.click(getByRole("button", { name: "发送" }));
    await waitFor(() => expect(getByRole("button", { name: "停止生成" })).toBeTruthy());

    fireEvent.click(getByRole("button", { name: "清空会话" }));

    // 不需要等待底层 promise 结算：清空动作本身必须同步把 isStreaming 拨回
    // false，Composer 立刻变回「发送」态（按钮 disabled，因为输入框已清空）。
    expect(queryByRole("button", { name: "停止生成" })).toBeNull();
    expect(getByRole("button", { name: "发送" })).toBeTruthy();

    releaseStream?.();
  });
});

describe("ClientProvider / useClient", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("useClient() 在 Provider 外部调用会抛出明确错误", () => {
    function Probe() {
      useClient();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/ClientProvider/);
  });

  it("注入的 mock client 会被 useClient() 拿到（供组件测试替换真实网络调用）", async () => {
    const mock = fakeClient();
    let captured: CustomerServiceClient | null = null;
    function Probe() {
      captured = useClient();
      return null;
    }
    render(
      <ClientProvider client={mock}>
        <Probe />
      </ClientProvider>,
    );
    expect(captured).toBe(mock);
  });
});
