# workbench-shell-layout — 需求规格

## 概述

实现工作台外壳：固定顶栏（含三项服务状态，数据来自 `client.status()`）、左侧会话列表、三栏主网格骨架，构成单页工作台的框架结构。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §4.0、§4.1、§4.2、§5.5 B-6

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求 |

## 用户故事

- 作为客服坐席，我想在顶栏一眼看到三项服务状态，以便知道当前回答能力是否完整。
- 作为客服坐席，我想在左栏切换最近会话，以便回顾此前的处理记录。

## 功能需求

1. [F-001] 顶栏 `fixed top-0 w-full z-50 h-16`，`bg content-bg`，底部 1px `border-color` 分隔线，水平内边距 `gutter`(24px)。
2. [F-002] 顶栏左组：标题「智修客服」（Inter 24px/1.3 bold）+ 副标题「家电售后智能助手」（**JetBrains Mono 14px**，`text-muted`，左侧竖线 + `pl-4`，`hidden md:inline`）。
3. [F-003] 顶栏中组三项服务状态（`hidden md:flex gap-6`，label-sm 14px，`text-muted`），每项含 8×8px **0 圆角方块**状态点：`本地模型` / `知识库` / `订单服务`。
4. [F-004] 三项状态**只能**来自 `client.status()` 返回的 `localModel`/`knowledgeBase`/`orderService`。
   ⛔ **禁止**根据最近一次聊天请求的结果推断服务状态。
5. [F-005] 首次探测尚未完成时，三项一律显示 `unknown`（未知，`#8A94A3`）；⛔ 不得乐观预设为「在线」。
6. [F-006] 四态映射：`unknown`→未知`#8A94A3` / `online`→在线`#3F7C5F` / `degraded`→降级`#A14D45` / `error`→异常`#A14D45`。
7. [F-007] `status()` 调用失败（网络错误/超时/非 2xx）时，三项显示 `error`，且不抛出未捕获异常。
8. [F-008] 状态刷新时机：页面首次挂载 + 每次对话 `done`/`error` 之后 + 手动重试；若实现轮询则间隔 ≥ 30s 且页面隐藏时暂停。
9. [F-009] 顶栏右侧「清空会话」按钮：`delete` 图标 18px + 文字（`hidden md:inline`），`hover:text-brand-primary`，`active:opacity-70`。
10. [F-010] 左栏 `w-[220px]` 固定，`bg sidebar-left-bg`，右侧 1px 边框，`p-4`，`flex-col justify-between`，`overflow-y-auto no-scrollbar`，`hidden md:flex`。
11. [F-011] 左栏「新建会话」按钮：满宽、`bg brand-primary`、文字 `content-bg`、`py-3 px-4`、`add` 图标、`hover:bg brand-primary-hover`、下方 24px 间距。
12. [F-012] 左栏会话列表：`space-y-1`，每项 `px-3 py-2` 14px `truncate`；**激活态** = `bg brand-light-bg` + `text-primary` + 左侧 2px `brand-primary` 竖条 + bold；默认态 `text-secondary` + `hover:bg brand-light-bg`。
13. [F-013] 左栏底部固定文案「本地运行 · 数据不会离开当前设备」，12px `text-muted`，`mt-8 pt-4 text-center`。
14. [F-014] 主网格：`flex-1 mt-16 flex overflow-hidden w-full max-w-[1920px] mx-auto`，页面整体不滚动。

## 非功能需求

- **性能**: `status()` 探测不阻塞外壳渲染 —— 先渲染 `unknown` 再异步更新。
- **安全**: 顶栏只展示四态枚举，不展示任何服务地址或错误细节。
- **可访问性**: 状态点需有文字标签（不单靠颜色传达状态）。
- **兼容性**: 桌面优先；`<768px` 左栏与顶栏状态隐藏（响应式抽屉由 feature 7 实现）。

## 验收标准

- [ ] [AC-001] 顶栏高度实测 64px，固定不随内容滚动，`z-50` 覆盖内容。
- [ ] [AC-002] 副标题与状态文字字体分别为 JetBrains Mono / Inter，与 §3.2 一致。
- [ ] [AC-003] 首次加载瞬间三项显示「未知」+ 灰点，探测返回后更新为真实状态。
- [ ] [AC-004] mock `status()` 返回四态，顶栏文案与圆点颜色逐一正确。
- [ ] [AC-005] mock `status()` 抛错，三项显示「异常」，控制台无未捕获异常。
- [ ] [AC-006] 聊天返回 `degraded: true` 时，顶栏**不**直接变色，而是触发一次 `status()` 刷新后由其结果决定。
- [ ] [AC-007] 左栏宽度实测 220px，激活项具备左侧 2px 竖条与 bold。
- [ ] [AC-008] 长会话标题正确 `truncate`，不撑破 220px。
- [ ] [AC-009] 页面 body 无滚动条，左栏内部可滚动且滚动条不可见。
- [ ] [AC-010] 状态点实测 `border-radius: 0`。

## 依赖

- feature `2.service-status-endpoint`（提供 `client.status()`）
- feature `3.workbench-app-scaffold`（提供令牌与骨架）

## 开放问题

- 会话列表本期为**前端本地状态**（无持久化后端），刷新后清空。若需持久化需另行评审存储方案。
