/**
 * F-012~F-015 的行为验证：五类事件分发、text/body 分存、取消/错误/提前结束
 * 三种收尾归一、onSettled 触发、并发 turn 的 stale 事件防护、以及 Codex Review
 * P1 修复——切换会话不得丢失任一会话的消息，写入始终定向到发起 turn 时的会话。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ClientProvider } from "../client-context.tsx";
import { useChatStream, type MessagesUpdater } from "./use-chat-stream.ts";
import type { Message } from "../chat-types.ts";
import type { CustomerServiceClient, StreamChatOptions } from "../../client.ts";
import type { ChatHistoryTurn, ChatResponseBody, StreamEvent } from "../../types.ts";

function baseResponse(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    reply: "默认回复",
    route: "general",
    toolCalls: [],
    retrievedCount: 0,
    returnedCount: 0,
    traceId: "trace-1",
    latencyMs: 10,
    ...overrides,
  };
}

type StreamChatImpl = (
  message: string,
  history: ChatHistoryTurn[] | undefined,
  onEvent: (event: StreamEvent) => void,
  options?: StreamChatOptions,
) => Promise<ChatResponseBody>;

function fakeClient(streamChat: StreamChatImpl): CustomerServiceClient {
  return {
    chat: async () => {
      throw new Error("not implemented in fake");
    },
    streamChat,
    status: async () => ({ localModel: "unknown", knowledgeBase: "unknown", orderService: "unknown" }),
  };
}

function wrapperFor(client: CustomerServiceClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>{children}</ClientProvider>
  );
}

/** 模拟 App.tsx 里 Record<sessionId, Message[]> 式的多会话存储 */
function createStore(initial: Record<string, Message[]>) {
  const state: Record<string, Message[]> = { ...initial };
  const onMessagesChange = (sessionId: string, updater: MessagesUpdater) => {
    state[sessionId] = updater(state[sessionId] ?? []);
  };
  return { state, onMessagesChange };
}

