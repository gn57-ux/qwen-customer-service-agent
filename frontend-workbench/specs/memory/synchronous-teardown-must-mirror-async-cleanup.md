---
title: 同步中断路径必须搬全异步收尾原本做的每一件事，不能只搬一半
feature: 5.chat-stream-conversation
type: pitfall
tags: [react-hook, abort-controller, race-condition, cleanup, onSettled, synchronous-teardown]
date: 2026-07-31
---

**问题/场景**：`useChatStream()` 里"切换会话/用户点击停止/清空会话"这三处都需要立刻中断在途的流式请求。第一版只调用 `abortController.abort()`，指望原来 `streamChat()` 的 `catch` 块通过比较 `turnTokenRef` 来补写 `phase: "aborted"`——但如果中断后立刻发起新一轮（token 已前进），异步 `catch` 进来发现 token 不是最新，直接 `return`，`aborted` 永远补不上，消息卡死在 `streaming`（Codex Review 第 3 轮）。改成同步的 `abortActiveTurn()` 统一收尾后，又漏掉了原 `finally` 块里的 `onSettled?.()` 调用——这条同步路径根本不会进到那段 `finally`（因为它绕过了整个 `runTurn()` 的 await 链），导致"取消/切会话"这两种路径顶栏服务状态刷新缺失（Codex Review 第 4 轮）。

**解法/结论**：把"正常收尾"（`runTurn()` 内部 `finally` 块）里做的每一件事列成清单：① 释放 `abortRef`/`activeTurnRef`，② `setIsStreaming(false)`，③ 触发 `onSettled?.()`，④（视情况）写 `phase` 到消息。写"同步强制收尾"旁路（这里是 `abortActiveTurn()`）时，逐条核对是否都搬过来了，而不是照着最初触发它的那一个 bug 修一处漏一处。判断标准：凡是"正常完成"和"被中途打断"两条路径最终都要把外部可观察状态（UI 展示的 phase、isStreaming、依赖 onSettled 的下游副作用）收敛到同一种确定性，就必须共享同一份收尾逻辑，而不是各写一半。

**复用方式**：任何用 `AbortController` 实现取消的 hook，只要存在"提前于 promise reject 之前就需要让状态归位"的场景（用户主动取消、外部条件变化导致的强制中断），都要留意这个模式——最好把"收尾要做的事"抽成一个函数，正常路径（`finally`）和强制路径（`cancel`/条件变化的 `useEffect`）都调用同一个函数，而不是分别手写一遍，参见 `use-chat-stream.ts` 的 `abortActiveTurn()`。配合 [[controlled-hook-with-targeted-write-for-multi-entity-state]] 一起看。
