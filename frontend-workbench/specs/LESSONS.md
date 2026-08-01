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

## 2026-07-31 — Feature 5: chat-stream-conversation

**Stop hook CR 四轮才过，前两轮是我自己设计上偷懒留下的坑（没有先读透 design.md 的数据模型就动手），后两轮是同一类"同步 vs 异步收尾"问题的连续两次追加：**

1. **`Session.messages` 字段不能因为"当前 feature 用不上"就删掉。** Feature 4 阶段我在 `session.ts` 里给 `Session` 加了 `messages: Message[]`，design.md 明确写了"切换会话"应该保留各自历史、标题取首条消息截断。到 Feature 5 我图省事，把 `messages` 字段整个删掉、用一个全局 `useChatStream()` 内部状态 + 切换会话时 `reset()`，理由是"反正还没有持久化"——这混淆了"暂不持久化到磁盘"和"内存里也不用分会话存"，Codex 一次性挑出两个关联问题（切换会话丢消息、标题不跟着首条消息更新）。**教训**：改数据模型前，先确认这个字段是不是权威文档（design.md/requirements.md）已经明确定义了语义，不能因为当前 task 描述里没提就删——没提可能只是因为那个字段的读端在下一个 feature 才落地，删掉等于抢先违反了尚未轮到但已经写好的设计。
2. **"受控 hook + 定向写入"模式**：把 `useChatStream()` 从"自己持有 messages state"改成接收 `{sessionId, messages, onMessagesChange}`，写回时永远带上"这个 turn 发起时绑定的 sessionId"（在调用的那一刻用局部变量固定住，不要读取会变化的外部状态)，而不是"当前显示的是哪个会话"。这样切换会话不会让后续的流式事件写错地方，也不会因为组件重渲染导致的闭包更新而串会话。**可复用**：任何"多个独立实体（会话/标签页/文档）共享同一个异步操作 hook"的场景都适用这个模式。
3. **同步中断 vs 异步 catch 收尾，两者必须做同一件事，缺哪个都会露馅。** 第一次把"切换会话中断在途请求"实现成只 `abort()` + 等异步 `catch` 里比较 `token` 来补写 `aborted`——但如果用户切走会话后立刻又发了一条新消息，`token` 已经被新一轮占用，异步 `catch` 进来一看 token 不对直接 `return`，`aborted` 永远补不上，消息卡死在 `streaming`（CR 第 3 轮）。改成一个同步的 `abortActiveTurn()`，在切换/取消/清空这三个入口统一调用，立刻把状态收尾干净，不依赖后到的 promise reject。**但改完之后又漏了一件事**：这个同步收尾路径绕过了原来 `finally` 里的 `onSettled?.()` 调用（那里因为 token 已经不是最新，直接跳过了），导致"取消/切会话"这两种路径顶栏服务状态不再刷新（CR 第 4 轮）。**教训**：一旦把"正常收尾"拆出一条"同步强制收尾"的旁路，要逐项核对原来 `finally`/`catch` 里做的所有事（状态归位、副作用回调、资源释放），同步旁路必须补齐全部，不能只搬一半。

**技术要点（可复用）**：
- 并发防护除了 [[stale-concurrent-refresh-must-guard-by-request-id]] 的"自增 token 比较"外，还需要一个"当前在途操作绑定哪个实体"的 ref（这里是 `activeTurnRef: {sessionId, assistantId}`），否则同步中断时"该往哪条消息写 aborted"这件事无从得知——单纯的 token 递增只能拒绝旧数据，不能告诉你旧数据原本要去哪。
- 测试 jsdom 里没有真实布局，`scrollHeight`/`clientHeight`/`scrollTop` 全部是 0/可写但不联动；要测滚动策略必须用 `Object.defineProperty` 手动打桩这三个属性（`scrollTop` 要给 get/set 都接上同一个闭包变量），再用 `fireEvent.scroll()` 触发组件自己的 `onScroll` 处理器。

## 2026-07-31 — Feature 6: evidence-panel

**Stop hook CR 三轮才过，三个问题彼此独立，但都属于"用等值/相等判断代替确定性排名"或"画了交互外观却没接行为"这类容易被自己说服"应该没问题"的坑：**

