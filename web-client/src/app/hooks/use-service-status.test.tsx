/**
 * F-005/F-007/F-008 的行为验证：初始 unknown、失败落 error 且不抛出、
 * refresh() 可被外部（feature 5 的 done/error 回调）显式调用。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ClientProvider } from "../client-context.tsx";
import { useServiceStatus } from "./use-service-status.ts";
import type { CustomerServiceClient } from "../../client.ts";
import type { ServiceStatusBody } from "../../types.ts";

function fakeClient(status: CustomerServiceClient["status"]): CustomerServiceClient {
  return {
    chat: async () => {
      throw new Error("not implemented in fake");
    },
    streamChat: async () => {
      throw new Error("not implemented in fake");
    },
    status,
  };
}

function wrapperFor(client: CustomerServiceClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>{children}</ClientProvider>
  );
}

describe("useServiceStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("首帧三项为 unknown，不得乐观预设 online（F-005）", () => {
    const client = fakeClient(() => new Promise<ServiceStatusBody>(() => {}));
    const { result } = renderHook(() => useServiceStatus(), { wrapper: wrapperFor(client) });

    expect(result.current.data).toEqual({
      localModel: "unknown",
      knowledgeBase: "unknown",
      orderService: "unknown",
    });
  });

  it("探测成功后更新为真实状态（AC-003）", async () => {
    const resolved: ServiceStatusBody = { localModel: "online", knowledgeBase: "degraded", orderService: "error" };
    const client = fakeClient(async () => resolved);
    const { result } = renderHook(() => useServiceStatus(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.data).toEqual(resolved));
    expect(result.current.loading).toBe(false);
  });

  it("status() 抛错时三项落为 error，且不向外抛出未捕获异常（F-007/AC-005）", async () => {
    const client = fakeClient(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() => useServiceStatus(), { wrapper: wrapperFor(client) });

    await waitFor(() =>
      expect(result.current.data).toEqual({ localModel: "error", knowledgeBase: "error", orderService: "error" }),
    );
  });

  it("refresh() 可被外部显式调用并重新拉取（供聊天 done/error 触发）", async () => {
    const statusFn = vi
      .fn<CustomerServiceClient["status"]>()
      .mockResolvedValueOnce({ localModel: "unknown", knowledgeBase: "unknown", orderService: "unknown" })
      .mockResolvedValueOnce({ localModel: "online", knowledgeBase: "online", orderService: "online" });
    const client = fakeClient(statusFn);
    const { result } = renderHook(() => useServiceStatus(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(statusFn).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(statusFn).toHaveBeenCalledTimes(2);
    expect(result.current.data.localModel).toBe("online");
  });

  it("慢的旧请求不得覆盖快的新请求（并发 refresh 竞态）", async () => {
    type Deferred = { promise: Promise<ServiceStatusBody>; resolve: (v: ServiceStatusBody) => void };
    function deferred(): Deferred {
      let resolve!: (v: ServiceStatusBody) => void;
      const promise = new Promise<ServiceStatusBody>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const first = deferred();
    const second = deferred();
    const statusFn = vi
      .fn<CustomerServiceClient["status"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = fakeClient(statusFn);
    const { result } = renderHook(() => useServiceStatus(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(statusFn).toHaveBeenCalledTimes(1));

    // 挂载请求（first）尚未返回时，手动触发第二次 refresh（second）
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(statusFn).toHaveBeenCalledTimes(2));

    // 新请求（second）先落地
    await act(async () => {
      second.resolve({ localModel: "online", knowledgeBase: "online", orderService: "online" });
      await refreshPromise;
    });
    expect(result.current.data.localModel).toBe("online");
    expect(result.current.loading).toBe(false);

    // 旧请求（first）后落地，不得覆盖 second 已经写入的状态，也不得把 loading 拨回 true/false 造成误报
    await act(async () => {
      first.resolve({ localModel: "error", knowledgeBase: "error", orderService: "error" });
      await Promise.resolve();
    });
    expect(result.current.data.localModel).toBe("online");
    expect(result.current.loading).toBe(false);
  });
});
