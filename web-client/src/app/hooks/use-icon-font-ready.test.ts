/**
 * useIconFontReady()：Feature 9 任务 1 的图标加载防闪烁修复。
 * jsdom 没有 CSS Font Loading API（document.fonts undefined），必须
 * 降级为直接标记 ready，不能抛异常——这是本次回归的直接触发点
 * （Codex Review 第一轮：TypeError: Cannot read properties of
 * undefined (reading 'ready')）。
 *
 * 第 2/3 个用例覆盖第二轮 Codex Review（`document.fonts.ready` resolve
 * 不代表字体真的加载成功，被墙/失败时也会 resolve）。
 * 第 4/5 个用例覆盖第三轮 Codex Review（`FontFaceSet.check()` 语义本身
 * 不可靠，即使目标字体从未注册成功也可能误报 true；改为直接遍历
 * `document.fonts` 查找 family 精确匹配且 `status==="loaded"` 的
 * `FontFace`，同名但未加载完成、或已加载但不同名，都不能算数）。
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useIconFontReady } from "./use-icon-font-ready.ts";

interface FakeFontFace {
  family: string;
  status: string;
}

/** 模拟可迭代的 FontFaceSet：`faces` 用可变数组，测试里可以在 resolve
 * 之后动态改变其内容，模拟"字体过一会儿才真正 loaded"的轮询场景。 */
function mockFonts(faces: FakeFontFace[], readyPromise: Promise<unknown>) {
  const original = document.fonts;
  const fontsLike = {
    ready: readyPromise,
    [Symbol.iterator]: function* () {
      yield* faces;
    },
  };
  Object.defineProperty(document, "fonts", { value: fontsLike, configurable: true });
  return () => Object.defineProperty(document, "fonts", { value: original, configurable: true });
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("icons-ready");
});

describe("useIconFontReady", () => {
  it("document.fonts 不存在（jsdom）时不抛异常，直接标记 icons-ready", async () => {
    expect(() => renderHook(() => useIconFontReady())).not.toThrow();
    await waitFor(() => {
      expect(document.documentElement.classList.contains("icons-ready")).toBe(true);
    });
  });

  it("ready resolve 且 document.fonts 中存在已加载的 Material Symbols Outlined 时才标记 icons-ready", async () => {
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const restore = mockFonts([{ family: '"Material Symbols Outlined"', status: "loaded" }], readyPromise);

    try {
      renderHook(() => useIconFontReady());
      expect(document.documentElement.classList.contains("icons-ready")).toBe(false);

      resolveReady();
      await waitFor(() => {
        expect(document.documentElement.classList.contains("icons-ready")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("Codex Review 第一轮 P1：ready resolve 但字体集合里完全没有匹配项（字体请求失败）时，不标记 icons-ready，不暴露裸文字", async () => {
    const readyPromise = Promise.resolve();
    // 空字体集合，模拟 Google Fonts 被墙/请求失败、@font-face 从未注册成功的场景。
    const restore = mockFonts([], readyPromise);

    try {
      renderHook(() => useIconFontReady());
      // 给足所有轮询窗口（6 次 × 400ms）后仍应保持隐藏。
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(document.documentElement.classList.contains("icons-ready")).toBe(false);
    } finally {
      restore();
    }
  }, 10000);

  it("Codex Review 第三轮 P1：family 匹配但 status 不是 loaded 时不能算数（不能只看字体是否存在）", async () => {
    const readyPromise = Promise.resolve();
    const restore = mockFonts([{ family: "Material Symbols Outlined", status: "unloaded" }], readyPromise);

    try {
      renderHook(() => useIconFontReady());
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(document.documentElement.classList.contains("icons-ready")).toBe(false);
    } finally {
      restore();
    }
  }, 10000);

  it("Codex Review 第三轮 P1：其他字体已 loaded 但 family 不是 Material Symbols Outlined 时不能误判为可用", async () => {
    const readyPromise = Promise.resolve();
    const restore = mockFonts([{ family: "Inter", status: "loaded" }], readyPromise);

    try {
      renderHook(() => useIconFontReady());
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(document.documentElement.classList.contains("icons-ready")).toBe(false);
    } finally {
      restore();
    }
  }, 10000);
});
