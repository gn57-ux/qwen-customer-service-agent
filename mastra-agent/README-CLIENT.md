# Mastra Client 接口闭环：真实调用链与前端契约

本文档记录前端（React/Vite，未来阶段）必须走的调用链、Mastra 原生能力的实测
依据，以及 `web-client/`（仓库根目录下的最小共享客户端包）的用法。

## 一、真实调用链

```
React/Vite（未来阶段，本轮未做）
  → @mastra/client-js 的 MastraClient.request()（web-client/src/client.ts 封装）
  → Mastra 服务（mastra dev，默认 4111）的自定义 route：
      POST /customer-service/chat    非流式
      POST /customer-service/stream  流式（SSE）
  → 这两个 route 内部固定调用 runAgentTurn() / streamAgentTurn()
    （mastra-agent/src/mastra/orchestration.ts 的确定性路由 + 强制工具）
  → customerServiceAgent.generate() / .stream()
  → FastAPI :8000（services/app.py）
  → llama-server :8002（内部端口）
  → Mastra 原生执行 queryOrderTool / searchKnowledgeBaseTool
```

**前端唯一允许调用的两个入口**是这两个自定义 route，**不是**标准 Agent
endpoint（`/api/agents/customerServiceAgent/generate`）——后者会跳过
`classifyRoute()`/强制 `toolChoice` 的路由逻辑，直接把请求丢给模型自己判断
要不要调用工具，这正是上一轮实测证明不可靠的路径（维修类问题经常被模型跳过
检索直接背答案）。`web-client/src/client.ts` 只封装了这两个 route，没有暴露
访问标准 Agent endpoint 的方法。

## 二、Mastra 原生能力核实（真实文件路径 + 关键类型，已安装版本）

版本：`mastra@1.20.1`、`@mastra/core@1.52.1`、`@mastra/client-js@1.33.0`
（`@mastra/client-js` 的 `dependencies.@mastra/core` 精确等于 `1.52.0`，是
与本项目 `mastra@1.20.1`/`@mastra/core@1.52.1` 这条发布线最接近的兼容版本——
用 `npm view @mastra/client-js@<version> dependencies.@mastra/core` 逐个版本
核实过，1.33.0 之后的版本 `@mastra/core` 依赖跳到 1.53.0+）。

1. **`registerApiRoute()`**——`node_modules/@mastra/core/dist/server/index.d.ts`：
   `registerApiRoute<P extends string>(path: P, options: {method, handler, ...}): ApiRoute`，
   `handler` 是 Hono `Handler`，能拿到 `mastra`/`requestContext`（`CustomRouteVariables`）。
2. **`Mastra({server: {apiRoutes}})`**——`node_modules/@mastra/core/dist/server/types.d.ts`
   第 147 行起 `ServerConfig`：`apiRoutes?: ApiRoute[]`。
3. **自定义 route 不能挂在 `/api` 下**——这是实测发现，不是文档记忆：直接用
   `registerApiRoute("/api/customer-service/chat", ...)` 启动时会抛出
   `Error: Custom API route "/api/customer-service/chat" must not start with
   "/api" — that path is reserved for built-in Mastra routes`（来自
   `.mastra/output/index.mjs` 里 `MastraServer.validateCustomRoutePaths`）。
   因此两个 route 实际挂在根路径：`/customer-service/chat`、
   `/customer-service/stream`。
4. **`MastraClient.getAgent(id).generate()/.stream()` 支持
   `toolChoice`/`activeTools`/`maxSteps`**——
   `node_modules/@mastra/client-js/dist/types.d.ts` 第 439 行
   `StreamParamsBase<OUTPUT> = Omit<AgentExecutionOptions<OUTPUT>, 'model'|'requestContext'|'clientTools'|'options'|'abortSignal'|'structuredOutput'>`，
   这三个字段都没被排除，说明客户端确实能传——**但本项目明确不用这条路径**
   （见第一节），因为那样前端就得自己复刻 `classifyRoute`/强制工具逻辑，
   等于把路由业务规则搬到前端，违反"不允许前端自行实现路由"的约束。
