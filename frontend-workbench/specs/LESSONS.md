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

## 2026-07-31 — Feature 2: service-status-endpoint

**Stop hook CR 两轮才过，两个共性问题值得所有后续 feature 记住：**

1. **发现"设计文档字面表述与真实架构不符"时，光在 tasks.md/LESSONS 记录不够，必须回头改权威 specs（requirements.md/design.md）。** design.md 写 `probeLlamaServer` 探测 "llama-server :8002"，但读码后发现 `customer-service-agent.ts` 明确注释"8002 只在 FastAPI 进程内部转发，不应该被任何客户端直接访问"——真正该探测的是 FastAPI `:8000/health`。第一轮我只在实现里做对了、在 tasks.md 记了一笔"发现的偏差"，CR 打回：这样 Feature 4（顶栏展示）、Feature 8（验收门禁）如果只读 requirements.md/design.md 会继续按错误口径走。**教训**：代码实现纠正了 specs 的错误后，必须回过头把 requirements.md/design.md 也改成新的权威版本（打版本号、写清楚"为什么改、改前是什么"），不能让权威文档和实际实现长期不一致。tasks.md/LESSONS 只负责记录"发生过什么"，不能替代"当前权威是什么"。

2. **"归一化"要看清楚是单侧还是双向。** `matchesModelName()` 第一版只对 Ollama 返回的 `id`做 `split(":")[0]`，没对配置里的 `target` 做同样处理。多数情况下 target 本来就不带 tag，所以看起来"能用"，但一旦 target 也带 tag（如配置写成 `bge-m3:latest`），或者两边 tag 恰好都存在但不同，比较就会给出错误结果。**教训**：写归一化比较逻辑时，默认假设"两侧都可能是未归一化的原始输入"，除非有铁证证明某一侧永远是规范形式；补测试时要专门构造"两侧都需要归一化"的用例，不能只测"一侧脏一侧干净"这一种组合。

**技术要点（可复用）**：
- `Promise.race([check().catch(()=>false), timeoutPromise])` 是给"内部自带超时、不接受外部 AbortSignal"的既有函数（如 `QdrantKnowledgeStore.health()`、`LlamaCppReranker.health()`）套超时上限的可靠办法——不需要改造被包装的函数，探测层自己保证"总能在 N ms 内返回"，即使被包装的 promise 仍在后台跑（内联 `.catch` 避免 unhandled rejection）。
- 第三方服务（尤其是 Ollama 这类本地推理服务）的健康检查端点，字段语义可能和直觉不一致：FastAPI 的 `/health` 在服务"活着但没准备好"（`not_loaded`/`degraded`）时依然返回 HTTP 200，只有解析 body 里的业务字段才能判断真实可用性——**不要用"HTTP 2xx 即健康"这个默认假设**，先读被探测服务的健康端点实现，确认它是否会用非 200 状态码表达"不健康"。
- "解析第三方健康检查响应"这类逻辑要提取成不发真实请求的纯函数（如 `parseFastApiHealthStatus(httpOk, body)`），既能覆盖"HTTP 200 但业务状态异常"这种组合分支，也不需要为了测试导出内部 URL 常量或起真实服务。

## 2026-07-31 — Feature 3: workbench-app-scaffold

**Stop hook CR 一轮即过，只有一处小修：文档注释里写"禁止的字面量示例"会被 Feature 8 的门禁正则误命中。**

`client-context.tsx` 顶部注释原文写着"⛔ 组件层禁止 `new MastraClient(` / `fetch(` / `axios`……不得配置任何被禁端口（8000/8001/8002/6333/8787/11434）"——这是在**说明规则**，不是违反规则，但 Feature 8 的门禁扫描（`grep -rnE ':(8000|8001|...)|getAgent\(' web-client/src`）是纯文本匹配，分不清"这行代码调用了 fetch"和"这行注释在提醒别调用 fetch"。CR 要求把注释改成不含这些字面量的转述（"组件层禁止绕过 useClient() 自行发起网络请求或直连其他后端服务"），逻辑一行没动。

