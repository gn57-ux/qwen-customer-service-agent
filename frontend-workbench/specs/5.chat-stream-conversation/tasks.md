# chat-stream-conversation — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/5.chat-stream-conversation/`

## 任务列表

### 功能 1: 流式状态层

- [x] T-001: 新建 `hooks/use-chat-stream.ts`：`AssistantTurn` 状态机，`text`（流式累积）与 `body`（结构化真源）分开存储 ~30min
- [x] T-002: 接入 `streamChat()` 五类事件分发（meta/tool-result/text-delta/done/error），done 后以 `body` 为真源 ~30min
- [x] T-003: 收尾归一：`AbortError`→`aborted`（不报错、保留内容）、`error` 与「提前结束」→`error`，finally 触发 `4.T-002` 的 `refresh()` ~30min
- [x] T-004: 取消实现：`AbortController` + 停止按钮乐观置灰（应对请求头返回前无法原生取消的库限制） ~15min

### 功能 2: 对话区 UI

- [x] T-005: `<ChatHeader />`（标题/副标题/三枚能力徽章）+ `<MessageList />`（滚动容器、`pb-40` 避让、贴近底部才跟随的滚动策略） ~30min
- [x] T-006: `<UserBubble />` 与 `<AssistantMessage />`（身份行 + 正文 pre-wrap 换行 + 操作行四按钮），并预留安全卡/引用/订单卡插槽 ~30min

### 功能 3: 输入区

- [x] T-007: `<Composer />`：4 个快捷 chip（点击仅填入不发送、横向滚动隐藏滚动条）+ textarea + 发送/停止按钮 + 免责声明 ~30min

## 依赖关系

- T-001 → T-002 → T-003 → T-004 顺序执行
- T-005、T-006 依赖 `3.T-006`
- T-007 依赖 T-004（需要停止态）
- T-003 依赖 `4.T-002`（`refresh()` 可用）
- 下游：`6.T-*` 消费 `body`；`7.T-*` 填充插槽

## 风险点

- **从流式文本反推状态**：图省事对 `reply` 做正则判断有没有安全提示。
  应对：T-001 强制 `text`/`body` 分存；`6.T-*` 一律读 `body`；code review 重点核查。
- **XSS**：设计稿正文含 `<br>`，容易顺手用 `dangerouslySetInnerHTML`。
  应对：T-006 明确用 `pre-wrap` 或按 `\n` 拆分渲染。
- **绕开 MastraClient 实现取消**：为规避库限制改用裸 fetch —— 明令禁止。
  应对：T-004 只允许 AbortSignal + 乐观置灰；`8.T-*` 门禁扫描 `fetch(`。
- **滚动抢夺**：无条件贴底导致用户无法回看历史。
  应对：T-005 实现 80px 阈值判定。
- **取消后 setState 泄漏**：组件卸载后仍更新状态。
  应对：T-003 收尾处判断挂载状态。
- **`pb-40` 被误删**：看似冗余的底部留白，实为输入区避让。
  应对：T-005 注释说明；AC-007 实测最后一条消息不被遮挡。
