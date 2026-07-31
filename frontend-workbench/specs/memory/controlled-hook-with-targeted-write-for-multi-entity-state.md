---
title: 受控 hook + 定向写入——多实体共享同一异步操作 hook 的正确模式
feature: 5.chat-stream-conversation
type: reusable
tags: [react-hook, multi-session, controlled-component, race-condition, use-chat-stream, targeted-write]
date: 2026-07-31
---

**问题/场景**：`useChatStream()` 最初自己持有 `messages` state，用一个全局的 `reset()` 应付"切换会话"——这直接违反了 design.md 定义的"每个会话有自己独立的消息历史"，导致切走会话即丢失该会话内容（Codex Review P1）。

**解法/结论**：把这类 hook 改成**受控 + 定向写入**：
1. hook 不再自己持有实体（这里是"会话"）的数据，而是接收 `{ entityId, data, onDataChange }`，`data` 是调用方（父组件）当前展示的那份。
2. 所有写回都通过 `onDataChange(targetEntityId, updater)` 显式指定目标实体 id，而这个 `targetEntityId` 必须在异步操作**发起的那一刻**用局部变量固定住（例如 `const targetSessionId = sessionId` 写在 `sendMessage` 函数体最前面），不能在回调里重新读取"当前 entityId 是什么"——后者会在异步操作执行期间因为用户切换实体而改变，导致写错地方。
3. 父组件按 `Record<entityId, data>`（或数组 + map）的方式持有全部实体的数据，`onDataChange` 只是通用的按 id 更新函数。

**复用方式**：任何"多个独立实体（会话、标签页、文档、表单）共享同一个异步操作 hook（发请求/流式/长轮询）"的场景都适用。判断信号：如果你发现自己在写"切换 X 时要不要重置 hook 内部状态"这种问题，大概率说明这个 hook 应该被下放数据持有权，改成受控 + 定向写入，而不是加一个 `reset()` 了事。配合 [[synchronous-teardown-must-mirror-async-cleanup]] 一起看：定向写入解决"写到哪"，同步收尾解决"什么时候写、要不要等异步 reject"。
