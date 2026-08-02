# evidence-panel — 需求规格

## 概述

实现右侧「处理依据」面板：执行链路时间轴、回答模式徽章、引用来源列表、底部 traceId 与耗时。**所有数据只能来自结构化 `ChatResponseBody`**，严禁从回复正文正则猜测。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §4.5、§5.3、§5.5-A、§6.1

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求 |

## 用户故事

- 作为客服坐席，我想看到这次回答走过的完整链路与引用来源，以便向客户解释结论从何而来。
- 作为质检，我想让每条展示都能追溯到结构化字段，以便判定回答是否可信。

## 功能需求

1. [F-001] 右栏 `w-[300px]`（`xl` 以上 `320px`），`bg sidebar-right-bg`，左侧 1px 边框，`hidden min-[1100px]:flex`（断点为 **1100**，非 lg/1024）。
2. [F-002] 头部 `p-6 border-b`：标题「处理依据」18px + `memory` 图标 `brand-primary`；副标题「本次回答的可验证执行记录」12px `text-muted`。
3. [F-003] 内容区 `flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar`，**整体 JetBrains Mono 14px/1.5**。
4. [F-004] 执行链路：小标题 12px `uppercase tracking-wider`；`ul space-y-4` + 左侧 1px 竖线（`border-l ml-2 pl-4`）；节点圆点 `absolute -left-[21px] top-1 w-2 h-2`（0 圆角）。
5. [F-005] 执行链路节点**结构化推导规则**（⛔ 禁止正则解析 `reply`）：
   | 节点 | 数据来源 | 条件 |
   |---|---|---|
   | 已识别 · {类别} | `route` | `safety→安全咨询`/`order→订单查询`/`repair→维修排查`/`general→一般咨询` |
   | 已调用 · {工具} | `toolCalls[].name` | `searchKnowledgeBase→维修知识库`；`queryOrderTool→订单服务`；每个被调用工具一个节点 |
   | 已召回 · {N} 个候选片段 | **`retrievedCount`** | `> 0` 才渲染；⛔ 禁止硬编码 20 |
   | 重排完成 · Top {N} | **`returnedCount`** | 须 `reranked === true`；⛔ 禁止硬编码 5 |
   | 已生成 | `done` 事件到达 | — |
   | 已触发 · 安全策略 | `route === "safety"` | safety 色 + bold |
6. [F-006] 节点配色：前两节点 `success-green`，中间 `brand-primary`，安全节点 `safety-text` + bold。
7. [F-007] 回答模式卡：`bg content-bg border p-4`；chips 12px —— `本地QLoRA`（恒显示）、`RAG知识增强`（`sources` 非空）、`安全策略介入`（`route==="safety"`，含 `gpp_maybe` 12px 图标）。
8. [F-008] degraded 展示：`degraded === true` 时追加 `降级运行` chip（safety 配色 + `gpp_maybe`），下方 12px 展示 `degradedReason`（无则「未提供降级原因」）。
   ⛔ **不得**据此改写顶栏状态点（顶栏只反映 `status()`，见 `4.F-004`）；应触发一次 `status()` 刷新。
9. [F-009] 引用来源列表：`ul space-y-2`，每项 `bg content-bg border p-3` + `border-l-2`；标题 13px `truncate` = `sources[].title`；元信息 10px `opacity-60` = `${sourceFile} · ${documentVersion}`。
10. [F-010] 「高优」标记规则：`reranked === true` **且**该项 `rerankScore` 为最大值；⛔ 不得用文件名或标题猜测。
11. [F-011] 左边框色：`route === "safety"` 时 rank-1 用 `safety-text`，其余一律 `brand-primary`。
12. [F-012] 底部栏 `p-4 border-t flex justify-between`，JetBrains Mono 12px：左 = `traceId`；右 = `(latencyMs/1000).toFixed(1) + "s"`。
13. [F-013] 空状态：内容区显示「暂无处理记录，发送问题后展示执行链路」；引用来源区无数据时显示「本次回答未引用知识库」；底部 traceId/耗时显示 `—`。
14. [F-014] 流式期间：`meta` 到达后显示 traceId 并进入处理中态；`tool-result` 实时追加链路节点；`done` 后以结构化 `body` **覆盖重建**全部内容。

## 非功能需求

- **正确性**: 每个展示项必须可追溯到 `ChatResponseBody` 的具体字段（可逐项审计）。
- **性能**: `done` 覆盖重建不得引起可见闪烁。
- **安全**: 不渲染任何未在契约中定义的内容；不解析正文。
- **可维护性**: 推导规则集中在纯函数中，便于单测。

## 验收标准

- [ ] [AC-001] 右栏宽度实测 300px，≥1280px 时 320px；<1100px 隐藏。
- [ ] [AC-002] 内容区字体为 JetBrains Mono。
- [ ] [AC-003] 「已召回」数值等于 `retrievedCount`，「重排完成」等于 `returnedCount`；全仓无 20/5 硬编码。
- [ ] [AC-004] `reranked !== true` 时不渲染「重排完成」节点。
- [ ] [AC-005] `retrievedCount === 0` 时不渲染「已召回」节点。
- [ ] [AC-006] `route === "safety"` 时出现安全节点（safety 色 + bold）与「安全策略介入」chip。
- [ ] [AC-007] 「高优」只出现在 `rerankScore` 最大项，且 `reranked === false` 时不出现。
- [ ] [AC-008] `degraded: true` 时出现「降级运行」chip 与原因；顶栏**未**被直接改色。
- [ ] [AC-009] 底部 traceId 与耗时格式正确（`2.8s`）。
- [ ] [AC-010] 空状态三处占位文案正确。
- [ ] [AC-011] 流式期间链路节点随 `tool-result` 实时增加，`done` 后被结构化数据覆盖。
- [ ] [AC-012] 源码审计：右栏无任何对 `reply` 的正则/字符串匹配。

## 依赖

- feature `1.contract-retrieval-counts`（提供 `retrievedCount`/`returnedCount`）
- feature `3.workbench-app-scaffold`（令牌与骨架）
- feature `5` 的 `AssistantTurn.body`（结构化真源）

## 开放问题

- 引用来源点击行为（跳转/展开原文）设计稿仅标注 `cursor-pointer` 与 hover 态，未定义具体动作。
  本期实现为 hover 高亮 + 点击滚动定位到正文对应引用角标，不做外链跳转。