1. **"最大值"判定不能用 `=== max` 这种等值比较来选唯一项——并列时会选出所有项。** `deriveEvidence()` 的「高优」判定第一版是 `source.rerankScore === maxRerank`，`rerankScore` 并列最高时会把所有并列项都判定为高优，违反"高优只能有一项"的 rank-1 语义。**教训**：任何"从集合里选唯一最大/最小项"的需求，必须显式维护一个"目前为止最大值所在的下标"（`topIndex`），比较时用 `>`（严格大于）而不是先求 `Math.max()` 再对每项做 `===` 判等——后者在等值场景下退化成了"选出全部并列项"而不是"选出其中一项"。
2. **React key 用业务字段（这里是 `label`）而不是下标，是防闪烁的正确方向，但没考虑"同一个业务字段值可能重复"的情况。** 同一工具被重复调用（重试/多次查订单）会产生多个 label 完全相同的节点，直接拿 label 当 key 会撞车，React 可能复用/丢弃错误的 DOM 节点。**教训**：用业务字段当 key 解决的是"数组重排后如何找回同一个逻辑节点"，但业务字段本身可能不唯一——正确做法是给业务字段加一个"这是第几次出现"的序号后缀（`` `${label}#${occurrence}` ``），只要生成顺序在两次渲染之间保持一致（这里是"tool-result 到达顺序不变"），加了序号的 key 依然是稳定的，同时解决了唯一性。
3. **画了 `cursor-pointer` + hover 态但没接真实点击行为，是"看起来能用、实际什么都不做"的误导性 UI。** `SourceList` 第一版只做了视觉可交互样式，需求 §开放问题明确要求"点击滚动定位到正文对应引用角标"，但正文（`AssistantMessage`）当时完全没有渲染引用角标，点了自然什么都不会发生。**教训**：需求文档里对"开放问题"给出的具体 resolution（哪怕看起来只是次要交互细节）也是这个 feature 的验收范围，不能因为"design.md 没在组件拆分表里单独列一行"就默认放到下一个 feature；发现"点击目标还不存在"时，正确做法是把目标（这里是引用角标）一起实现，而不是先上视觉再等下一轮 CR 来指出。

**技术要点（可复用）**：
- 唯一 top-1 选择：`let topIndex = -1, maxScore = -Infinity; items.forEach((item, i) => { if (item.score > maxScore) { maxScore = item.score; topIndex = i; } })`，比较用 `>` 不用 `>=`，第一个达到最大值的下标自然胜出，是天然的确定性 tie-break。
- 双组件共享的 DOM id/锚点生成规则要抽成一个独立的纯函数（本例 `citation.ts` 的 `citationElementId()`），由生产者（`AssistantMessage` 渲染锚点）和消费者（`SourceList` 滚动定位）共同导入，禁止两边各写一份字符串模板——那样任何一边改了格式就会静默失联。

## 2026-07-31 — Feature 7: scenarios-and-degradation

**Stop hook CR 七轮才过——是目前为止轮次最多的 feature，因为 Drawer 组件牵扯到"响应式 + 动画 + 焦点管理"三件事互相耦合，改一处经常暴露另一处的坑：**

