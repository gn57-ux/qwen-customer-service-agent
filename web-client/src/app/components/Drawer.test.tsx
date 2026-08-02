import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import { Drawer } from "./Drawer.tsx";

afterEach(() => {
  cleanup();
  // @ts-expect-error 测试打桩，清理避免泄漏到其他测试文件
  delete window.matchMedia;
});

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div>
      <button type="button">触发按钮</button>
      <Drawer open={open} onClose={onClose} side="right" bgClassName="bg-sidebar-right-bg" widthClassName="w-[300px]">
        <p>抽屉内容</p>
      </Drawer>
    </div>
  );
}

/** jsdom 不实现 matchMedia，手动打桩出一个可以模拟断点变化的假 MediaQueryList。 */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  let changeHandler: (() => void) | undefined;
  const mql = {
    get matches() {
      return matches;
    },
    addEventListener: (_event: string, handler: () => void) => {
      changeHandler = handler;
    },
    removeEventListener: () => {
      changeHandler = undefined;
    },
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    triggerChange: (nextMatches: boolean) => {
      matches = nextMatches;
      changeHandler?.();
    },
  };
}

describe("Drawer", () => {
  it("open=false 时不渲染任何内容", () => {
    const { queryByText, queryByRole } = render(<Harness open={false} onClose={() => {}} />);
    expect(queryByText("抽屉内容")).toBeNull();
    expect(queryByRole("dialog")).toBeNull();
  });

  it("open=true 时渲染内容与遮罩，遮罩色为 rgba(36,49,66,0.4)（F-014）", () => {
    const { getByText, getByRole, container } = render(<Harness open={true} onClose={() => {}} />);
    expect(getByText("抽屉内容")).toBeTruthy();
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const overlay = container.querySelector(".bg-\\[rgba\\(36\\,49\\,66\\,0\\.4\\)\\]");
    expect(overlay).toBeTruthy();
  });

  it("面板定位与过渡类：right 侧用 right-0，200ms ease-out", () => {
    const { getByRole } = render(<Harness open={true} onClose={() => {}} />);
    const dialog = getByRole("dialog");
    expect(dialog.className).toContain("right-0");
    expect(dialog.className).toContain("duration-200");
    expect(dialog.className).toContain("ease-out");
  });

  it("点击遮罩触发 onClose", () => {
    const onClose = vi.fn();
    const { container } = render(<Harness open={true} onClose={onClose} />);
    const overlay = container.querySelector('[aria-hidden="true"]')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("按 Esc 触发 onClose（可访问性要求）", () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("打开时焦点移入抽屉面板，关闭后焦点归还触发按钮", () => {
    const { getByRole, getByText, rerender } = render(<Harness open={false} onClose={() => {}} />);
    const trigger = getByText("触发按钮");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(<Harness open={true} onClose={() => {}} />);
    expect(document.activeElement).toBe(getByRole("dialog"));

    rerender(<Harness open={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(getByText("触发按钮"));
  });

  it("抽屉打开期间父组件因无关原因重渲染（onClose 引用变化）不应覆盖原始焦点目标（Codex Review P2）", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { getByRole, getByText, rerender } = render(<Harness open={false} onClose={onCloseA} />);
    const trigger = getByText("触发按钮");
    trigger.focus();

    rerender(<Harness open={true} onClose={onCloseA} />);
    expect(document.activeElement).toBe(getByRole("dialog"));

    // 模拟父组件因为无关状态变化（如聊天流式更新）重渲染，传入一个新的 onClose 引用，
    // open 本身没变——effect 不应该因此重新执行并把 previouslyFocusedRef 覆写成抽屉自己。
    rerender(<Harness open={true} onClose={onCloseB} />);
    rerender(<Harness open={true} onClose={onCloseA} />);

    rerender(<Harness open={false} onClose={onCloseA} />);
    // 焦点必须归还最初的触发按钮，而不是（因为被覆写）尝试聚焦已卸载的对话框
    expect(document.activeElement).toBe(trigger);
  });

  it("父组件重渲染后 Esc 仍能调用最新的 onClose（ref 模式不影响关闭功能本身）", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { rerender } = render(<Harness open={true} onClose={onCloseA} />);

    rerender(<Harness open={true} onClose={onCloseB} />);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCloseB).toHaveBeenCalledOnce();
    expect(onCloseA).not.toHaveBeenCalled();
  });

  it("右抽屉在 min-[1100px] 隐藏，左抽屉在 md 隐藏，与对应桌面栏位互补（Codex Review P2）", () => {
    const right = render(<Harness open={true} onClose={() => {}} />);
    const rightWrapper = right.getByRole("dialog").parentElement!;
    expect(rightWrapper.className).toContain("min-[1100px]:hidden");
    expect(rightWrapper.className).not.toContain("md:hidden");
    right.unmount();

    function LeftHarness({ open }: { open: boolean }) {
      return (
        <Drawer open={open} onClose={() => {}} side="left" bgClassName="bg-sidebar-left-bg" widthClassName="w-[220px]">
          <p>左抽屉内容</p>
        </Drawer>
      );
    }
    const left = render(<LeftHarness open={true} />);
    const leftWrapper = left.getByRole("dialog").parentElement!;
    expect(leftWrapper.className).toContain("md:hidden");
    expect(leftWrapper.className).not.toContain("min-[1100px]:hidden");
  });

  it("打开时先以收起态挂载，下一拍才翻到展开态——过渡是真实发生的（Codex Review P2：入场也要动画）", () => {
    vi.useFakeTimers();
    const { getByRole } = render(<Harness open={true} onClose={() => {}} />);

    // 挂载的第一帧应该是"收起"位置，不是直接以最终态出现
    const dialog = getByRole("dialog");
    expect(dialog.className).toContain("translate-x-full");

    // 下一拍才翻到"展开"——这两次不同的样式重算之间，浏览器才会真正播放过渡
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(getByRole("dialog").className).toContain("translate-x-0");

    vi.useRealTimers();
  });

  it("关闭时先播放退场动画（transform 变回收起态）再卸载，不是立刻消失（Codex Review P2：过渡必须真的发生）", () => {
    vi.useFakeTimers();
    const { getByRole, queryByRole, queryByText, rerender } = render(<Harness open={true} onClose={() => {}} />);

    act(() => {
      vi.advanceTimersByTime(0); // 让入场动画先翻到展开态
    });
    expect(getByRole("dialog").className).toContain("translate-x-0");

    rerender(<Harness open={false} onClose={() => {}} />);

    // role 立刻摘除（可访问性：退场期间不该再被当成"打开的对话框"）
    expect(queryByRole("dialog")).toBeNull();
    // 但内容仍然挂载着，且 transform 已经切回"收起"位置——这就是退场动画本身
    const panel = queryByText("抽屉内容")!.closest("div")!;
    expect(panel.className).toContain("translate-x-full");
    expect(queryByText("抽屉内容")).toBeTruthy();

    // 动画时长过后才真正卸载
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(queryByText("抽屉内容")).toBeNull();

    vi.useRealTimers();
  });

  it("焦点陷阱：Tab 从最后一个可聚焦元素回到第一个，Shift+Tab 反向（Codex Review P2）", () => {
    function FocusHarness({ open }: { open: boolean }) {
      return (
        <div>
          <button type="button">触发按钮</button>
          <Drawer open={open} onClose={() => {}} side="right" bgClassName="bg-sidebar-right-bg" widthClassName="w-[300px]">
            <button type="button">第一个</button>
            <button type="button">第二个</button>
          </Drawer>
        </div>
      );
    }
    const { getByText } = render(<FocusHarness open={true} />);
    const first = getByText("第一个");
    const last = getByText("第二个");

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("视口越过右抽屉的桌面断点（min-width: 1100px）时自动关闭，焦点陷阱不再困住隐藏面板（Codex Review P2）", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();

    media.triggerChange(true); // 视口拉宽越过 1100px
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("左抽屉在 md（768px）断点自动关闭", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(
      <Drawer open={true} onClose={onClose} side="left" bgClassName="bg-sidebar-left-bg" widthClassName="w-[220px]">
        <p>左抽屉内容</p>
      </Drawer>,
    );

    media.triggerChange(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("打开的那一刻视口已经在桌面区间时，立刻关闭，不等 resize 事件", () => {
    stubMatchMedia(true); // 挂载时就已经匹配桌面断点
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("视口仍在窄屏区间时不会误触发 onClose", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);

    media.triggerChange(false); // 仍然不匹配桌面断点
    expect(onClose).not.toHaveBeenCalled();
  });
});
