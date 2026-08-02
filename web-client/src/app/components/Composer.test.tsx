import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer.tsx";

afterEach(() => {
  cleanup();
});

describe("Composer", () => {
  it("Feature 9 定向修正：不再渲染预设快捷问题按钮（冰箱不制冷/电视开机黑屏/显示器无信号/查询ORD1001）", () => {
    const { queryByRole } = render(<Composer isStreaming={false} onSend={() => {}} onStop={() => {}} />);
    expect(queryByRole("button", { name: "冰箱不制冷" })).toBeNull();
    expect(queryByRole("button", { name: "电视开机黑屏" })).toBeNull();
    expect(queryByRole("button", { name: "显示器无信号" })).toBeNull();
    expect(queryByRole("button", { name: "查询ORD1001" })).toBeNull();
  });

  it("发送按钮点击后携带输入内容触发 onSend，并清空输入框", () => {
    const onSend = vi.fn();
    const { getByPlaceholderText, getByRole } = render(
      <Composer isStreaming={false} onSend={onSend} onStop={() => {}} />,
    );
    const textarea = getByPlaceholderText(/请输入维修问题/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "空调不制热怎么排查" } });
    fireEvent.click(getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("空调不制热怎么排查");
    expect(textarea.value).toBe("");
  });

  it("输入为空时发送按钮 disabled", () => {
    const { getByRole } = render(<Composer isStreaming={false} onSend={() => {}} onStop={() => {}} />);
    expect((getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("流式期间按钮转为「停止」态，点击触发 onStop（F-013/AC-003）", () => {
    const onStop = vi.fn();
    const { getByRole, queryByRole } = render(
      <Composer isStreaming={true} onSend={() => {}} onStop={onStop} />,
    );
    expect(queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "停止生成" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("免责声明文案存在", () => {
    const { getByText } = render(<Composer isStreaming={false} onSend={() => {}} onStop={() => {}} />);
    expect(getByText("AI建议仅供初步排查，不可替代专业维修诊断。")).toBeTruthy();
  });
});
