---
title: 用 node:test 的 mock.module() + 真实 Hono app 测生产 route，不改生产代码
feature: 1.contract-retrieval-counts
type: reusable
tags: [testing, hono, mock.module, node-test, route, sse, streaming, mastra]
date: 2026-07-31
---

**问题/场景**：需要验证 `POST /customer-service/chat` 和 `POST /customer-service/stream` 两条真实 HTTP/SSE 路径返回一致的响应字段（AC-005：两条路径不能出现字段差异）。直接方案（起真实 Mastra Server + FastAPI + llama-server 做端到端测试）在多数开发/CI 环境不可行（本项目的 `agent.e2e.test.ts` 就因为依赖这套真实服务而在没有这些服务时全部 cancelled）。但"调用同一个纯函数两次再比较"只能证明函数本身确定性，不能证明两条真实路径确实都在用它、确实字段一致——是重言式，CR 会打回。

**解法/结论**：
1. 用 `node:test` 的 `mock.module(specifier, { namedExports: {...} })`（`--experimental-test-module-mocks`，Node 22.3+ 起可用）替换掉被测 route 依赖的下游模块（这里是 `orchestration.ts` 的 `runAgentTurn`/`streamAgentTurn`）——**只在测试进程里生效，不改一行生产源码**。
2. `mock.module()` 必须在 `import`（或动态 `import()`）目标模块**之前**调用，因为 ESM 静态 import 在模块顶层就已解析绑定；用动态 `const {...} = await import("./customer-service.ts")` 延后加载。
3. **关键细节**：mock 的 specifier 字符串按**调用 mock.module() 的这个文件**做相对路径解析，不是按被 mock 模块的原始导入者解析。要保证两边解析到同一个绝对模块，把测试文件放在和被测 route 文件相同的目录，用完全相同的相对路径字符串（如都写 `"../orchestration.ts"`）。
4. 拿到真实导出的 `registerApiRoute()` 对象（`{path, method, handler}`）后，挂进一个全新建的 `new Hono()` app（`app.post(route.path, route.handler)`），用 `app.request(path, init)` 发真实请求——这样 `streamSSE()` 之类依赖真实 Hono `Context` 内部机制（`c.header`/`c.newResponse`/`c.req.raw.signal`）的代码可以正常工作，不需要手搓一个 fake context。
5. 遇到 `@mastra/core` 内部打包的 Hono 类型与顶层 `hono` 包类型对不上号（纯类型层面摩擦，运行时是同一个模块实例）时，直接 `as any` 断言——生产代码（`routes/customer-service.ts` 顶部注释）已经因为同样原因这么做过，测试代码遇到同一个坑不用另想办法。
6. SSE 响应体是 `event: xxx\ndata: {...}\n\n` 格式（注意冒号后有空格），解析时按 `\n\n` 切事件块，块内找 `event: done` 行确认事件类型，再取 `data:` 开头的行 `.slice("data:".length).trim()` 后 `JSON.parse`。

**复用方式**：任何"要验证某个 Mastra/Hono route 的真实响应，但完整依赖链（真实 Agent/真实下游服务）太重"的场景，都可以套这个模式：mock 掉紧邻 route 的那一层依赖，保留 route 层本身（包括其真实的 Hono 绑定、SSE 写入逻辑）不动。这比"只测纯函数"更接近真实覆盖，又比"起完整服务端到端测试"轻量得多。