1. **订单卡三条件缺一不可**：`resolveSlots()` 的 `orderCard` 判定第一版只写了"有 queryOrderTool 调用 + 有 order 字段"两条件，漏了 `route === "order"` 本身——导致安全/维修场景如果恰好带着 `order` 字段（理论上契约允许，服务端不应该这么做但类型层面没禁止），会被误判成订单场景渲染出不相关的订单卡。**教训**：design.md 文字描述"双条件"时,要以需求文档 F-001 的完整表述为准("订单类(route==="order")...")，不能只抄设计文档里为了强调"不能只判 route"而省略了 route 本身的示例代码。
2. **契约允许但没写进状态表的组合，也要防御。** `deriveOrderView()` 只处理了 `error` 存在、`partial` 为 true、以及"正常成功"三支，遗漏了 `found:false` 且没有 `error` 这个类型层面合法的边界（需求 6 种状态表没有单独列这一行，但 `OrderStatus.error` 是可选字段，类型系统不禁止这个组合）。**教训**：写状态机时,以 TypeScript 类型的笛卡尔积为基准去核对分支覆盖，而不是只对照文档列出的"有名字的状态"——文档罗列的是产品语义上重要的状态，类型允许的组合可能比文档列出的更多，落在文档外的组合不能默认落到 happy path。
3. **React 组件的"关闭动画"必须在 render 阶段同步派生状态，不能放进 useEffect。** 抽屉退场需要"prop 变 false 那一刻仍然渲染一帧，之后才卸载"；如果用 `useEffect(() => { if (!open) setIsClosing(true) }, [open])`，effect 要等 commit 之后才跑，比 prop 变化晚一整个 render，会导致组件在"应该开始播放退场动画"的这一帧直接被判定为"不该渲染"而卸载，动画完全不会发生。正确做法是 React 官方认可的"根据 prop 变化调整 state"模式：在函数体顶部用 `if (prevPropRef.current !== prop) { prevPropRef.current = prop; setState(...) }` 同步比较并更新，React 会在同一次渲染流程内用新 state 重新渲染，不产生用户可见的中间帧。**入场动画同理但方向相反**：入场需要"先出现在收起位置，下一拍才翻到展开位置"，这次反而不能在同一个 render 里完成（那样只有一次样式重算，没有"从收起到展开"的过渡可言），要用一个真实的异步 tick（`setTimeout(fn, 0)` 足够，不需要 `requestAnimationFrame`）。**同一个组件里，关闭要同步、打开要异步，取决于"这一帧该不该被浏览器看见"，不是无脑套用同一种手法。**
4. **CSS 响应式隐藏（`hidden`/断点类）不能替代真正的状态收口。** Drawer 在窄屏打开后，如果视口被拉宽越过桌面断点，`min-[1100px]:hidden` 只是视觉上把它藏起来，`open` 状态和文档级的 Tab 焦点陷阱监听依然认为它是"打开的"，导致键盘用户被困在一个自己完全看不见的面板里，看得见的桌面栏位反而键盘不可达。**教训**：任何"用 CSS 断点类做响应式显隐"的交互式组件（尤其带焦点管理/模态语义的），都要额外用 `matchMedia` 监听同一断点，越界时主动调用状态收口的回调（这里是 `onClose()`），不能假设"视觉隐藏"和"交互状态"会自动保持一致——CSS 从不知道 JS 状态的存在。

**技术要点（可复用）**：
- "根据 prop 变化调整 state，在 render 阶段同步比较 ref 而不是在 effect 里"——这是 React 官方文档明确背书的模式（"Adjusting state when a prop changes"），本质是让状态转换与触发它的 prop 变化处于同一个渲染周期，避免多等一轮 effect 调度带来的时序错位。任何"某个 prop 翻转的瞬间必须立刻反映到另一个 state，且不能有额外一帧的错误中间态"的场景都适用（本例是 isClosing/entered 双状态：关闭同步翻、打开异步翻）。
- `window.matchMedia(query)` 在 jsdom 里没有实现（`typeof window.matchMedia !== "function"`），用到的组件必须加运行时守卫；测试要手动打桩一个假 `MediaQueryList`（带 `matches` getter + `addEventListener`/`removeEventListener`），通过桩对象的 `triggerChange()` 模拟断点变化，不依赖真实浏览器环境。
- 焦点陷阱（Tab/Shift+Tab 循环）的最小实现：监听 keydown，命中 Tab 时用 `panel.querySelectorAll(FOCUSABLE_SELECTOR)` 取可聚焦元素列表，`shiftKey && activeElement===first` → 跳到 last；`!shiftKey && activeElement===last` → 跳到 first；`activeElement` 完全不在面板内（异常路径）→ 拉回 first。不需要第三方库。

## 2026-07-31 — Feature 8: quality-gates-and-design-review

**Stop hook CR 五轮才过，全部集中在同一个新文件（`contract-mirror.test.ts`）——一次性把"字段镜像一致性"从手工 diff 自动化成脚本，暴露了"写一个源码级正则解析器"这件事本身有多少台阶：**