describe("useChatStream", () => {
  afterEach(() => {
    cleanup();
  });

  it("初始为空会话，未发送前 isStreaming 为 false", () => {
    const client = fakeClient(async () => baseResponse());
    const store = createStore({ s1: [] });
    const { result } = renderHook(
      () => useChatStream({ sessionId: "s1", messages: store.state.s1!, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client) },
    );
    expect(result.current.isStreaming).toBe(false);
  });

  it("五类事件按顺序分发：meta 记 traceId、tool-result 累积、text-delta 累积、done 以 body 覆盖（AC-001/AC-002）", async () => {
    const streamChat: StreamChatImpl = async (_message, _history, onEvent) => {
      onEvent({ event: "meta", data: { traceId: "trace-42" } });
      onEvent({ event: "tool-result", data: { name: "searchKnowledgeBase", arguments: {}, result: {} } });
      onEvent({ event: "text-delta", data: { delta: "你好" } });
      onEvent({ event: "text-delta", data: { delta: "，请描述故障" } });
      const body = baseResponse({ reply: "你好，请描述故障现象" });
      onEvent({ event: "done", data: body });
      return body;
    };
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result, rerender } = renderHook(
      ({ messages }) => useChatStream({ sessionId: "s1", messages, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client), initialProps: { messages: store.state.s1! } },
    );

    await act(async () => {
      await result.current.sendMessage("冰箱不制冷");
    });
    rerender({ messages: store.state.s1! });

    const messages = store.state.s1!;
    expect(messages).toHaveLength(2);
    const [userMessage, assistantMessage] = messages;
    expect(userMessage).toMatchObject({ role: "user", content: "冰箱不制冷" });
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      turn: {
        phase: "done",
        traceId: "trace-42",
        text: "你好，请描述故障",
        toolCalls: [{ name: "searchKnowledgeBase", arguments: {}, result: {} }],
      },
    });
    if (assistantMessage!.role === "assistant") {
      expect(assistantMessage!.turn.body?.reply).toBe("你好，请描述故障现象");
    }
    expect(result.current.isStreaming).toBe(false);
  });

  it("用户取消：AbortError 落为 aborted，不产生 errorMessage，已生成内容保留（AC-003），且同步触发 onSettled（Codex Review P2）", async () => {
    const onSettled = vi.fn();
    const streamChat: StreamChatImpl = async (_message, _history, onEvent, options) => {
      onEvent({ event: "text-delta", data: { delta: "部分回答" } });
      await new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(undefined));
      });
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result, rerender } = renderHook(
      ({ messages }) => useChatStream({ sessionId: "s1", messages, onMessagesChange: store.onMessagesChange, onSettled }),
      { wrapper: wrapperFor(client), initialProps: { messages: store.state.s1! } },
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("问题");
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    act(() => {
      result.current.cancel();
    });
    // cancel() 是同步收尾——不需要等底层 promise 真正 reject，onSettled 与
    // isStreaming=false 应该在这里就已经生效。
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(false);

    await act(async () => {
      await sendPromise;
    });
    rerender({ messages: store.state.s1! });

    const assistant = store.state.s1![1];
    expect(assistant).toMatchObject({ role: "assistant", turn: { phase: "aborted", text: "部分回答" } });
    if (assistant?.role === "assistant") {
      expect(assistant.turn.errorMessage).toBeUndefined();
    }
    // 迟到的 promise rejection 不应该再补一次 onSettled（token 已失效，走 no-op 分支）
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("error 事件转化为的 throw 落为 error 态，保留部分正文（AC-004）", async () => {
    const streamChat: StreamChatImpl = async (_message, _history, onEvent) => {
      onEvent({ event: "text-delta", data: { delta: "部分" } });
      throw new Error("上游服务异常");
    };
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result } = renderHook(
      () => useChatStream({ sessionId: "s1", messages: store.state.s1!, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.sendMessage("问题");
    });

    const assistant = store.state.s1![1];
    expect(assistant).toMatchObject({
      role: "assistant",
      turn: { phase: "error", text: "部分", errorMessage: "上游服务异常" },
    });
  });

  it("流提前结束（无 done）按 error 处理（AC-005）", async () => {
    const streamChat: StreamChatImpl = async () => {
      throw new Error("流式响应提前结束，没有收到 done 事件");
    };
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result } = renderHook(
      () => useChatStream({ sessionId: "s1", messages: store.state.s1!, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.sendMessage("问题");
    });

    const assistant = store.state.s1![1];
    expect(assistant).toMatchObject({ role: "assistant", turn: { phase: "error" } });
  });

  it("done/error/aborted 收尾都触发 onSettled（供顶栏 refresh）", async () => {
    const onSettled = vi.fn();
    const streamChat: StreamChatImpl = async () => baseResponse();
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result } = renderHook(
      () =>
        useChatStream({
          sessionId: "s1",
          messages: store.state.s1!,
          onMessagesChange: store.onMessagesChange,
          onSettled,
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.sendMessage("问题");
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("regenerate() 以最近一次用户消息重新发起，替换同一条消息而非追加新消息", async () => {
    const seenHistories: (ChatHistoryTurn[] | undefined)[] = [];
    const streamChat: StreamChatImpl = async (message, history) => {
      seenHistories.push(history);
      return baseResponse({ reply: `回答:${message}` });
    };
    const client = fakeClient(streamChat);
    const store = createStore({ s1: [] });
    const { result, rerender } = renderHook(
      ({ messages }) => useChatStream({ sessionId: "s1", messages, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client), initialProps: { messages: store.state.s1! } },
    );

    await act(async () => {
      await result.current.sendMessage("第一问");
    });
    rerender({ messages: store.state.s1! });

    await act(async () => {
      await result.current.regenerate();
    });
    rerender({ messages: store.state.s1! });

    expect(seenHistories).toHaveLength(2);
    expect(seenHistories[1]).toEqual(seenHistories[0]);
    expect(store.state.s1!).toHaveLength(2);
  });

  it("Codex Review P1：切换会话不丢失任一会话的消息，且旧会话的在途流式请求被中断而非继续覆盖", async () => {
    let releaseA: (() => void) | undefined;
    const onSettled = vi.fn();
    const streamChat: StreamChatImpl = async (message, _history, onEvent, options) => {
      if (message === "会话A的问题") {
        onEvent({ event: "text-delta", data: { delta: "A的部分回答" } });
        await new Promise<void>((resolve) => {
          releaseA = resolve;
          options?.signal?.addEventListener("abort", () => resolve());
        });
        if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const body = baseResponse({ reply: "A的完整回答" });
        onEvent({ event: "done", data: body });
        return body;
      }
      const body = baseResponse({ reply: `回答:${message}` });
      onEvent({ event: "done", data: body });
      return body;
    };
    const client = fakeClient(streamChat);
    const store = createStore({ a: [], b: [] });

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useChatStream({
          sessionId,
          messages: store.state[sessionId]!,
          onMessagesChange: store.onMessagesChange,
          onSettled,
        }),
      { wrapper: wrapperFor(client), initialProps: { sessionId: "a" } },
    );

    // 在会话 A 发起一轮流式请求，故意不等它结束
    act(() => {
      void result.current.sendMessage("会话A的问题");
    });
    await waitFor(() => expect(store.state.a).toHaveLength(2));

    // 切到会话 B——hook 感知到 sessionId 变化，中断会话 A 的在途请求
    rerender({ sessionId: "b" });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    // 会话 A 已经生成的部分内容必须还在（没有被切换清空），且同步落为 aborted
    // （不是异步等 promise reject 才补写——那样在下面"立刻发新消息"的场景里
    // token 早被占用，异步 catch 进来只会直接 return，永远补不上）。
    expect(store.state.a).toHaveLength(2);
    const assistantA = store.state.a[1];
    expect(assistantA).toMatchObject({ role: "assistant", turn: { phase: "aborted", text: "A的部分回答" } });
    // 切换会话中断在途请求也要触发 onSettled，顶栏服务状态才不会停在切换前那一刻（Codex Review P2）
    expect(onSettled).toHaveBeenCalledTimes(1);

    // 在会话 B 正常发一条消息，两个会话互不影响
    await act(async () => {
      await result.current.sendMessage("会话B的问题");
    });
    expect(store.state.b).toHaveLength(2);
    expect(store.state.a).toHaveLength(2);

    releaseA?.();
  });

  it("Codex Review P2 [1]：切走会话后立刻在新会话发消息（旧 promise 还没 reject），旧会话消息也不能卡在 streaming", async () => {
    let releaseA: (() => void) | undefined;
    const streamChat: StreamChatImpl = async (message, _history, onEvent, options) => {
      if (message === "会话A的问题") {
        onEvent({ event: "text-delta", data: { delta: "A的部分回答" } });
        // 故意让这个 promise 一直挂着，模拟"新 turn 已经抢占 token 时，旧请求
        // 的 reject 还远没发生"这个最容易漏写 aborted 的时间窗口。
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        throw new DOMException("aborted", "AbortError");
      }
      const body = baseResponse({ reply: `回答:${message}` });
      onEvent({ event: "done", data: body });
      return body;
    };
    const client = fakeClient(streamChat);
    const store = createStore({ a: [], b: [] });

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useChatStream({ sessionId, messages: store.state[sessionId]!, onMessagesChange: store.onMessagesChange }),
      { wrapper: wrapperFor(client), initialProps: { sessionId: "a" } },
    );

    act(() => {
      void result.current.sendMessage("会话A的问题");
    });
    await waitFor(() => expect(store.state.a).toHaveLength(2));

    // 切到 b，然后不等待、立刻在 b 发一条新消息——这一步会让 turnTokenRef 再次
    // 前进，是本 finding 描述的"新 turn 抢占 token"场景。
    rerender({ sessionId: "b" });
    await act(async () => {
      await result.current.sendMessage("会话B的问题");
    });

    // 会话 A 的消息必须是 aborted，不能永远停在 streaming
    const assistantA = store.state.a[1];
    expect(assistantA).toMatchObject({ role: "assistant", turn: { phase: "aborted" } });

    releaseA?.();
  });
});
