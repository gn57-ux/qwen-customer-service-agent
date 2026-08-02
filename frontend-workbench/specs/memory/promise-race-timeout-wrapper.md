---
title: 给不支持外部 AbortSignal 的既有函数套超时上限，用 Promise.race 不用改造它
feature: 2.service-status-endpoint
type: reusable
tags: [timeout, promise-race, abort-signal, health-check, probe]
date: 2026-07-31
---

**问题/场景**：`GET /customer-service/status` 要求每项下游探测独立超时（≤2s），
且任一下游挂起不得阻塞整体响应。复用的两个既有健康检查函数——
`QdrantKnowledgeStore.health()`（内部 30s 超时）与 `LlamaCppReranker.health()`
（内部可配置超时，默认 3s）——都是**自带超时、不接受外部 AbortSignal**的实现。
如果按最初设计的 `probe(name, fn: (signal) => Promise<boolean>)` 把 signal 传给
它们，signal 会被直接忽略，超时形同虚设。

**解法/结论**：不要求被包装的函数支持外部取消，改用 `Promise.race()` 在包装器
这一层保证"总能按时返回"：

```ts
async function probe(name: string, check: () => Promise<boolean>, timeoutMs: number): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const guardedCheck = check().catch((err) => {
    console.warn(`[health] ${name} 探测失败：${err instanceof Error ? err.message : String(err)}`);
    return false; // 异常也归一为 false，不外抛
  });
  try {
    return { ok: await Promise.race([guardedCheck, timeout]) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

要点：
- `guardedCheck` 内联 `.catch()`，即使 `timeout` 先赢得竞赛，`check()` 的 promise
  仍在后台运行也不会产生 unhandled rejection；
- 包装器本身保证在 `timeoutMs` 内返回，不管被包装函数自己的超时设多长；
- 被包装函数若真的挂起太久，只是"探测层不再等它"，底层请求可能仍在后台跑到
  自己的超时才结束——这对健康检查场景是可接受的（不追求真正取消底层 I/O，
  只追求不阻塞调用方）；如果场景需要真正释放底层连接/资源，则必须让被包装函数
  自己支持 AbortSignal，这个模式不能替代那种需求。

**复用方式**：任何"需要给一批异构的、超时行为不统一的既有函数套一个统一超时上限"
的场景都适用——不需要为了统一超时去改造每一个被包装的函数。
