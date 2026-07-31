---
title: 并发 refresh 需用自增 request id 防止旧请求覆盖新状态
feature: 4.workbench-shell-layout
type: reusable
tags: [react-hook, concurrency, race-condition, polling, refresh, useServiceStatus]
date: 2026-07-31
---

**问题/场景**：`useServiceStatus()` 的 `refresh()` 会被多处并发调用——挂载时的 `useEffect`、`setInterval` 轮询、以及未来 feature 5 聊天 `done`/`error` 回调、Header 上的手动重试按钮。如果一次较慢的旧请求在一次较快的新请求之后才 resolve，`setData()`/`setLoading(false)` 会按到达顺序生效，导致新状态被旧状态覆盖，或者本该仍是 loading 的 UI 提前显示"已完成"。Codex Review 第二轮（P2）指出了这个问题。

**解法/结论**：用 `useRef` 维护一个自增计数器，`refresh()` 入口取号 `const requestId = ++requestIdRef.current`，异步操作 resolve/reject 之后，任何 `setState` 之前先判断 `requestId === requestIdRef.current`，不是最新的就丢弃这次结果（连 `loading` 也不动）。不需要 `AbortController`，因为 `client.status()` 本身不支持取消，只是防止"写 state"这一步生效即可。

**复用方式**：任何"同一个异步刷新/加载函数会被 effect + 轮询 + 用户交互多处并发调用"的 hook 都适用这个模式，直接复制 `use-service-status.ts` 里 `requestIdRef` 的写法即可，feature 5（聊天流式请求 + 取消）如果有类似的"多来源触发同一份状态刷新"场景应优先复用而不是重新设计。
