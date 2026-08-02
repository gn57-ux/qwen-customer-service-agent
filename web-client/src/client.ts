/**
 * 前端唯一允许使用的客服客户端：只通过 @mastra/client-js 的 MastraClient 调用
 * Mastra 服务的两个自定义 route（customer-service/chat、customer-service/stream），
 * 不直连 FastAPI（:8000）、不直连 llama-server（:8002）、不自行实现维修/订单/
 * 安全路由——路由逻辑全部在服务端 orchestration.ts 的 runAgentTurn/
 * streamAgentTurn 里，这里只是把 HTTP 调用包一层好用的类型化接口。
 *
 * 为什么用 client.request() 而不是 client.getAgent(id).generate()：
 * 后者会直接命中标准 Agent endpoint，绕开服务端的确定性路由/强制工具逻辑
 * （见 mastra-agent/src/mastra/routes/customer-service.ts 顶部注释）——这是
 * 明确禁止的用法。request() 是 MastraClient/BaseResource 自己公开的通用请求
 * 方法（node_modules/@mastra/client-js/dist/resources/base.d.ts），用它调用
 * 自定义 route 仍然是"只通过 MastraClient"，不是绕过它。
 *
 * 为什么要传 apiPrefix: ""：Mastra Server 明确禁止自定义 route 挂在 /api 下
 * （"/api" 是内置路由保留前缀，实测直接抛错），所以两个自定义 route 挂在根
 * 路径（/customer-service/chat、/customer-service/stream）。MastraClient
 * 默认会给 request() 的 path 加上 apiPrefix（默认 '/api'），这里传空字符串
 * 关掉这个前缀，自己在 path 里写完整路径。
 */

import { MastraClient } from "@mastra/client-js";

import type { ChatHistoryTurn, ChatResponseBody, ServiceStatusBody, StreamEvent } from "./types.ts";

export interface CustomerServiceClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface StreamChatOptions {
  /**
   * 取消信号。已用真实请求验证的限制（详见 README-CLIENT.md「已知限制」）：
   * @mastra/client-js@1.33.0 的 RequestOptions 没有 signal 字段，请求头
   * 返回之前（即 MastraClient.request() 内部的 fetch 还没 resolve 时）无法
   * 通过这个 signal 原生取消——这里没有用 `as any` 假装支持，也没有改成
   * 普通 fetch 绕开 MastraClient。拿到流式 Response 之后（reader 到手），
   * abort 可以可靠地取消后续读取并关闭到服务端的连接（reader.cancel()）。
   */
  signal?: AbortSignal;
}

export interface CustomerServiceClient {
  chat(message: string, history?: ChatHistoryTurn[]): Promise<ChatResponseBody>;
  streamChat(
    message: string,
    history: ChatHistoryTurn[] | undefined,
    onEvent: (event: StreamEvent) => void,
    options?: StreamChatOptions,
  ): Promise<ChatResponseBody>;
  status(): Promise<ServiceStatusBody>;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function createCustomerServiceClient(options: CustomerServiceClientOptions): CustomerServiceClient {
  const client = new MastraClient({
    baseUrl: options.baseUrl,
    apiPrefix: "",
    headers: options.headers,
    fetch: options.fetch,
  });

  return {
    async chat(message, history = []) {
      return client.request<ChatResponseBody>("/customer-service/chat", {
        method: "POST",
        body: { message, history },
      });
    },

    async streamChat(message, history = [], onEvent, streamOptions) {
      const signal = streamOptions?.signal;
      if (signal?.aborted) {
        throw abortError();
      }

      const response = (await client.request("/customer-service/stream", {
        method: "POST",
        body: { message, history },
        stream: true,
      })) as Response;

      if (!response.body) {
        throw new Error("流式响应没有 body，无法读取 SSE");
      }

      const reader = response.body.getReader();
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // cancel() 可能因为流已经结束而抛错，这里不关心结果，只是尽力关闭。
        reader.cancel(abortError()).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort);

      const decoder = new TextDecoder();
      let buffer = "";
      let done: ChatResponseBody | null = null;

      try {
        while (true) {
          let value: Uint8Array | undefined;
          let readerDone: boolean;
          try {
            ({ value, done: readerDone } = await reader.read());
          } catch (cause) {
            // reader.cancel() 触发时，正在进行的 read() 可能以拒绝告终；
            // 有没有拒绝取决于具体运行时，两种情况都归一到 AbortError。
            if (aborted || signal?.aborted) throw abortError();
            throw cause;
          }
          if (aborted || signal?.aborted) throw abortError();
          if (readerDone) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE 事件以空行分隔，每个事件里 "event:" 与 "data:" 各占一行
          // （hono/streaming 的 streamSSE 就是这么写的）。
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventLine = rawEvent.split("\n").find((l) => l.startsWith("event:"));
            const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
            if (!eventLine || !dataLine) continue;
            const eventName = eventLine.slice("event:".length).trim();
            const data = JSON.parse(dataLine.slice("data:".length).trim());
            const streamEvent = { event: eventName, data } as StreamEvent;
            // onEvent 抛错（包括调用方在回调里主动 abort）会在这里向外传播，
            // 走到下面的 finally 统一清理，不会漏掉 reader 释放。
            onEvent(streamEvent);
            if (streamEvent.event === "done") done = streamEvent.data;
            if (streamEvent.event === "error") throw new Error(streamEvent.data.message);
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // 无论正常结束、出错还是被取消，都尝试关闭底层连接再释放锁——
        // 已经读完的流再 cancel() 是安全的空操作，不会抛错到这里。
        await reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          // 已经 release 过或流已关闭，忽略
        }
      }

      if (aborted || signal?.aborted) {
        throw abortError();
      }
      if (!done) {
        throw new Error("流式响应提前结束，没有收到 done 事件");
      }
      return done;
    },

    async status() {
      return client.request<ServiceStatusBody>("/customer-service/status", { method: "GET" });
    },
  };
}
