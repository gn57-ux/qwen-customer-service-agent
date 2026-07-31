# 客服 Agent：真实调用链、Mastra 原生工具、已知限制

本文档记录 `customerServiceAgent` 的正式运行路径、依据的 Mastra/AI SDK 真实类型定义，
以及本轮踩过的坑和最终修复方式。所有结论均来自对已安装版本源码/类型定义的实际读取，
以及对真实服务的实测请求，不是猜测。

## 一、真实调用链

```
mastra/client 或测试（agent.e2e.test.ts / orchestration.ts）
  → customerServiceAgent.generate() / .stream()（Mastra 原生执行方法）
  → FastAPI :8000（services/app.py，/v1/chat/completions）
  → llama-server :8002（内部端口，只被 FastAPI 访问）
  → Mastra 自动执行已注册的 queryOrderTool / searchKnowledgeBaseTool
    （真实调用 Mock 后端 :8001 / Qdrant + Ollama + Reranker）
  → 工具结果以 AI SDK 结构化 tool-result 消息回到 customerServiceAgent
  → customerServiceAgent.generate() 产出最终回答
```

`customerServiceAgent`（`src/mastra/agents/customer-service-agent.ts`）构造时注册两个工具：

```ts
export const customerServiceAgent = new Agent({
  ...
  tools: {
    queryOrderTool,
    searchKnowledgeBase: searchKnowledgeBaseTool,
  },
});
```

正式运行代码只有一处调用点——`src/mastra/orchestration.ts` 的 `runAgentTurn()`，
两条分支都是对 `customerServiceAgent.generate()` 的真实调用：

- 不强制工具时（safety/general 路由）：`customerServiceAgent.generate(messages)`
- 强制工具时（order/repair 路由）：先 `customerServiceAgent.generate(messages, {activeTools, toolChoice:"required", maxSteps:1})`
  拿到真实工具结果，再 `customerServiceAgent.generate([...messages, ...step1.response.messages])`
  做最终合成——**两步都是 `customerServiceAgent.generate()`**，orchestration.ts 本身不发起
  任何模型请求、不实现工具执行逻辑，只负责路由分类和拼接两次调用之间的消息。

## 二、Mastra 原生能力核实记录（真实文件路径 + 关键类型）

版本：`@mastra/core@1.52.1`、`@ai-sdk/openai@4.0.19`、`@ai-sdk/provider@4.0.3`。

1. **Agent 构造函数 tools 注册格式**——`node_modules/@mastra/core/dist/agent/agent.d.ts`
   第 133/175 行注释示例：`tools: { calculator: calculatorTool }`，即
   `Record<string, ToolAction>`，key 就是暴露给模型的函数名（已实测确认，见下）。

2. **`agent.generate()` 的 `toolChoice`/`maxSteps`/`stopWhen`**——
   `node_modules/@mastra/core/dist/agent/agent.types.d.ts` 第 395 行
   `AgentExecutionOptionsBase`：`toolChoice?: ToolChoice<any>`、`maxSteps?: number`、
   `stopWhen?: LoopOptions['stopWhen']`、`activeTools?: LoopOptions['activeTools']`。
   `ToolChoice` 定义在
   `node_modules/@mastra/core/dist/_types/@internal_ai-sdk-v4/dist/index.d.ts` 第 6798 行：
   `'auto' | 'none' | 'required' | {type:'tool', toolName: keyof TOOLS}`。
   `activeTools` 类型在 `@internal_ai-sdk-v5/dist/index.d.ts` 第 1738 行：
   `Array<keyof NoInfer<TOOLS>>`——按 key（不是内部 `id`）限制哪些已注册工具对本次调用可见。

3. **结构化 assistant tool-call / tool result 消息格式**——同一文件：
   - `CoreAssistantMessage.content: AssistantContent`（第 94 行）：
     `string | Array<TextPart | FilePart | ReasoningPart | RedactedReasoningPart | ToolCallPart>`
   - `ToolCallPart`（第 6720 行）：`{type:'tool-call', toolCallId, toolName, args}`
   - `CoreToolMessage.content: ToolContent`（`ToolContent = Array<ToolResultPart>`）
   - `ToolResultPart`（第 4215 行区域）：`{type:'tool-result', toolCallId, toolName, result, isError?}`

4. **实测得到的 `toolCallId`/`toolName`/`input`/`output` 真实结构**（`agent.generate()`
   返回的 `response.messages`，AI SDK v5 兼容层实际吐出的是 `input`/`output` 而不是
   v4 类型定义里的 `args`/`result` 字段名——这是 Mastra 内部版本兼容层的实际行为，
   不是文档，是真实跑出来的）：
   ```json
   {"role":"assistant","content":[
     {"type":"text","text":"..."},
     {"type":"tool-call","toolCallId":"...","toolName":"searchKnowledgeBase","input":{"query":"..."}}
   ]},
   {"role":"tool","content":[
     {"type":"tool-result","toolCallId":"...","toolName":"searchKnowledgeBase",
      "output":{"type":"json","value":{...}}}
   ]}
   ```
   `generate()` 返回值本身（`FullOutput`，`node_modules/@mastra/core/dist/stream/base/output.d.ts`
   第 26 行起）另外提供更好用的 `toolCalls`/`toolResults` 数组，每项
   `{type, runId, from, payload:{toolCallId, toolName, args, result}}`——
   `orchestration.ts` 的 `collectToolCalls()` 就是从这里取数据，不用手动解析 `response.messages`。

