# workbench-shell-layout — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/4.workbench-shell-layout/`

## 任务列表

### 功能 1: 服务状态数据层

- [ ] T-001: 新建 `hooks/use-service-status.ts`：初始三项 `unknown`、挂载即探测、catch 落为三项 `error` 且不抛出 ~30min
- [ ] T-002: 实现刷新时机 —— 暴露 `refresh()` 供对话 `done`/`error` 调用；可选轮询 ≥30s 且 `visibilityState==="hidden"` 时暂停 ~15min

### 功能 2: 顶栏

- [ ] T-003: `<Header />` 三组骨架 + 左组标题与 JetBrains Mono 副标题（`hidden md:inline`） ~30min
- [ ] T-004: 三项服务状态渲染：四态标签映射 + 8×8px 0 圆角状态点 + 颜色映射，文字与颜色同时传达状态 ~30min
- [ ] T-005: 「清空会话」按钮（`delete` 18px + `hidden md:inline` 文案 + hover/active 态） ~15min

### 功能 3: 左栏与主网格

- [ ] T-006: `<LeftSidebar />`：220px 固定宽、`justify-between` 两端布局、新建会话按钮、会话列表（激活态 2px 竖条 + bold + truncate）、底部本地运行文案 ~30min
- [ ] T-007: 主网格容器（`flex-1 mt-16 max-w-[1920px] mx-auto overflow-hidden`）接入三栏，验证 body 无滚动 ~15min

## 依赖关系

- T-001 依赖 `2.T-007`（`client.status()` 可用）
- T-002 依赖 T-001
- T-004 依赖 T-001、T-003
- T-005 依赖 T-003
- T-006、T-007 依赖 `3.T-006`（骨架与 Context）
- 下游：`7.T-*`（响应式抽屉）依赖 T-006

## 风险点

- **乐观预设在线**：初始值图省事写成 `online`，违反 F-005。
  应对：T-001 常量 `INITIAL` 显式三项 `unknown`；测试断言首帧为「未知」。
- **degraded 直改顶栏**：把聊天的 `degraded` 直接映射到顶栏，导致偶发降级永久染红。
  应对：design.md 模块 4 已说明；T-002 只暴露 `refresh()`，不接受外部直接 setState。
- **status() 失败冒泡**：忘记 catch 造成未捕获 Promise rejection。
  应对：T-001 强制 catch 落 `error`；AC-005 断言控制台无未捕获异常。
- **仅靠颜色区分 degraded/error**：二者同为 `#A14D45`，只看圆点无法区分。
  应对：T-004 必须同时渲染文字标签。
- **左栏被压缩**：flex 容器中 220px 被内容挤压。
  应对：T-006 加 `flex-shrink-0`，AC-007 实测宽度。