5. **`MastraClient`/`BaseResource.request<T>(path, options)`**——
   `node_modules/@mastra/client-js/dist/resources/base.d.ts`：公开方法（无
   `protected`/`private` 修饰），`RequestOptions.stream?: boolean`。已读
   `node_modules/@mastra/client-js/dist/index.js` 里 `async request(path, options)`
   的真实实现：`stream:true` 时直接 `return response`（原始 `Response`，交给
   调用方自己读 body）；否则 `await response.json()`。这就是 `web-client`
   用来调用两个自定义 route 的唯一方法——**仍然是通过 MastraClient**，不是
   绕开它另起一个 fetch。
6. **`MastraClient` 未预装**：本项目原本没有 `@mastra/client-js` 依赖，本轮
   安装并锁定精确版本 `1.33.0`（`mastra-agent/package.json` 与
   `web-client/package.json` 都是 exact 版本，不用 `^`）。

## 三、最终采用方案：A（自定义 route，服务端强制路由）

对照任务给出的三个选项：

- **A（自定义 route + MastraClient 正式调用）**——采用。Mastra 支持
  `registerApiRoute`，`@mastra/client-js` 有 `request()` 可以调用任意 route
  （含流式）。已完整实现并用真实服务验证。
- **B（标准 Agent endpoint + 客户端动态 toolChoice）**——技术上可行（第二节
  第 4 条），但会强制前端复刻服务端的路由业务逻辑，明确违反任务的架构约束，
  **未采用**。
- **C（客户端不支持自定义 route，停止实施）**——不成立，A 已验证可行。

## 四、`web-client/` 最小共享客户端包

```
web-client/
├── package.json          # 只依赖 @mastra/client-js@1.33.0（exact）
├── tsconfig.json
├── src/
│   ├── types.ts           # 与 mastra-agent/src/mastra/contract.ts 手动保持一致的类型镜像
│   └── client.ts          # createCustomerServiceClient({baseUrl}) → {chat, streamChat}
└── scripts/
    └── smoke.ts            # 真实服务 smoke 测试，npm run smoke
```

用法（供未来 React/Vite 项目参考，本轮不做 UI）：

```ts
import { createCustomerServiceClient } from "customer-service-client/src/client.ts";

const client = createCustomerServiceClient({ baseUrl: "http://127.0.0.1:4111" });

const res = await client.chat("冰箱不制冷应该先检查什么");
// res.reply / res.route / res.toolCalls / res.sources / res.reranked / res.degraded / res.order

await client.streamChat("你好", [], (event) => {
  if (event.event === "text-delta") appendToUI(event.data.delta);
  if (event.event === "tool-result") showToolBadge(event.data);
  if (event.event === "done") finalizeUI(event.data);
});
```

## 五、前端数据契约

`mastra-agent/src/mastra/contract.ts` 是唯一权威定义，`web-client/src/types.ts`
是手动保持一致的镜像（两边字段改动要同步）。

### `ChatResponseBody`（`/customer-service/chat` 的响应体，`/customer-service/stream`
的 `done` 事件也是这个形状）

```ts
interface ChatResponseBody {
  reply: string;
  route: "safety" | "order" | "repair" | "general";
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; result: unknown }>;
  sources?: Array<{                 // 只有调用过 searchKnowledgeBase 才有
    title: string; section: string; sourceFile: string; documentVersion: string;
    vectorScore: number; rerankScore: number | null;
  }>;
  reranked?: boolean;                // 见 searchKnowledgeBaseTool 的降级语义
  degraded?: boolean;
  degradedReason?: string;
  order?: {                          // 只有调用过 queryOrderTool 才有（取最后一次）
    found: boolean; partial?: boolean; missingFields?: string[];
    error?: "not_found" | "timeout" | "server_error" | "network_error";
  };
  traceId: string;
  latencyMs: number;
}
```