5. **`listTools()`**——`node_modules/@mastra/core/dist/agent/agent.d.ts` 第 735 行附近声明，
   实测 `await customerServiceAgent.listTools()` 返回
   `{queryOrderTool: Tool, searchKnowledgeBase: Tool}`，key 与构造时一致。

6. **Mastra Client（`@mastra/client-js`）**——**未安装**（`package.json` 无此依赖，
   `node_modules` 里也没有）。本项目目前的正式调用入口是直接 import
   `customerServiceAgent` 调用 `.generate()`/`.stream()`（`orchestration.ts`），或者
   `mastra dev` 起的本地开发服务器。如果之后要接一个独立的 HTTP/CLI 客户端，需要
   额外评估是否引入 `@mastra/client-js`，本轮未引入。

## 三、FastAPI 与 llama-server 的职责

- **llama-server（:8002，内部端口）**：真正跑推理。已用真实请求核实，给定标准
  OpenAI `tools` 数组后，这个模型能被 llama-server 的语法约束解码原生产出结构化
  `message.tool_calls`（`finish_reason:"tool_calls"`，`function.arguments` 是合法
  JSON 字符串，`id` 唯一），流式请求下也能正确产出 `delta.tool_calls[]` 增量——
  **不需要在 FastAPI 里额外解析文本标签**。但 `tool_choice` 的支持有限：通用的
  `"required"` 会真正强制产出工具调用，指定具体函数的 `{type:'tool', toolName:X}`
  形式（无论 activeTools 是否限制候选工具）实测都不会被遵守，模型仍可能直接给出
  纯文本回答。
- **FastAPI（:8000，唯一对外入口）**：本轮之前会静默丢弃请求里的 `tools`/
  `tool_choice` 字段（已确认的协议缺口，本轮修复）。现在：
  - `ChatCompletionRequest` 保留 `tools`/`tool_choice`；
  - `validate_tools_whitelist()` 只允许 `queryOrderTool`、`searchKnowledgeBase`
    两个工具名，出现白名单外的名字直接 400，不静默丢弃、不静默放行；
  - `build_upstream_payload()` 把校验过的 `tools`/`tool_choice` 原样转发给
    llama-server；
  - 非流式响应直接 `return resp.json()` 透传（llama-server 原生的结构化
    `tool_calls` 原样到达客户端）；流式走已有的 `aiter_raw()` 逐字节透传，
    `tool_calls` 的增量 delta 同样不被解析/改写。
  - **没有新增任何文本 `<tool_call>` 标签解析逻辑**——llama-server 原生支持已经
    够用，不需要按任务里预设的"退路方案"再实现一层兼容解析。
  - 模型加载、身份校验、GGUF 转换、评测、启停脚本**全部未改动**。

## 四、确定性 `toolChoice` 的原因

`orchestration.ts` 的 `classifyRoute()` 只用来决定要不要在调用
`customerServiceAgent.generate()` 时传 `activeTools`/`toolChoice:"required"`，
不自己发起任何模型请求：

- **safety**：不强制任何工具。已实测：这个模型给安全类问题（冒烟/明火/挂架松动等）
  不需要检索也能正确给出"远离危险源、不自行处理、联系专业/紧急服务"的安全边界。
- **order**（消息里出现 `ORD\d+`）：强制 `queryOrderTool`。实测不强制时模型单轮
  也会主动调用，但多轮对话换订单号时，早期用纯字符串手工回填工具结果的实现下
  出现过"模仿历史例子编造新订单号数据、不真的调用工具"的问题（详见下节）；换成
  Mastra 原生结构化工具循环后这个问题已实测消失（`agent.e2e.test.ts` 用例 4c
  验证了 ORD1002→ORD1003 的真实二次调用），但按任务要求仍保留强制路径作为
  防御性保证，不依赖模型每次都自愿调用。
- **repair**（维修域关键词，如"冰箱""无信号""排查"）：强制 `searchKnowledgeBase`。
  这个微调模型对维修排查步骤有很强的训练记忆，实测在 `toolChoice` 默认 `auto`
  时——即使两个工具都注册、System Prompt 反复强调"必须先检索"——模型仍然经常
  跳过工具调用，直接背出训练时学到的排查步骤（这正是
  `services/evaluation-reports/gguf-production-v1/manual-adjudication.md` 里记录的
  `groundless_fact` 问题的根源，本轮换个场景又实测复现了一次）。只有确定性强制
  才能稳定满足"维修事实优先 searchKnowledgeBase"这条硬性路由要求。
- **general**（不匹配以上任何规则，含"无订单号的订单意图"，例如"我的物流怎么没
  更新？"）：不强制。已实测模型会正确先追问订单号，不会盲目调用工具。