1. **只比字段名不够**：第一版只提取字段名集合比较，一侧把 `retrievedCount: number` 悄悄改成 `retrievedCount?: string` 而漏改另一侧，两个独立编译的包各自都能通过 `tsc`，字段名集合也完全相同——测试形同虚设。补上可选标记（`?`）与类型表达式本身的比较。
2. **比了类型字面量还不够**：如果字段类型写的是一个别名引用（`route: RouteCategory`），两侧写的都是字符串 `"RouteCategory"`，即使这个别名的真实定义（`"safety"|"order"|...`）已经在某一侧漂移，字符串比较仍然相等。补上：把类型表达式里"裸引用一个本地别名/接口"的情况解析展开成真实定义再比较，服务端的 `RouteCategory`/`ToolCallRecord` 还额外定义在另一个文件（`orchestration.ts`）里，需要把相关文件的源码拼接起来才能解析到。
3. **按换行切分字段是不安全的**：字段的类型表达式允许合法地跨多行书写（union 从下一行开始），按 `\n` 逐行匹配正则，要么把多行类型截断成半个类型，要么因为续行匹配不上"字段名:"的正则而被整条静默丢弃——最危险的是"两侧都用同一种多行写法，且都被静默丢弃"，此时测试会误判为一致。改成按"顶层分号"切分成语句（追踪括号/花括号/尖括号深度，深度为 0 时的 `;` 才是字段分隔符），字段折叠成单行后再跑正则。
4. **用字符计数模拟嵌套深度时，`=>` 是一个陷阱**：把每个 `<`/`>` 都当成泛型的开合会算错——箭头函数类型 `handler: () => void;` 里的 `>` 根本不是泛型收尾，如果照样让它把深度计数减到负数，后续所有字段的分号都不再被识别为"顶层"，导致剩余字段被错误合并成一条，看起来"解析出了内容"但内容是错的。修法是"`>` 前一个字符是 `=` 时不参与深度计算"，而不是引入真正的 TS 解析器。

**教训（贯穿全部五轮）**：写一个"自己动手实现的源码级文本解析器"来替代人工 diff 或真正的 TS AST 时，几乎必然会经历这个台阶——先满足最常见情况（单行、简单类型），然后依次被"被引用的类型定义可能漂移""合法的多行写法""语言里某个符号在不同语境有不同含义（`<`/`>` 既是比较/泛型也是箭头函数的一部分）"这几类问题揭穿。**如果预算和场景复杂度允许，优先考虑用语言自带的 AST（TypeScript Compiler API 的 `ts.createSourceFile` + 遍历）而不是手写正则/字符扫描**——本次选择手写扫描是因为场景足够窄（只有 5 个 flat interface + 2 个 union 别名，未来复杂度增长有限），如果契约文件的类型复杂度上升（嵌套泛型、条件类型、映射类型等），维护这个手写解析器的成本会迅速超过接入 TS AST 的成本，应该及时切换。

**技术要点（可复用）**：
- 逐字符扫描配深度计数器来"按顶层分隔符切分语句"，是解析简单类结构化文本（不需要完整语法树）时的轻量手段，但每种"看起来像括号但其实不是"的符号（`=>`、字符串/注释内的括号、正则字面量等）都要单独处理——本次只处理了 `=>`，如果契约类型里出现字符串字面量类型包含 `<`/`>` 字符，会是下一个坑。
- 验证"解析器改动确实修复了问题"的低成本手段：不引入 mock 框架，直接用 `fs.writeFileSync` 写一份"故意改错"的源码副本到临时文件，跑同一个提取函数比较结果，再删除临时文件——比为一次性验证去搭建复杂的测试夹具更快。

## 2026-08-01 — Feature 9: stitch-v2-visual-restoration（任务 0+1）

**`FontFaceSet.check()` 的浏览器语义不可靠，连续三轮 Codex Review 才收敛到"直接查 FontFace 对象状态"这个唯一可靠方案：**

