---
title: 组件动画/生命周期状态要在 render 阶段同步派生，不能放进 useEffect
feature: 7.scenarios-and-degradation
type: reusable
tags: [react, useEffect, render-phase, animation, drawer, state-adjustment]
date: 2026-07-31
---

**问题/场景**：`Drawer` 组件需要"prop `open` 变 false 的那一刻仍然渲染一帧（用于播放退场动画），之后才真正卸载"。第一版用 `useEffect(() => { if (!open) setIsClosing(true) }, [open])` 实现——但 effect 要等 commit 之后才跑，比 `open` prop 的变化晚一整个渲染周期。结果是：`open` 变 false 的这次渲染里，组件按照旧的"直接卸载"逻辑判断为"不该渲染"而立刻返回 `null`，`isClosing` 还没来得及被置为 true，退场动画完全没有机会开始（Codex Review P2，连续两轮才定位到根因）。

**解法/结论**：改用 React 官方文档描述的"根据 prop 变化调整 state"模式——在函数组件体的顶部（渲染阶段，不在任何 effect 里）用一个 ref 记录上一次的 prop 值，直接比较并同步调用 `setState`：

```ts
const [isClosing, setIsClosing] = useState(false);
const prevOpenRef = useRef(open);
if (prevOpenRef.current !== open) {
  prevOpenRef.current = open;
  if (!open) setIsClosing(true);
}
```

这样当 `open` 从 true 变 false 时，`isClosing` 在**同一次渲染流程**里就被设置为 true（React 会丢弃当前渲染，用新 state 立刻重渲染，用户不会看到任何中间态），组件在这一帧仍然判定为"应该渲染"，退场动画才有机会播放。

反过来，"入场"动画需要相反的时序：先以"收起"位置挂载，下一拍才翻到"展开"位置——这次不能用同步派生（那样只有一次样式重算，没有过渡可言），要用一个真实的异步 tick（`setTimeout(fn, 0)` 即可，不必用 `requestAnimationFrame`）。同一个组件里，"关闭要同步、打开要异步"取决于"这一帧该不该被用户看见"，不是无脑套用同一种手法。

**复用方式**：任何"某个 prop 翻转必须立刻反映到另一个 state，且不能有一帧的时序错位"的场景都适用——modal/drawer 的退场动画、受控组件同步内部影子 state、根据 prop 重置计时器等。判断信号：如果发现"效果本该在这一帧生效，但测试/实际表现里晚了一拍"，先检查是不是该同步逻辑被放进了 `useEffect` 而不是渲染阶段的 ref 比较。