### 为什么强制调用要分两步，而不是一次 `toolChoice:"required"` 跑完整个循环

已用真实请求验证：如果让整个多步循环（`maxSteps>1`）从头到尾都带着
`toolChoice:"required"`，在检索结果本身包含多条相似安全提示文本的场景下
（例如冰箱维修资料里"不要拆后盖""不要触碰内部高压部件"这类警示在不同章节反复
出现），最终的合成步骤会解码退化成大段复读同一句话。拆成两步后：

1. 第一步只强制这一步（`maxSteps:1`），拿到一次真实的结构化 `tool-call`，
   Mastra 自动执行注册的工具函数，产出结构化 `tool-result`；
2. 第二步是普通调用（`toolChoice` 恢复默认），用 Mastra 自己的结构化消息
   （`response.messages`，AI SDK 原生 tool-call/tool-result part，**不是纯字符串
   `role=tool`**）续上第一步的结果，做最终合成。

两步都是 `customerServiceAgent.generate()`，复读问题在这个两步方案下没有再复现
（`agent.e2e.test.ts` 里维修类、订单类用例均已用真实服务验证通过）。

## 五、Reranker 降级

`searchKnowledgeBaseTool`（`src/mastra/tools/search-knowledge-base-tool.ts`）完全
复用 `src/rag/{store,embedding,rerank}.ts` 的既有实现，未重写：Reranker
`unavailable`（服务不可达/HTTP 非 200/响应非法）或 `disabled`
（`RERANK_ENABLED=false`）时，工具输出 `reranked:false, degraded:true,
degradedReason`，返回向量顺序 Top5、`rerankScore` 全部为 `null`——不会用向量
名次冒充已完成的 Rerank。`customerServiceAgent` 的 System Prompt 明确要求
"检索未命中或降级时如实说明信息不足"。

## 六、订单字段缺失（`partial`/`missingFields`）

按 `services/mock_backend.py` 的真实 `ORDERS` schema：每条记录固定含
`order_id/status/status_text/created_at/carrier/tracking_number/
latest_logistics/estimated_delivery/can_cancel/customer_tip`，其中
`carrier/tracking_number/latest_logistics/estimated_delivery` 在未发货订单上
本来就是 `null`（例如 `ORD1001`，`status=paid`，尚未出库）——这是订单所处阶段
决定的正常状态，不算"字段缺失"。

`queryOrderTool` 只把 `order_id/status/status_text` 三个"回答订单状态必须要有"的
字段当作关键字段（`KEY_FIELDS`）：
- `found=false`：404/不存在，或 timeout/server_error/network_error；
- `found=true, partial=false`：三个关键字段齐全（物流类字段是否为 `null` 不影响判定）；
- `found=true, partial=true, missingFields:[...]`：关键字段里至少一个缺失，
  `order` 字段原样保留后端已返回的部分数据（不因为部分缺失就整体丢弃），
  `message` 明确列出缺了哪些字段。System Prompt 要求 `partial=true` 时
  "只能说明已知字段，明确指出哪些字段系统未提供，不得当作完整结果处理"。

Mock 后端本身三条订单数据都完整，`partial=true` 场景用假 HTTP 服务器在
`query-order-tool.test.ts` 里做故障注入测试（真实 Mock 后端无法模拟这种情况）。

## 七、已知限制与踩坑记录

1. **`toolChoice:{type:'tool', toolName:X}`（指定具体函数）不生效**：llama-server
   对这个模型只有通用的 `"required"` 会真正强制产出工具调用，具体函数形式会被
   忽略（模型可能直接给出纯文本回答）。目前用 `activeTools` 限制候选工具集合
   + `toolChoice:"required"` 组合实现"强制调用指定的那一个工具"。
2. **上一版实现的教训（已废弃，仅供记录）**：最初尝试过（a）Agent 不注册 tools、
   orchestration.ts 自己 `fetch` FastAPI、正则提取 `<tool_call>` 文本标签；
   （b）工具结果回填用纯字符串 `role="user"`。这两种做法都被 Review 明确否决，
   原因和本轮验证一致：模型会把纯字符串工具结果消息误当成可复述的文本，产生
   编造/复读；且绕开 `agent.generate()` 就不是真正的 Mastra Agent 主链路。
   本轮已完全废弃这两种做法，改为本文档描述的真实调用链。
3. **`toolChoice:"required"` 跑完整个多步循环会导致解码退化**（见第四节），
   因此采用两步分离方案，属于对已知模型行为的工程规避，不是 Mastra/AI SDK
   本身的缺陷。
4. **`@mastra/client-js` 未安装**，本项目暂未提供独立客户端接入层，正式入口是
   直接调用 `customerServiceAgent`（见第二节第 6 条）。
5. **`searchKnowledgeBase` 结果里出现的重复措辞安全提示**（第四节所述现象）本身
   是知识库内容层面的重复，未在本轮改动 `knowledge/repair/*.md`（禁止范围），
   如果后续要从根源缓解合成阶段的重复风险，可以考虑在知识库内容整理阶段去重，
   但不属于本轮 Mastra 接入范围。
