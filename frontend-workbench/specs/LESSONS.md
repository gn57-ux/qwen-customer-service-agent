# LESSONS — 架构决策与踩坑记录

## 2026-07-31 — Feature 1: contract-retrieval-counts

**Stop hook CR 第一轮未通过，修了 4 项才过，记录下来避免后续 feature 重蹈：**

1. **`ChatResponseBody` 的组装点在 `routes/customer-service.ts`（两处：chat 与 stream 分支），不在 `orchestration.ts`**——`orchestration.ts` 只产出 `AgentRunResult`（`reply`/`toolCalls`/`route`），不产出 HTTP/SSE 契约。v1 specs 一度写错了这一点，已在 v2 修正并明令禁止为此改 `orchestration.ts`。后续任何涉及响应体字段的 feature，改动落点看 `buildContractExtras()`（两处组装点的共用出口），不要碰 orchestration。

2. **可空字段必须显式赋 `null`，不能省略成 `undefined`。** 第一版 `toOrderDetails()` 用 `if (!(from in src)) continue` 跳过缺失键，导致 10 个白名单字段变成"可选属性"（TS `?:`）。CR 指出这允许字段静默消失，前端无法区分"服务端没给"和"映射函数漏了"。改法：字段全部必填（去掉 `?`），映射函数无条件遍历全部白名单键，缺失/类型不符一律显式 `null`。

3. **`found`/`error` 之类的判定字段必须在数据提取前就短路，不能事后过滤。** 第一版 `toOrderDetails(r.order)` 无条件调用，只是"希望" `order` 字段在 `found:false` 时是空的——但工具层完全可能因为异常/未来改动在失败时也带上部分数据。正确做法是 `r.found ? toOrderDetails(r.order) : undefined`，在调用点就把不该展示的分支挡住，不依赖上游"应该"干净。

4. **"调用两次同一个纯函数再比较"不能证明两条真实路径行为一致。** 想验证 chat 和 stream 是否给出一致结果，必须真的经过两条路径（哪怕是 mock 掉底层依赖），而不是对同一个函数喂两次相同输入——那只证明了函数本身的确定性，是重言式。这里用 `node:test` 的 `mock.module()`（`--experimental-test-module-mocks`）加真实 `Hono` app 挂载生产 route handler，绕开了需要整套 Mastra Server + FastAPI + llama-server 才能测的困境，且不改一行生产代码。

**技术要点（可复用）**：
- `mock.module()` 的 specifier 解析是相对**调用它的文件**，不是相对被 mock 的模块的原始导入者。要让 mock 命中同一个模块，把测试文件放在与生产文件相同的目录，用完全相同的相对路径字符串。
- `@mastra/core` 内部打包的 Hono 类型与顶层 `node_modules/hono` 结构对不上号（纯类型层面摩擦，运行时是同一个模块实例），生产代码里已经有 `c as any` 的先例（`routes/customer-service.ts` 顶部注释），测试代码遇到同样问题时同样处理，不要因此改动生产签名。
- 涉及外部真实服务（Qdrant/Ollama/Reranker/FastAPI/llama-server）的分支测试，如果某个分支根本不需要外部服务就能触发（比如空数组早退），把这段组装逻辑提取成纯函数，让测试直接喂构造数据，不要用"凑一个搜不到的 query"这种非确定性手段。

**环境限制（非代码问题，记录供后续 feature/QA 参考）**：
- Reranker（`:8787`）需要 `npm run rerank:up` 手动拉起本地 GGUF 模型，本次开发环境未启动，`rerank:test` 的 25 项测试全部 cancelled（非 fail）。**Feature 8 最终质量门禁阶段必须补跑**，要求 25/25 PASS 才能算门禁通过。
- Qdrant（`:6333`）与 Ollama（`:11434`）在本次环境中是真实在线的，`rag:test`（10/10）与 `search-knowledge-base-tool.ts` 的实时检索测试可以真实跑通。
- FastAPI（`:8000`）/llama-server（`:8002`）未启动，`agent.e2e.test.ts` 全部 cancelled——这是 Feature 1 范围外的既有环境依赖，不阻塞本 feature，但同样需要在后续端到端验收前解决。
