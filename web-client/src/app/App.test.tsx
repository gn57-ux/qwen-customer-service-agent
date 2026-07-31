/**
 * App 空壳骨架的冒烟测试。本 feature（3.workbench-app-scaffold）只出占位结构，
 * 具体交互留给 feature 4-6；这里只验证：能挂载、ClientProvider 正确下发、
 * 根容器满足"不出现 body 级滚动"的结构性前提（h-screen + overflow-hidden）。
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.tsx";
import { ClientProvider, useClient } from "./client-context.tsx";
import type { CustomerServiceClient } from "../client.ts";

function fakeClient(): CustomerServiceClient {
  return {
    chat: async () => {
      throw new Error("not implemented in fake");
    },
    streamChat: async () => {
      throw new Error("not implemented in fake");
    },
    status: async () => ({ localModel: "unknown", knowledgeBase: "unknown", orderService: "unknown" }),
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
