---
title: 从集合选唯一最大项要用严格大于维护下标，不能先求 Math.max() 再等值判断
feature: 6.evidence-panel
type: pitfall
tags: [derive, rank-1, tie-break, max, deterministic, evidence-panel]
date: 2026-07-31
---

**问题/场景**：`deriveEvidence()` 的「高优」标记要求「只有 rerankScore 最大的那一项」（rank-1 语义）。第一版实现是 `const maxRerank = Math.max(...scores); const highlighted = score === maxRerank`——当多个来源的 `rerankScore` 并列最高时，所有并列项都会被判定为 `highlighted`，破坏"只有一项"的语义（Codex Review P2）。

**解法/结论**：不要用"求最大值 + 逐项等值比较"的两步法，改成一次遍历维护"目前为止最大值所在的下标"：

```ts
let topIndex = -1;
let maxScore = Number.NEGATIVE_INFINITY;
items.forEach((item, index) => {
  if (item.score !== null && item.score > maxScore) {   // 严格大于，不是 >=
    maxScore = item.score;
    topIndex = index;
  }
});
// highlighted = index === topIndex
```

严格大于（`>`）保证并列时只有第一个达到最大值的下标会被记录，天然形成确定性的 tie-break（先到先得），不需要额外的排序或第二轮比较。

**复用方式**：任何"从数组里选唯一的第一名/最大值项"的派生逻辑都适用——排行榜首位、最高优先级项、最新时间戳对应项等。判断信号：如果需求描述里出现"唯一"、"最...的那一项"、"rank-1"这类措辞，而实现是 `Math.max()` 后对每项做 `===` 比较，就要警惕并列场景下会产生多个"唯一项"。
