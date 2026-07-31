# chat-stream-conversation — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **前端 UI 层**、**前端状态层**
- 不涉及: 服务端（消费既有 route）、数据库

## 功能模块设计

### 模块 1: 会话状态机

**新文件**: `src/app/hooks/use-chat-stream.ts`

```ts
type TurnPhase = "idle" | "streaming" | "done" | "error" | "aborted";

interface AssistantTurn {
  phase: TurnPhase;
  traceId?: string;          // 来自 meta
  text: string;              // text-delta 累积
  toolCalls: ToolCallRecord[]; // tool-result 实时累积
  body?: ChatResponseBody;   // done 后的结构化真源
  errorMessage?: string;
}
```

**关键设计**：`text`（流式累积）与 `body`（结构化真源）**分开存储**。
`done` 到达后，正文以 `body.reply` 为准覆盖，右栏一律读 `body` —— 杜绝从流式文本反推状态。

### 模块 2: 五类事件处理

```ts
await client.streamChat(message, history, (ev) => {
  switch (ev.event) {
    case "meta":        setTraceId(ev.data.traceId); break;
    case "tool-result": appendToolCall(ev.data);     break;   // 实时链路
    case "text-delta":  appendText(ev.data.delta);   break;
    case "done":        setBody(ev.data);            break;   // 结构化覆盖
    case "error":       setError(ev.data.message);   break;
  }
}, { signal: ac.signal });
```

**收尾归一**（三种非正常路径都必须落到确定态）：

| 情况 | 客户端行为（已读码确认） | UI 处理 |
|---|---|---|
| 用户取消 | 抛 `AbortError` | `phase = "aborted"`，**不显示错误**，保留已生成内容 |
| `error` 事件 | 客户端 `throw new Error(message)` | `phase = "error"`，保留部分正文 |
| 无 `done` 提前结束 | 抛「流式响应提前结束，没有收到 done 事件」 | 同 `error` 处理 |

```ts
catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") setPhase("aborted");
  else setPhase("error");
} finally {
  refreshServiceStatus();   // feature 4 的 refresh()，done/error 后刷新顶栏
}
```

> `client.ts` 的 `finally` 已负责 reader 释放与连接关闭，UI 层**不需要**也**不应该**
> 再操作底层流；只需管理自身状态。

### 模块 3: 取消的已知限制

`@mastra/client-js@1.33.0` 的 `RequestOptions` 无 `signal` 字段（`client.ts` 顶部注释已明确）：

```
发送 ──────► [请求头未返回：signal 无法原生取消] ──► reader 到手 ──► abort 可靠生效
             ↑ 此窗口内点「停止」
```

**UI 处理**：点击停止立即置按钮为 disabled + 视觉「停止中」，并标记本地 `aborted` 意图；
待 reader 到手后 abort 真正生效。⛔ 不得为了"能取消"而绕开 `MastraClient` 改用裸 fetch。

### 模块 4: 滚动贴底策略

```ts
const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
if (nearBottom) el.scrollTop = el.scrollHeight;   // 仅在贴近底部时自动跟随
```

用户手动上滚（脱离底部 >80px）后**停止**自动跟随（AC-006），避免抢夺滚动控制权。

### 模块 5: 组件拆分

| 组件 | 职责 | 需求锚点 |
|---|---|---|
| `<ChatHeader />` | 标题 + 副标题 + 三枚能力徽章 | F-001 |
| `<MessageList />` | 滚动容器 + 贴底策略 + `pb-40` | F-002 |
| `<UserBubble />` | 右对齐气泡 | F-003 |
| `<AssistantMessage />` | 身份行 + 正文 + 操作行 | F-004/F-005 |
| `<Composer />` | 快捷 chips + textarea + 发送/停止 + 免责声明 | F-006～F-010 |

安全提示卡、引用角标、订单卡由 feature 6/7 以插槽形式注入 `<AssistantMessage />`。

### 模块 6: 数据通道约束

```tsx
const client = useClient();          // 唯一入口（feature 3 的 Context）
await client.streamChat(...)
```

⛔ 组件层禁止出现：`fetch(`、`axios`、`new MastraClient(`、`getAgent(`、
任何 `:8000`/`:8001`/`:8002`/`:6333`/`:8787`/`:11434` 字面量。

## 接口契约

**消费**（不新增、不改写）：

```ts
streamChat(message, history, onEvent, { signal }): Promise<ChatResponseBody>
```

`history: ChatHistoryTurn[]` 由前端按 `{ role, content }` 累积（F-015）。

## 数据模型

前端内存态，无持久化：

```ts
interface Message { id: string; role: "user" | "assistant"; ... }
```

`history` 提交时由 `Message[]` 映射为 `ChatHistoryTurn[]`（仅 `role` + `content`）。

## 安全考虑

- **⛔ 禁止正则解析 `reply`** 推导任何状态 —— 这是需求 §5.3 的铁律，右栏一律读结构化 `body`
- 正文渲染需防 XSS：使用 React 文本渲染，⛔ 不使用 `dangerouslySetInnerHTML`
  （设计稿的 `<br>` 换行改用 `white-space: pre-wrap` 或按 `\n` 拆分渲染）
- 不在 UI 暴露服务地址；错误只展示 `message` 与 `traceId`
- 取消后必须确保不再向已卸载组件 setState（避免状态泄漏）

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| `text` 与 `body` 分存 | **分存** | `done` 后以结构化为真源，杜绝从流式文本反推状态 |
| 换行渲染 | **`pre-wrap` / 按 `\n` 拆分** | 设计稿用 `<br>`，但 `dangerouslySetInnerHTML` 有 XSS 风险 |
| 取消实现 | **AbortSignal + 乐观置灰** | 库限制无法在请求头前取消；绕开 MastraClient 是明令禁止的 |
| `AbortError` 是否报错 | **不报错** | 用户主动取消不是故障（F-013） |
| 提前结束的归类 | **归为 error** | 无 `done` 意味着结构化数据缺失，回答不可信 |
| 滚动跟随 | **仅贴近底部时跟随** | 强制拉回会抢夺用户滚动控制权 |
| 快捷 chip | **只填入不发送** | 便于用户改订单号（需求 §8.1） |
| 重新生成 | **相同入参重发** | 本期不做多版本回答切换 |
