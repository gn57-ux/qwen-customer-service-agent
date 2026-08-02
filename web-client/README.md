# web-client — 智修客服 AI 工作台（前端）

React + Vite + Tailwind 单页工作台，是客服坐席唯一使用的前端界面；同时对外
共享一个最小的 Mastra 客户端包（`src/client.ts`），供 smoke 脚本与未来其他
调用方复用。

## 架构概览

```
web-client/
├── src/
│   ├── client.ts        # 唯一允许发起网络请求的入口：封装 @mastra/client-js
│   │                     # 的 MastraClient，暴露 chat / streamChat / status
│   ├── types.ts         # 与 mastra-agent/src/mastra/contract.ts 保持一致的类型镜像
│   │                     # （一致性由 mastra-agent 的 contract-mirror.test.ts 自动校验）
│   └── app/             # 工作台 UI
│       ├── App.tsx              # 根组件：三栏布局 + 会话状态 + 响应式抽屉
│       ├── client-context.tsx   # useClient() 单例注入点，组件层只能经它访问 Mastra
│       ├── hooks/                # useServiceStatus / useChatStream
│       ├── components/           # Header / LeftSidebar / MainChat / RightPanel / Drawer / ...
│       ├── evidence/             # 处理依据推导层（deriveEvidence，纯函数，可单测）
│       └── scenarios/            # 场景插槽分发 + 订单状态机（纯函数，可单测）
├── scripts/
│   ├── smoke.ts                       # 真实服务 smoke 测试（需要 Mastra + 下游全部在线）
│   ├── gate-no-direct.sh              # 门禁：禁止直连下游 6 个端口 / getAgent(
│   ├── gate-no-hardcoded-count.sh     # 门禁：召回/重排文案禁止硬编码 20/5
│   └── gate-assets.sh                 # 门禁：设计资产 SHA-256 完整性
└── tailwind.config.ts    # 逐字迁移自 Stitch 设计稿的设计令牌（颜色/字体/间距/圆角）
```

**核心约束**（源自需求 §11.3，测试与门禁强制）：
- 组件层只能通过 `useClient()` 访问后端，⛔ 不得出现 `fetch(`/`axios`/`new MastraClient(`。
- 前端只允许访问 Mastra 服务（默认 `:4111`），⛔ 不得直连 FastAPI(8000)/Mock(8001)/
  llama-server(8002)/Qdrant(6333)/Reranker(8787)/Ollama(11434)。
- 圆角系统（2026-08-01 起）：分层圆角（`DEFAULT:12px lg:16px xl:24px full:9999px`
  + 大量任意值），逐组件数值见 `frontend-workbench/specs/9.stitch-v2-visual-
  restoration/design.md`（旧版"全局 0 圆角"已被用户明确推翻，改动前先确认）。
- 右栏「处理依据」的所有展示项必须能追溯到 `ChatResponseBody` 的结构化字段，
  ⛔ 不得对 `reply` 正文做正则/关键词解析来推断状态。

## 功能模块

- **顶栏**：服务四态展示（本地模型/知识库/订单服务）+ 手动重试 + 清空会话。
- **左栏**：会话列表（本地状态，无持久化），<768px 收进左侧抽屉。
- **中间对话区**：流式回复（5 类 SSE 事件）、四类业务场景差异化渲染（安全/订单/维修/普通）、
  取消/错误/降级三种非正常收尾的明确 UI 区分。
- **右栏「处理依据」**：执行链路时间轴、回答模式 chip、引用来源（含高优标记与点击定位）、
  traceId/耗时，<1100px 收进右侧抽屉（与桌面版 100% 复用同一份内容组件）。
- **响应式**：≥1280px 三栏完整；1100–1279px 右栏收窄；768–1099px 右栏收进抽屉；
  <768px 左栏也收进抽屉，顶栏/对话头部转紧凑布局。

## 快速开始

```bash
npm install
npm run dev          # 启动 Vite 开发服务器（默认 http://localhost:5173）
```

无需后端服务也能查看界面结构（服务状态会显示为"异常"，聊天需要真实 Mastra
服务）。完整联调需要先启动 `mastra-agent`（`npm run dev`，默认 `:4111`）及其
依赖的下游服务。

## 常用命令

| 命令 | 作用 |
| ---- | ---- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | 类型检查 + Vite 生产构建 |
| `npm test` | Vitest + Testing Library 组件/纯函数测试 |
| `npm run smoke` | 对真实 Mastra 服务（`:4111`）做端到端往返验证（chat/stream/status） |
| `npm run gate:no-direct` | 扫描禁止的直连端口/绕过用法 |
| `npm run gate:no-hardcoded-count` | 扫描召回/重排计数硬编码 |
| `npm run gate:assets` | 校验设计资产 SHA-256 |
| `npm run gates` | 聚合门禁：typecheck→build→test→上述三个 gate（不含 smoke 与设计复核） |

## 测试策略

- 组件测试通过 `<ClientProvider client={mockClient}>` 注入可控的 mock 客户端，
  ⛔ 不 mock 全局 `fetch`——那样会掩盖"组件绕过 `client.ts` 直接发请求"这个
  门禁本该拦住的问题。
- `evidence/derive.ts`、`scenarios/order-view.ts`、`scenarios/render-slots.ts`
  是不接受正文字符串的纯函数，配套单测覆盖全部分支（含非 20/5 的构造值，
  用行为验证而非硬编码扫描来兜住"变量名绕过"这类盲区）。

## 环境变量

| 变量 | 默认值 | 说明 |
| ---- | ---- | ---- |
| `VITE_MASTRA_BASE_URL` | `http://127.0.0.1:4111` | 前端运行时访问的 Mastra 服务地址 |
| `MASTRA_BASE_URL` | `http://127.0.0.1:4111` | `scripts/smoke.ts` 使用的服务地址 |
