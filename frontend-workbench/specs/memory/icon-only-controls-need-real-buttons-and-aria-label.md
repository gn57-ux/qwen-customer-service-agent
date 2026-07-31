---
title: Stitch 设计稿的图标按钮/可点击列表项要补键盘与屏幕阅读器语义
feature: 4.workbench-shell-layout
type: reusable
tags: [accessibility, a11y, aria-label, aria-hidden, keyboard, material-symbols, button, li-onclick]
date: 2026-07-31
---

**问题/场景**：Stitch 设计稿里两种常见模式在直接照抄 HTML 结构时会产生可访问性缺陷，Codex Review 分两轮各挑出一处：
1. 会话列表项写成 `<li onClick={...}>`——键盘/辅助技术用户无法聚焦、无法用 Enter/Space 激活，无法切换会话。
2. 图标按钮在小屏幕用 `hidden md:inline` 隐藏中文文案，只剩 Material Symbols 的 ligature 文本（如 `delete`）作为按钮的可访问名称，屏幕阅读器会读出这个实现细节文本而不是"清空会话"。

**解法/结论**：
- 可交互的列表项：渲染成 `<li><button onClick=...>...</button></li>`（而不是给 `<li>` 绑 onClick），激活态用 `aria-current="true"` 标记，而不仅是视觉样式区分。
- 图标 + 隐藏文案的按钮：给 `<button>` 加 `aria-label="{中文语义}"`，给纯装饰性的图标 `<span>` 加 `aria-hidden="true"`，避免图标文本混入可访问名称。

**复用方式**：本项目 Stitch 设计稿里这两种模式会反复出现——feature 5 的发送按钮（图标 + 可能隐藏的文案）、feature 6 的引用来源 chip（`bg-citation-bg` 那种可点击 `<span>`）、feature 7 的响应式抽屉触发器，落地时直接照此处理，不要等 Codex Review 再来回一轮：可点击元素默认用 `<button>`，图标按钮默认补 `aria-label` + 图标 `aria-hidden`。
