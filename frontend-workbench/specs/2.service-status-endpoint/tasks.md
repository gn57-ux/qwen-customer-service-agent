# service-status-endpoint — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/2.service-status-endpoint/`

## 任务列表

### 功能 1: 契约定义

- [ ] T-001: `contract.ts` 定义 `ServiceState` 与 `ServiceStatusBody`，并镜像同步到 `web-client/src/types.ts` ~15min

### 功能 2: 探测层

- [ ] T-002: 新建 `health/probes.ts`，实现统一 `probe()` 包装器（独立 2s 超时 + 异常归一为 `{ok:false}` + 细节只写日志） ~30min
- [ ] T-003: 实现 `probeQdrant`/`probeEmbedding`/`probeLlamaServer`/`probeOrderService` 四个探测器，URL 取自 `rag/config.ts` 与订单工具既有配置 ~30min
- [ ] T-004: 接入 `probeReranker` —— 复用现有 `LlamaCppReranker.health()`，不另写探测逻辑 ~15min
- [ ] T-005: 实现 `collectServiceStatus()`：`Promise.all` 并发探测 + `aggregateKnowledgeBase()` 三分支聚合 ~30min

### 功能 3: route 与客户端

- [ ] T-006: 新增 `customerServiceStatusRoute`（GET，恒返回 200）并在 `mastra/index.ts` 的 `apiRoutes` 注册 ~15min
- [ ] T-007: `client.ts` 新增 `status()`，经 `MastraClient.request()` 调用；扩展 `scripts/smoke.ts` 覆盖该端点 ~30min

### 集成与测试

- [ ] T-008: 测试：聚合三分支（全可用/仅 Reranker 挂→degraded/基础检索挂→error）+ 挂起下游 3s 内返回 + 全挂仍 200 + 响应体脱敏断言（不含 URL/端口/IP/堆栈） ~30min

## 依赖关系

- T-001 依赖 `1.T-001`（同一 contract.ts 文件，避免并行改动冲突）
- T-003、T-004 依赖 T-002
- T-005 依赖 T-003、T-004
- T-006 依赖 T-005
- T-007 依赖 T-001、T-006
- T-008 依赖 T-007
- 下游 feature：`4.T-*`（顶栏状态展示）依赖 `2.T-007`

## 风险点

- **脱敏被无意破坏**：调试时顺手把 `err.message` 塞进响应体。
  应对：`ProbeResult` 只保留 `ok` 字段，从类型层面阻断；T-008 含脱敏断言，`8.T-*` 门禁再兜一层。
- **探测串行导致超时**：忘记 `Promise.all` 写成 `await` 串行，最坏 10s。
  应对：T-005 明确并发；T-008 用挂起下游验证 3s 上限。
- **Reranker 判定双标**：另写一套探测，与检索链路的降级判定不一致，导致顶栏显示 online 但实际检索已降级。
  应对：T-004 强制复用 `LlamaCppReranker.health()`。
- **contract.ts 并行冲突**：与 feature 1 同文件。
  应对：依赖关系已声明 T-001 依赖 `1.T-001`，串行执行。
- **订单服务 base URL 来源不明**：需从 `queryOrderTool` 既有配置读取，勿新增环境变量。
  应对：T-003 实现前先读 `tools/query-order-tool.ts` 确认配置来源。
