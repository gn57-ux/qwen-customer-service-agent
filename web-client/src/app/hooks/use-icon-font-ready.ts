import { useEffect } from "react";

const ICON_FONT_FAMILY = "Material Symbols Outlined";
const MAX_POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 400;

/** 去掉 FontFace.family 可能带的引号（浏览器对带空格的 family 名称会
 * 原样保留 CSS 里写的引号，如 `"Material Symbols Outlined"`）。 */
function normalizeFamilyName(family: string): string {
  return family.replace(/^["']|["']$/g, "");
}

/**
 * 直接判断 `Material Symbols Outlined` 这个具体字体是否已经真实加载
 * 完成——遍历 `document.fonts`（可迭代的 `FontFaceSet`），查找 family
 * 匹配且 `status === "loaded"` 的 `FontFace` 对象。
 *
 * ⛔ 不用 `document.fonts.check()`——连续三轮 Codex Review 定位到同一个
 * 根因：`check()` 的浏览器实现语义不可靠，即使目标 `@font-face` 从未
 * 注册成功（Google Fonts 请求被墙/失败），`check()` 也可能因为"没有
 * 找到需要等待的匹配字体"这种误报逻辑而返回 `true`（第三轮 review 原文：
 * "no matching @font-face may be registered, and check() can return
 * true because there is no pending matching font—not because Material
 * Symbols is available"）。直接检查 `FontFace` 对象本身在
 * `document.fonts` 集合里存在、且状态确实是 `"loaded"`，才是唯一不依赖
 * `check()` 模糊语义的可靠判断——这与最初诊断该问题时用
 * `[...document.fonts].map(f => f.family + ' ' + f.status)` 在真实
 * 浏览器里验证过的观察方式一致。
 */
function isIconFontLoaded(): boolean {
  for (const face of document.fonts) {
    if (normalizeFamilyName(face.family) === ICON_FONT_FAMILY && face.status === "loaded") {
      return true;
    }
  }
  return false;
}

/**
 * Material Symbols 字体加载完成前，styles.css 把
 * `.material-symbols-outlined` 设为 opacity:0——避免 fallback 字体把
 * 图标名称（arrow_upward/delete 等）当作可见文字闪现给用户。
 *
 * `document.fonts.ready` resolve 只表示"所有字体加载请求都处理完了"，
 * 失败也是一种处理完——被墙/离线场景下依然会 resolve，所以 resolve 后
 * 还要用 `isIconFontLoaded()` 独立确认目标字体真的在已加载集合里，
 * `ready` resolve 那一刻该判断有时仍是 false（字体注册有短暂延迟），
 * 加一轮有限次数（6 次、间隔 400ms，约 2.4s）的轮询兜底。全部尝试后
 * 仍不可用（字体请求确实失败），**保持图标隐藏，不添加
 * `icons-ready`**——宁可用户看不到图标，也不能让图标显示为英文单词。
 */
export function useIconFontReady(): void {
  useEffect(() => {
    // jsdom（组件测试环境）未实现 CSS Font Loading API，document.fonts
    // 为 undefined——测试环境不需要真的等字体，直接标记 ready。
    if (typeof document === "undefined" || !document.fonts) {
      document.documentElement?.classList.add("icons-ready");
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const markReadyIfAvailable = () => {
      if (cancelled) return;
      if (isIconFontLoaded()) {
        document.documentElement.classList.add("icons-ready");
        return;
      }
      attempts += 1;
      if (attempts < MAX_POLL_ATTEMPTS) {
        timer = setTimeout(markReadyIfAvailable, POLL_INTERVAL_MS);
      }
      // 超过重试次数仍不可用：保持隐藏，不添加 icons-ready，不暴露裸文字。
    };

    document.fonts.ready.then(markReadyIfAvailable).catch(() => {
      // ready 本身理论上不会 reject，防御性兜底：同样不暴露裸文字。
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}