**教训**：写文档/注释提醒"禁止使用 X"时，如果 X 恰好是某个门禁正则会匹配的字符串（端口号、函数名、危险 API 名），要么用转述避开字面量，要么确认门禁扫描时排除注释行——本项目选择前者（改注释），因为 Feature 8 的扫描脚本本来就没有排除注释的逻辑，扫描全部源码文本更简单可靠，比教每个人"注释要用转述"更省心的是让扫描脚本本身排除注释，但这个决定影响 Feature 8 的实现，本 feature 阶段选择成本最低的一侧（改注释）先解决。**Feature 8 实现门禁扫描脚本时应意识到这个假阳性来源**，评估是否需要排除注释/字符串字面量，或者继续要求全仓库注释都用转述规避。

**技术要点**：Vite + React 19 + Tailwind v3（非 v4——v4 的 CSS-first `@theme` 配置与本项目 design.md 指定的 `tailwind.config.ts` + `postcss.config.js` 架构不匹配，选 v3 保持与 specs 描述一致）+ Vitest + jsdom 的标准脚手架组合，`npm run build` 产物需要 `.gitignore` 里加 `dist/`（本仓库此前缺失这条规则，若不补会把构建产物提交进去）。

## 2026-07-31 — Feature 4: workbench-shell-layout

**Stop hook CR 三轮才过，两轮各揪出一个共性问题，对 feature 5/6/7 的交互组件都适用：**

1. **轮询与手动/事件触发的 refresh 并发时，慢的旧请求可能在新请求之后落地并覆盖状态。** 第一版 `useServiceStatus()` 的 `refresh()` 没有任何并发保护——`useEffect` 挂载探测、`setInterval` 轮询、未来 feature 5 的聊天 `done`/`error` 回调都会调用同一个 `refresh()`，一旦旧请求比新请求慢，`setData()`/`setLoading(false)` 会按到达顺序而非发起顺序生效，产生"新状态被旧状态覆盖"或"明明有更新的请求在途却提前显示 loading=false"的假象。**教训**：任何"同一个异步刷新函数会被多处并发调用"的 hook，必须在发起时记一个自增的 request id（或用 `AbortController`），回调里比对"我还是不是最新一次请求"再决定是否写 state，不能假设调用方会自己做防抖/排队。
2. **图标按钮的可访问名称：小屏幕文字用 `hidden` 隐藏后，唯一可见内容是 Material Symbols 的 ligature 文本（如 `delete`），屏幕阅读器会读出这个实现细节而不是中文语义。** 同理，纯 `onClick` 的 `<li>` 对键盘/辅助技术不可聚焦、不可激活。**教训**：Stitch 设计稿里"图标 + `hidden md:inline` 文案"和"可点击的非按钮元素（`<li>`/`<div onClick>`）"这两种模式在本项目会反复出现（feature 5 的发送按钮、feature 6 的引用来源 chip 等）——落地时统一按此处理：可交互的列表项一律用真实 `<button>`（配 `aria-current`/`aria-selected` 标记激活态），纯图标按钮补 `aria-label`，图标 `<span>` 加 `aria-hidden="true"`。

**技术要点（可复用）**：
- 并发防覆盖的最小实现：`useRef` 计数器，`refresh()` 入口 `const requestId = ++idRef.current`，每个 `setState` 前判断 `requestId === idRef.current` 才生效；无需引入 `AbortController` 或额外依赖。
- React Testing Library 的 `render()` 返回的 `getByText`/`getByRole` 默认查询整个 `document.body`，不局限于自己的 `container`——同一个 `it()` 里渲染两次而不 `unmount()`/`cleanup()` 会导致重复元素报错；测试文件必须在 `afterEach` 里调用 `cleanup()`（或手动 `unmount()`），本项目此前的 App.test.tsx 用 `document.body.innerHTML = ""` 也能work，但更推荐官方 `cleanup()`。
