# CLAUDE.md — ai-kefu

多包单仓：本地 QLoRA 微调 + RAG + Mastra Agent + React 客服工作台前端。

## 目录结构

```
services/           # Python：FastAPI 推理 API（:8000）+ Mock 订单后端（:8001）—— ⛔ 冻结
datasets/ configs/   # LLaMA Factory 训练数据/配置 —— ⛔ 冻结
knowledge/           # RAG 知识库源文档 —— ⛔ 冻结
models/              # 模型/adapter（多为 .gitignore） —— ⛔ 冻结
mastra-agent/        # Mastra Server（:4111）：Agent/Tools/RAG/自定义 route/契约定义
web-client/          # 客服工作台前端：React + Vite + Tailwind + 共享 Mastra 客户端包
frontend-workbench/  # 前端需求/设计/开发规格（specs/），LESSONS.md 记录架构决策与踩坑
```

`services/**`、`datasets/**`、`training/**`、`configs/**`、`knowledge/**`、
`models/**` 是本轮前端改造的冻结范围——除非用户明确要求，不要改动这些目录。

## 技术栈

- 后端：Mastra 1.20.1 + `@mastra/core` 1.52.1，TypeScript，`node:test` 测试
- RAG：Qdrant（向量检索）+ Ollama（Embedding）+ 自建 Reranker（GGUF）
- 前端：React 19 + Vite + Tailwind v3（非 v4）+ Vitest + Testing Library
- 训练：LLaMA Factory + Qwen3-4B-Instruct-2507 QLoRA

## 关键约束

- **前端组件层只能经 `web-client/src/app/client-context.tsx` 的 `useClient()`
  访问后端**，⛔ 禁止 `fetch(`/`axios`/`new MastraClient(`/`getAgent(`；
  ⛔ 禁止直连 6 个下游端口（8000/8001/8002/6333/8787/11434），仅允许访问
  Mastra 服务（:4111）。见 `web-client/scripts/gate-no-direct.sh`。
- **前后端契约**（`ChatResponseBody`/`OrderStatus`/`ServiceStatusBody` 等）
  权威定义在 `mastra-agent/src/mastra/contract.ts`，`web-client/src/types.ts`
  是手动镜像，改一处要同步改另一处——`mastra-agent` 的
  `contract-mirror.test.ts` 会自动校验两边字段/类型一致。
- **右栏「处理依据」/场景差异化渲染只能读结构化字段**（`route`/`toolCalls`/
  `retrievedCount`/`sources`/`order.details`），⛔ 禁止对 `reply` 正文做正则/
  关键词解析来推断状态。
- **订单详情只读 `order.details` 白名单**（10 个可空字段），⛔ 禁止解析泛型
  `toolCalls[].result`；字段为 `null` 时隐藏该行/显示"—"，⛔ 不得填默认值；
  `canCancel: null` 不等于 `false`，不得回落。
- **全局 0 圆角设计系统**（`web-client/src/app/styles.css` 强制），组件层不写
  `rounded-*`。
- 详见 `.claude/rules/frontend-conventions.md`、
  `frontend-workbench/specs/LESSONS.md`（按 feature 记录的完整踩坑历史）与
  `frontend-workbench/specs/memory/`（按主题索引的可复用经验）。

## 常用命令

```bash
cd mastra-agent && npm run dev              # 启动 Mastra Server（:4111）
cd mastra-agent && npm run test             # typecheck + 单元测试（node:test）
cd web-client && npm run dev                # 启动前端（:5173）
cd web-client && npm run gates              # typecheck+build+test+3个质量门禁
cd web-client && npm run smoke              # 对真实 :4111 服务做端到端往返验证
```

## 测试约定

- 前端组件测试通过 `<ClientProvider client={mockClient}>` 注入 mock，⛔ 不
  mock 全局 `fetch`（会掩盖"绕过 client.ts 直连"的问题，正是门禁要拦的）。
- 后端测试用 `node:test`（非 Vitest），`node --experimental-test-module-mocks`
  + `mock.module()` 挂载真实 Hono route 测试，不需要起完整服务链路。
- 计数类展示（召回数/重排数）单测要用非 20/5 的构造值（如 17/3），配合
  `gate-no-hardcoded-count.sh` 的文案正则形成双重防护。