1. **第一版**：只等 `document.fonts.ready` resolve 就显示图标。Review 指出 `ready` 表示"所有字体请求都处理完了"，失败也是一种处理完——Google Fonts 被墙时 `ready` 照样 resolve，会把 fallback 渲染的图标名称文字（`delete`/`arrow_upward`）暴露给用户。
2. **第二版**：加 `document.fonts.check('24px "Material Symbols Outlined"')` 判断。Review 指出省略第二个 `text` 参数时，`check()` 用的默认测试文本可能命中"随便什么字体都能画出来"的宽松匹配，测的是"能不能渲染任意文本"而不是"目标字体是否真的可用"。
3. **第三版**：给 `check()` 传入具体图标连字符作为第二参数（`check(font, "delete")`）。Review 第三次指出：`check()` 本身的浏览器实现语义就是不可靠的——即使目标 `@font-face` 从未注册成功，`check()` 也可能因为"没有找到需要等待的匹配字体"这种误报逻辑返回 `true`，与传不传第二参数无关，是这个 API 本身的问题。
4. **最终版**：完全放弃 `check()`，直接遍历可迭代的 `document.fonts`（`FontFaceSet`），查找 `family` 精确匹配（去掉可能带的引号）且 `status === "loaded"` 的 `FontFace` 对象——这是唯一不依赖浏览器 API 模糊实现细节的判断方式，与最初用 `[...document.fonts].map(f => f.family + ' ' + f.status)` 在真实浏览器里诊断问题时验证过的观察方式完全一致。

**教训**：涉及"某个资源是否真的加载成功"这类判断时，如果平台提供了一个看似专门为此设计的便捷 API（`FontFaceSet.check()`），不要想当然地信任它的返回值语义就是"是/否加载成功"——要么去规范里确认它的精确定义，要么（更可靠）直接检查底层状态对象本身（这里是 `FontFace.status`），跳过任何"帮你判断"的中间层。三轮 review 暴露的不是同一个 bug 的三个变种，而是同一个方法论错误（"信任一个语义模糊的便捷 API"）在不同参数组合下的三次重复。

**技术要点（可复用）**：
- `document.fonts` 在 jsdom 测试环境下是 `undefined`（CSS Font Loading API 未实现），依赖它的 hook 必须显式做存在性检查并降级，否则组件测试会因 `TypeError` 集体失败——这类"仅浏览器可用的全局 API"，写 hook 时第一件事就是想清楚 jsdom 降级路径，而不是写完再补。
- 测试可迭代对象（`FontFaceSet`）时，mock 只需要实现 `Symbol.iterator` 返回一个 generator，不需要实现完整接口——`{ [Symbol.iterator]: function* () { yield* faces } }` 就足以让 `for...of` 正常工作。
- 图标加载防闪烁的实现分工：CSS 负责默认隐藏 + 状态类切换（`opacity:0` / `html.icons-ready .material-symbols-outlined{opacity:1}`），JS 只负责"什么时候可以切换状态类"这一个职责——不要把隐藏逻辑也写进 JS（内联 style 操作），职责分离后两端都更容易单独测试。
- 关于"全局 0 圆角"这类写进 `.claude/rules/` 的强约束：一旦被用户在后续会话里明确推翻，必须同步更新写死这条约束的所有文档位置（`CLAUDE.md` + 对应 `rules/*.md`），否则未来的会话会读到过时的强约束、把新决策当成需要"改回去"的偏差——本次搜索 `grep -rn "0 圆角"` 定位到两处并逐一更新，改动 token 本身时要顺手做这一步，不要留到事后。

## 2026-08-01 — Feature 9: stitch-v2-visual-restoration（任务 2+3）

**改 `tailwind.config.ts` 后必须重启 Vite dev server，HMR 不会重新编译 PostCSS/Tailwind 配置——之前几轮"浏览器验证通过"其实测的是旧 token：** 修改 `borderRadius`/`boxShadow` 后直接在浏览器里刷新页面验证，`getComputedStyle` 量出来的圆角/阴影全是旧值（0px/none），一度怀疑是 class 没写对；实际原因是 Vite 的 HMR 只监听并热更新 `.css`/`.tsx` 源文件内容变化，`tailwind.config.ts` 的变化不在这个监听范围内，PostCSS 插件配置需要重启进程才会重新加载。**教训：改动 `tailwind.config.ts`（或任何构建工具配置文件）后，验证效果前先重启 dev server，不要信任"页面刷新就能看到最新配置"这个假设**——这类配置文件与源码文件的 HMR 行为不一致，是本次踩坑的根源。

