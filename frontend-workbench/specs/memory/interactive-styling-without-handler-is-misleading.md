---
title: 只画 cursor-pointer/hover 不接点击行为，是误导性 UI——需求里的开放问题resolution也是验收范围
feature: 6.evidence-panel
type: pitfall
tags: [ui, interaction, open-question, requirements, misleading-affordance, citation]
date: 2026-07-31
---

**问题/场景**：`SourceList`（引用来源列表）第一版只给列表项加了 `cursor-pointer` + `hover:bg-brand-light-bg` 视觉样式，没有任何 `onClick`。需求文档的"开放问题"一节明确写了 resolution："点击滚动定位到正文对应引用角标"——这不是一个悬而未决的问题，而是已经拍板的行为规格，只是恰好被放在"开放问题"这个标题下面。当时正文（`AssistantMessage`）里也完全没有渲染引用角标，导致这个点击行为连目标都不存在。Codex Review（P2）指出：视觉暗示"这是可点击的"，但点了什么都不会发生，是误导性的可交互外观。

**解法/结论**：
1. 需求文档里"开放问题"章节如果给出了具体 resolution（不是"待定"、"由 XX 决定"这种真正悬而未决的表述），这个 resolution 就是本 feature 的验收范围，即使 design.md 的组件拆分表没有单独列一行。
2. 发现"要实现的交互行为，其目标对象还没有被渲染出来"时，要把目标对象一起实现，不能只实现发起点。本例中，点击滚动的目标是"正文里的引用角标"，而角标本身此前从未被渲染——正确做法是先在 `AssistantMessage` 里渲染角标（给每个来源一个稳定 id），再在 `SourceList` 里用同一套 id 生成规则触发 `scrollIntoView()`。
3. 双方共享的 id 生成规则要抽成独立纯函数（见 [[unique-max-selection-needs-strict-greater-than]] 同一 feature 里 `citation.ts` 的 `citationElementId()`），不要各写一份字符串模板。

**复用方式**：审查/实现任何"设计稿有 `cursor-pointer` 样式但需求只说了大概方向"的元素时，先确认：①这个行为是否在需求的"开放问题"或"待评审"章节里有具体 resolution（有就是本期范围）；②行为的目标对象是否已经存在（不存在就要一并实现，不能只做视觉）。
