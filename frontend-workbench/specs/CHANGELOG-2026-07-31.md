# 变更日志 — 2026-07-31

前端工作台改造，8 个 feature 全部完成（提交范围 `61d9731`..`3bce1db`）。

## Feature 1: contract-retrieval-counts

### 新增
- `ChatResponseBody` 新增 `retrievedCount`/`returnedCount` 字段，追踪向量检索
  实际命中数与最终返回条数
- `OrderStatus.details` 类型化白名单（10 个可空字段），替代前端直接解析泛型
  `toolCalls[].result` 的方案

### 关键文件
- `mastra-agent/src/mastra/contract.ts` — `buildContractExtras()` 共用出口
- `mastra-agent/src/mastra/routes/customer-service.ts` — 两处响应体组装点（chat/stream）
- `mastra-agent/src/mastra/tools/search-knowledge-base-tool.ts`

### 架构决策
- `ChatResponseBody` 组装点在 route 层（两处），不在 `orchestration.ts`——后者
  只产出 `AgentRunResult`，⛔ 禁止为契约字段改动它
- 可空字段必须显式赋 `null`，不能省略成 `undefined`（避免"可选属性"掩盖字段缺失）
- `found`/`error` 类判定字段必须在数据提取前短路，不能事后过滤

## Feature 2: service-status-endpoint

### 新增
- `GET /customer-service/status`：本地模型/知识库/订单服务三项四态聚合探测
- `web-client` 的 `client.status()`

### 关键文件
- `mastra-agent/src/mastra/health/probes.ts` — `probe()`/`aggregateKnowledgeBase()`
- `mastra-agent/src/mastra/routes/customer-service.ts` — status route

### 架构决策
- 本地模型健康探测目标是 FastAPI `:8000`，不是 `llama-server:8002`（后者仅供
  FastAPI 内部转发）
- FastAPI `/health` 在 `not_loaded`/`degraded` 时依然返回 HTTP 200，判定必须
  解析 body 的 `status` 字段
- Ollama 模型名归一化要双向做（id 与 target 都可能带 `:tag`）

## Feature 3: workbench-app-scaffold

### 新增
- `web-client/src/app/` 内搭建 Vite + React 19 + Tailwind v3 应用层脚手架
- 逐字迁移 Stitch screen 内联设计令牌（颜色/字体/间距/圆角）

### 关键文件
- `web-client/tailwind.config.ts`、`web-client/src/app/styles.css`

### 架构决策
- Tailwind v3（非 v4）：v4 的 CSS-first `@theme` 与本项目 `tailwind.config.ts`
  架构不匹配
- 门禁扫描是纯文本匹配，注释里写"禁止的字面量示例"要用转述规避误判

## Feature 4: workbench-shell-layout

### 新增
- 顶栏（三项服务状态、清空会话）、左栏（会话列表）、三栏主网格骨架

### 关键文件
- `web-client/src/app/hooks/use-service-status.ts`
- `web-client/src/app/components/Header.tsx`、`LeftSidebar.tsx`

### 架构决策
- 初始状态硬性 `unknown`，⛔ 不得乐观预设 `online`
- 并发防护：自增 request id + 归属比对，防止旧请求覆盖新状态
- 图标按钮/可点击列表项要有键盘可达性（真实 `<button>` + `aria-label` +
  图标 `aria-hidden`）

## Feature 5: chat-stream-conversation

### 新增
- 中间对话区、底部输入区、流式 5 类 SSE 事件处理、取消

### 关键文件
- `web-client/src/app/hooks/use-chat-stream.ts`
- `web-client/src/app/components/{ChatHeader,MessageList,UserBubble,AssistantMessage,Composer,MainChat}.tsx`

### 架构决策
- 受控 hook + 定向写入：`useChatStream` 不自己持有会话数据，由调用方按
  `sessionId` 定向写回，切换会话不再互相污染
- 同步中断路径（切换会话/取消/清空）必须搬全异步 `finally` 原本做的每一件事
  （状态归位 + `onSettled` + 资源释放），不能只改一半

## Feature 6: evidence-panel

### 新增
- 右侧「处理依据」面板：执行链路、回答模式、引用来源、trace/耗时

### 关键文件
- `web-client/src/app/evidence/derive.ts`
- `web-client/src/app/components/RightPanel.tsx`（含 `EvidencePanelContent` 导出）

### 架构决策
- 推导逻辑集中在不接受正文字符串的纯函数里，结构上阻断"正则解析 reply"
- "唯一最大值"判定要用严格大于维护下标，不能先 `Math.max()` 再逐项 `===`
  （并列时会选出全部项）
- 引用角标锚点 id 由 `citation.ts` 统一生成，供正文渲染与右栏点击定位共用

## Feature 7: scenarios-and-degradation

### 新增
- 四类业务场景差异化渲染、订单卡 6 态、degraded/error 视觉规格、响应式抽屉

### 关键文件
- `web-client/src/app/scenarios/{render-slots,order-view}.ts`
- `web-client/src/app/components/{OrderCard,SafetyCard,Drawer}.tsx`

### 架构决策
- 订单卡渲染三条件缺一不可：`route==="order"` + 调用过 `queryOrderTool` + `order` 存在
- `found:false` 无 `error`（契约允许的边界）不得落到"成功"分支
- 抽屉进退场动画要在 render 阶段同步派生 `isClosing`/`entered`，不能放进
  `useEffect`（会晚一整个渲染周期）
- CSS 断点隐藏要配 `matchMedia` 主动收口交互状态，否则视觉隐藏后焦点陷阱仍困住用户看不见的面板

## Feature 8: quality-gates-and-design-review

### 新增
- 3 个门禁脚本（直连扫描/计数硬编码扫描/资产完整性）+ `npm run gates` 聚合
- `contract-mirror.test.ts`：`contract.ts` ↔ `web-client/types.ts` 字段签名
  自动化一致性校验（含引用别名解析、多行字段声明支持）
- 设计还原验收：19 个颜色 token、13 个图标基线、断点/抽屉浏览器实测

### 关键文件
- `web-client/scripts/gate-*.sh`
- `mastra-agent/src/mastra/contract-mirror.test.ts`
- `frontend-workbench/docs/assets/checksums.txt`

### 架构决策
- 手写源码级解析器要按"字段名→类型/可选→引用别名解析→多行切分→符号歧义
  （`=>` 不是泛型收尾）"四层加固，否则每层都可能被绕过
- `gates` 聚合刻意不含 `smoke` 与设计复核（前者需真实服务，后者需人工/MCP，
  混入会让 CI 因环境缺失假失败）
