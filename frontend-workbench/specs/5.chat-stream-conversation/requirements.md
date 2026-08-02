# chat-stream-conversation — 需求规格

## 概述

实现中间对话区与底部输入区，并接入 `streamChat()` 的全部 5 类 SSE 事件（`meta`/`tool-result`/`text-delta`/`done`/`error`），支持流式增量渲染与用户主动取消。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §4.3、§4.4、§5.1、§5.4

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求 |

## 用户故事

- 作为客服坐席，我想看到回答逐字生成，以便尽早判断方向是否正确而不必干等。
- 作为客服坐席，我想在回答跑偏时立刻停止生成，以便快速重问。

## 功能需求

1. [F-001] 对话区头部：标题「家电售后智能客服」（22px，md 以上 24px，bold）+ 副标题「可咨询冰箱、彩电、显示器维修问题」+ 右侧三枚能力徽章 `QLoRA`/`RAG`/`Tools`（`bg brand-light-bg`，`text brand-primary`，`px-3 py-1`，13px）。
2. [F-002] 消息流容器：`flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-8 no-scrollbar pb-40`；`pb-40`(160px) 为输入区避让，**不可省略**。
3. [F-003] 用户消息右对齐，气泡 `bg brand-light-bg`，`px-6 py-4`，`max-w-2xl`(672px)，文字 15px（md 16px）。
4. [F-004] AI 消息左对齐，容器 `max-w-3xl`(768px)；含身份行（`smart_toy` 20px `brand-primary` + 「智修客服」label-sm bold）与正文（`text-secondary`，行高 1.6 / md 1.7）。
5. [F-005] AI 消息操作行：`content_copy 复制` / `refresh 重新生成` / `thumb_up 有帮助` / `thumb_down 没有帮助`，12px 文字 + 16px 图标，`text-muted`，`hover:text-text-primary`。
6. [F-006] 输入区绝对定位贴底（`absolute bottom-0`），`bg content-bg`，顶部 1px 边框，`p-4 md:px-8`；内层 `max-w-4xl`(896px) 居中。
7. [F-007] 快捷问题条：4 个 chip（`冰箱不制冷`/`电视开机黑屏`/`显示器无信号`/`查询ORD1001`），`border`，12px，`px-3 py-1`，横向可滚动且滚动条隐藏；点击**仅填入输入框，不自动发送**。
8. [F-008] 输入框容器 `border input-border`，`focus-within:border-brand-primary`；`textarea rows=2`，`p-4 pb-12`，`resize-none`，无 focus ring，placeholder「请输入维修问题或订单号，例如：查询订单ORD1001」。
9. [F-009] 发送按钮绝对定位 `bottom-3 right-3`，`bg brand-primary`，`p-2`，`arrow_upward` 20px，`hover:bg brand-primary-hover`。
10. [F-010] 底部免责声明「AI建议仅供初步排查，不可替代专业维修诊断。」12px `text-muted` 居中。
11. [F-011] 所有对话请求**必须**经 `web-client/src/client.ts` 的 `streamChat()`；⛔ 禁止组件内 `fetch`/`axios`/`new MastraClient(`，禁止 `getAgent().generate()`。
12. [F-012] 必须处理全部 5 类事件：
    - `meta` → 记录 `traceId`，右栏进入处理中态
    - `tool-result` → 实时追加执行链路节点
    - `text-delta` → 增量追加正文并保持滚动贴底
    - `done` → 用结构化 `ChatResponseBody` 覆盖重建
    - `error` → 进入错误态并停止流
13. [F-013] 流式期间发送按钮转「停止」态，点击触发 `AbortSignal`；`AbortError` 属用户主动取消，**不显示错误提示**，保留已生成内容。
14. [F-014] 未收到 `done` 即流结束时，按错误态处理（客户端会抛「流式响应提前结束」）。
15. [F-015] 多轮对话需携带 `history`（`ChatHistoryTurn[]`）。

## 非功能需求

- **性能**: `text-delta` 高频增量渲染不得导致明显掉帧；滚动贴底不得与用户手动上滚冲突。
- **安全**: 不得对 `reply` 正文做正则解析以推导状态（右栏数据来源见 feature 6）。
- **健壮性**: 取消、提前结束、错误三种非正常收尾均须释放资源且不残留「生成中」态。
- **兼容性**: 已知限制 —— `@mastra/client-js@1.33.0` 在响应头返回前无法原生取消，UI 需对此窗口做乐观置灰。

## 验收标准

- [ ] [AC-001] 发送后 `meta` 到达即显示 traceId，正文随 `text-delta` 逐步出现。
- [ ] [AC-002] `done` 到达后正文与结构化字段一致，操作行出现。
- [ ] [AC-003] 流式期间按钮为「停止」态；点击后停止生成，已生成内容保留，**无错误提示**。
- [ ] [AC-004] `error` 事件 → 错误态展示，保留已收到的部分正文。
- [ ] [AC-005] 流提前结束（无 `done`）→ 按错误态处理。
- [ ] [AC-006] 新消息到达时自动滚动贴底；用户手动上滚后不被强制拉回。
- [ ] [AC-007] 最后一条消息不被输入区遮挡（`pb-40` 生效）。
- [ ] [AC-008] 快捷 chip 点击后文本进入输入框且**未**自动发送。
- [ ] [AC-009] 源码扫描：组件层无 `fetch(`/`axios`/`new MastraClient(`/`getAgent(`。
- [ ] [AC-010] 多轮对话第二问携带正确 `history`。

## 依赖

- feature `3.workbench-app-scaffold`（令牌、骨架、client Context）
- 现有 `client.streamChat()` 与 `StreamEvent` 类型（不改写）

## 开放问题

- 「重新生成」按钮语义：本期定义为「以相同入参重发上一问」，不做多版本回答切换。
