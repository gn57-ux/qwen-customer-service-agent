---
title: CSS 断点隐藏不能替代真正的交互状态收口——响应式组件要配 matchMedia
feature: 7.scenarios-and-degradation
type: reusable
tags: [responsive, matchmedia, drawer, focus-trap, accessibility, breakpoint]
date: 2026-07-31
---

**问题/场景**：`Drawer` 用 `min-[1100px]:hidden`（右抽屉）/`md:hidden`（左抽屉）在跨过桌面断点时把自己视觉隐藏。但如果用户在窄屏打开抽屉后拉宽窗口（或旋转平板），`open` 这个 JS 状态和文档级的 Tab 焦点陷阱监听并不知道"我现在应该已经不存在了"——CSS 类只影响渲染，不影响组件内部状态。结果是键盘用户被困在一个自己完全看不见的面板里（`display` 意义上隐藏但仍在 DOM 且仍持有焦点陷阱），而看得见的桌面栏位反而键盘不可达（Codex Review P2）。

**解法/结论**：用 `window.matchMedia(query)` 监听与 CSS 断点完全相同的媒体查询条件，一旦匹配（视口进入桌面区间）就主动调用收口回调（这里是 `onClose()`），让"视觉隐藏"与"交互状态是否还活跃"保持同步：

```ts
useEffect(() => {
  if (!open || typeof window.matchMedia !== "function") return;
  const mql = window.matchMedia(query);              // 与 CSS 断点用同一个阈值
  const handleChange = () => { if (mql.matches) onCloseRef.current(); };
  handleChange();                                     // 打开的那一刻就可能已经在桌面区间
  mql.addEventListener("change", handleChange);
  return () => mql.removeEventListener("change", handleChange);
}, [open, side]);
```

要点：
- `typeof window.matchMedia !== "function"` 守卫——jsdom 默认不实现 `matchMedia`，测试环境必须能安全跳过。
- 打开的瞬间也要立刻检查一次（`handleChange()` 提前调用一次），不能只等 `change` 事件——万一组件挂载时视口已经在桌面区间（理论边界，即使触发按钮本该已经隐藏）。

**复用方式**：任何"用纯 CSS 断点类做显隐，同时还持有非纯展示状态（焦点陷阱、定时器、订阅）"的组件都要考虑这个模式——不仅是 Drawer/Modal，任何响应式切换渲染形态（如同一数据在移动端用 Sheet、桌面端用 Popover）且带有生命周期副作用的组件，都可能在断点跨越时产生"视觉状态"与"交互状态"不同步的 bug。测试时用手动打桩的假 `MediaQueryList`（`matches` getter + `addEventListener`/`removeEventListener`）模拟断点变化，不依赖真实浏览器视口。