**Tailwind 的 `box-shadow`/`margin` 类工具函数不会"叠加"，两个 utility 同时写在 class 里时，谁生效取决于 Tailwind 生成样式表的内部顺序（不是 JSX 里的书写顺序），这个顺序对使用者不透明、不能凭直觉预测：**
1. `shadow-main shadow-inner-top` 两个类同时使用，意图是让外部投影和内部高光叠加显示——但 `box-shadow` 是单值 CSS 属性，两个 Tailwind shadow-* 工具类的效果不会合并，只有样式表里排在后面的生效。这不是我们写错了，新稿 Stitch 生成的 HTML 原样就是这么写的（Stitch 生成工具本身也有这类 Tailwind 使用误区）。按"浏览器最终像素是唯一验收标准"，不能盲目照抄一个视觉上并不会按预期生效的写法，必须手动把两个 `box-shadow` 值合并成一个组合值。
2. `w-full` + `mx-auto` + `m-4`/`lg:m-8` 同时使用会在两个层面出问题：`w-full` 把宽度显式钉死在父容器 100%，margin 再叠加上去会让总占用宽度超过父容器（100% + 2×margin），被 `overflow-hidden` 裁掉；`mx-auto` 和 `m-4` 同时设置 margin-left/right，Tailwind 按内部固定顺序生成规则，`mx-auto` 会赢，导致 `m-4` 的水平分量在断点以下直接消失。这个 bug 是 Codex Review 而不是我自己发现的——第一次浏览器验证只测了 `computed margin` 数值（看到 32px 就以为对了），没有测实际的 `getBoundingClientRect()` 左右间距和是否溢出，掩盖了问题。修复方式：不用 "100%宽度 + margin做留白" 这种依赖浏览器/工具链内部顺序才能凑对的组合，改用 `w-[calc(100%-2rem)]` 这种把留白直接算进宽度表达式里的写法，`mx-auto` 只用来在超过 `max-width` 后居中多余空间，不再和任何 margin 工具类竞争同一 CSS 属性。

**教训（贯穿两处）**：涉及"两个 CSS 值需要共同生效"的场景（多重阴影、宽度+外边距），Tailwind 的工具类模型是"每个 class 对应一条完整的 CSS 声明"，不是"每个 class 贡献声明的一部分然后自动合并"——凡是两个工具类会写同一个 CSS 属性（`box-shadow`、`margin-left`/`margin-right` 等），效果就是覆盖而不是叠加，必须要么手写一个合并后的自定义 class，要么用不同的属性/维度分别控制（比如本例把留白直接编码进 `width` 表达式，让 `margin` 只负责居中）。验证这类问题时，只测 `getComputedStyle` 的汇总值（如 `margin: "32px"`）不够，要测最终几何结果（`getBoundingClientRect()` 的实际左右间距、`scrollWidth` 是否溢出）才能发现"数值对但没生效"或"数值本身就没被正确应用到最终布局"的问题。

**技术要点（可复用）**：
- 验证响应式留白/居中效果时，用 `element.getBoundingClientRect()` 算出 `rect.left` 和 `window.innerWidth - rect.right`，两者应该相等（对称留白）且都应该是期望的像素值——比只读 `getComputedStyle(...).margin` 更可靠，因为后者只反映声明的值，不反映 flex/grid 布局系统实际计算出的几何结果。
- 改 `tailwind.config.ts`/`vite.config.ts`/`postcss.config.js` 这类构建配置文件后，固定动作是"杀掉旧 dev server 进程 → 重新启动 → 再验证"，不要依赖 HMR 自动生效。

## 2026-08-01 — Feature 9: stitch-v2-visual-restoration（任务 4）