**这些字段全部从工具自己的结构化 `outputSchema` 结果里提取
（`mastra-agent/src/mastra/contract.ts` 的 `buildContractExtras()`），不解析
模型的自然语言回复**——前端不应该、也不需要用正则去猜"这条回复是不是引用了
知识库"或"订单是不是查到了"，看 `sources`/`order` 字段就够。

### `/customer-service/stream` 的 SSE 事件

```
event: meta
data: {"traceId": "..."}

event: tool-result      // 只在真正调用了工具时出现；强制路由（order/repair）
data: {"name": "...", "arguments": {...}, "result": {...}}   // 时在任何 text-delta 之前出现

event: text-delta
data: {"delta": "..."}

event: done
data: <完整 ChatResponseBody>

event: error             // 出现则说明本轮失败，不会再有后续事件
data: {"message": "...", "traceId": "..."}
```

## 六、已知限制

1. **`web-client` 与 `mastra-agent` 的契约类型是手动镜像，不是共享编译单元**——
   两边各自维护一份 `types.ts`/`contract.ts`，改字段要同步改两处。本轮范围
   小，暂不引入 monorepo workspace 工具来自动同步；如果后续契约字段变多，
   值得评估用 npm workspaces 把两者接起来。
2. **`web-client` 没有自己的 UI**，任务本轮明确不做完整 UI，只交付客户端 +
   smoke 脚本。
3. **流式路径的工具事件顺序**：强制路由（order/repair）时 `tool-result` 一定
   在第一个 `text-delta` 之前（工具在流式合成开始前就已经真实执行完毕）；
   不强制路由（safety/general）时，Mastra 的 `stream()` 内部循环理论上也可能
   自己决定调用工具，这种情况下 `tool-result` 会在 `text-delta` 之后才出现
   （读取 `getFullOutput()` 后才知道），前端不应该假设 `tool-result` 一定先到。
   已实测这两类场景几乎不会主动调用工具，属于边缘情况。
4. **`registerApiRoute` 的 Hono `Context` 类型与顶层 `node_modules/hono` 存在
   纯类型层面的结构不兼容**（同一个去重后的 hono 4.12.31 实例，但
   `@mastra/core` 内部打包的 `.d.ts` 快照少一个内部 symbol 键），
   `routes/customer-service.ts` 里对 `streamSSE(c as any, ...)` 做了一次
   有注释说明的类型断言，不影响运行期行为。
5. **`streamChat(..., {signal})` 的取消能力有一个真实边界**：
   `@mastra/client-js@1.33.0` 的 `RequestOptions`（`dist/types.d.ts`）**没有**
   `signal` 字段——`request()` 内部的 `fetch()` 调用不接受外部传入的
   `AbortSignal`。这意味着：**在请求头返回之前**（也就是 `await
   client.request(...)` 还没 resolve、连 `Response`/`reader` 都还没到手的
   阶段），当前这版 `request()` API 没有原生手段可以中途取消这次 HTTP 请求
   本身——`web-client` 没有用 `as any` 假装它支持 `signal`，也没有绕开
   `MastraClient` 改成手写 `fetch(url, {signal})`。真正可靠的取消发生在
   **拿到流式 `Response`、拿到 `reader` 之后**：`signal` 的 `abort` 事件会
   触发 `reader.cancel()`，这会正确终止后续的读取并关闭到服务端的连接
   （HTTP/SSE 连接层面的 socket 会被释放），`streamChat()` 保证以
   `AbortError` 结束，不会误报"没有收到 done 事件"。已用真实请求验证：在
   收到 `meta` 事件后立刻 `abort()`，观察到 `AbortError` 且没有 `done`
   （`web-client/scripts/smoke.ts` 第 8 项）。