**"选中态"和"未选中态"共用一部分 className 字符串时，容易把只该属于其中一态的样式意外带到另一态上——这次是圆角，被 Codex Review 抓到：** 最初写法是 `` `w-full ... rounded-r-md ${active ? "选中态额外样式" : "未选中态额外样式"}` ``，把 `rounded-r-md`（新稿设计里只属于"选中态，因为左边框已经占了视觉重量，只需要圆右侧"）放进了两态共享的前缀部分，导致未选中态（新稿设计是四角都圆的 `rounded-md`）也被套上了"只圆右侧"的效果——只有在 hover 未选中项、或对比两种状态截图时才会看出来，光看选中态本身完全测不出这个问题。同一次修复还发现 `w-full` + `ml-[3px]`（给未选中项让出选中态左边框的视觉空间）会让未选中项实际宽度变成"容器宽度 + 3px"，在有 `overflow-y-auto` 的侧栏里造成隐藏的横向溢出（垂直滚动条掩盖了横向溢出的视觉线索，肉眼截图很难发现，需要专门去比较 `scrollWidth` 和 `clientWidth`）。

**教训**：条件样式（`active ? A : B`）如果只是把"两态都要"的公共样式放进不带条件的前缀部分，"看起来只有这一态特有"的样式反而更容易被误放进公共前缀——判断一个 Tailwind class 该不该放共享前缀，标准应该是"两个分支的设计稿截图里这个视觉效果是否都存在"，而不是"这个 class 是不是两态都写了字面上一样的东西"（`rounded-r-md` 字面上没在另一分支出现，但因为在共享前缀里，它其实在运行时同样应用到了未选中态，只是没人细看）。涉及"给某一态的元素让出空间"的负 margin/margin 组合（如 `ml-[3px]` 补偿选中态的左边框宽度），必须同步用等量的宽度收缩（`w-[calc(100%-3px)]`）抵消，不能只加 margin 不减宽度——这类问题在有滚动容器包裹时尤其隐蔽，用 `element.scrollWidth === element.clientWidth` 做溢出检测比截图更可靠。

## 2026-08-01 — Feature 9: stitch-v2-visual-restoration（任务 5）

**`mcp__Claude_Browser__computer` 的 `left_click` 坐标是"截图像素空间"，不是"CSS 像素空间"，两者的换算系数等于 `截图宽度 / viewport 宽度`，直接拿 `getBoundingClientRect()` 的 CSS 像素坐标去点击会点偏：** 验证用户气泡 padding 时，先用 `read_page` 拿到的 `ref` 点击发送按钮一直不生效（输入框内容原样保留、气泡没有出现），换成"目测截图里发送按钮的大致位置"点击也不生效或点偏；最终用 `getBoundingClientRect()` 拿到按钮的真实 CSS 像素坐标（如 `x:1117, y:760, w:36, h:36`，中心点 CSS 坐标 `(1135, 778)`），按 `800/1920≈0.4167` 的缩放系数换算成截图坐标 `(473, 324)` 后才点中。**教训：viewport 是 1920×1080 但截图渲染成 800×450（约定的固定输出尺寸）时，`computer` 工具的 `coordinate` 参数用的是这个 800×450 截图坐标系，不是真实浏览器视口的 CSS 像素坐标系——涉及精确点击（尤其是小尺寸按钮）时，优先用 `ref`（`read_page`/`find` 拿到的引用会自动处理缩放），`ref` 失效或点不中时，退回坐标点击必须先用 `getBoundingClientRect()` 换算，不能直接摸 CSS 像素数值，也不能凭肉眼截图估算像素位置。**

**Codex Review 在这一轮抓到的是"改了三个视觉属性（渐变/圆角/边框/阴影），漏改了第四个（padding）"——这类"新旧稿差异点有好几处，改的时候只对照了截图观感、没有逐字段核对 HTML class 字符串"的遗漏，本次改了 3 轮才被找全（第一次漏了组合阴影不会叠加、第二次漏了溢出+圆角分支、第三次漏了 padding 数值）：** 每次实施某个组件的视觉还原时，如果只凭"看起来差不多了"截图比对就认为完成，容易漏掉截图上不明显、但 class 字符串里明确写着的数值差异（`px-6 py-4` vs `px-5 py-3.5` 在 1920px 大屏上肉眼几乎看不出 4px 的差异）。**更可靠的做法：把新稿 HTML 里这个组件对应的完整 class 字符串抄出来，逐个 utility 类去对照当前实现，而不是"改几个明显不一样的地方就够了"**——本次记录在案，后续任务（6/7/8）实施前应该先做这一步核对，而不是等 Codex Review 逐轮挑出来。
