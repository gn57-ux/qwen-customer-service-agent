# contract-retrieval-counts — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |
| 2026-07-31 | v2 | T-005 组装位置修正为 route 层；新增 T-007/T-008 订单白名单映射 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/1.contract-retrieval-counts/`

## 任务列表

### 功能 1: 契约层字段定义

- [x] T-001: `contract.ts` 的 `ChatResponseBody` 新增必填 `retrievedCount`/`returnedCount`，并在 `extras` 提取逻辑中从 `searchKnowledgeBase` 工具结果取值 ~30min
- [x] T-002: `web-client/src/types.ts` 镜像同步两个字段，逐字段核对与 contract.ts 一致 ~5min

### 功能 2: 工具层计数产出

- [x] T-003: `search-knowledge-base-tool.ts` 的 `outputSchema` 新增两个 `z.number().int().min(0)` 字段及 describe ~15min
- [x] T-004: 三个返回分支（空召回 / 重排成功 / 重排降级）分别补齐计数取值，确保取自 `hits.length` 与 `results.length` 而非配置常量 ~30min

### 功能 3: route 层透传 `[CHANGED v2]`

- [x] T-005: 计数经 `buildContractExtras()` 带出，验证 `routes/customer-service.ts` 的两处组装点（chat `:58`、stream `:105`）均自动携带；⛔ **不得改动 `orchestration.ts`** ~30min `[CHANGED v2: 组装点在 route 层而非 orchestration；v1 描述有误已作废]`

### 功能 4: 订单详情白名单映射 `[NEW v2]`

- [x] T-007: [NEW] `contract.ts` 定义 `OrderDetails` 与 `OrderStatus.details`，实现 `toOrderDetails()` 白名单映射（10 字段 snake_case→camelCase、白名单外丢弃、缺失落 null、非对象返回 undefined），并镜像同步 `types.ts` ~30min
- [x] T-008: [NEW] 映射单测：完整订单（ORD1002）10 字段非空且键名正确、部分 null 订单（ORD1001）不被填充默认值、白名单外键被丢弃、`found:false` 时 `details` 为 undefined ~30min

### 集成与测试

- [x] T-006: 单元测试覆盖四个分支（正常/重排/降级/空召回）+ `retrievedCount >= returnedCount` 断言 + chat 与 stream 计数一致性断言 ~30min `[CHANGED v2: 测试位置针对 route 层两处组装点，不针对 orchestration]`

## 依赖关系

- T-002 依赖 T-001
- T-004 依赖 T-003
- T-005 依赖 T-001、T-004
- T-006 依赖 T-005
- T-007 依赖 T-001（同一 contract.ts）
- T-008 依赖 T-007
- 本 feature 无跨 feature 依赖；`2.T-001`、`6.T-*` 依赖计数产出；`7.T-002` 依赖 T-007 的 `order.details`

## 风险点

- **配置常量误用**：`RECALL_TOP_N`/`FINAL_TOP_K` 看起来"就是那个数"，极易被写进计数。
  应对：T-004 code review 必须逐分支核对取值来源；T-006 用「知识库条数 < RECALL_TOP_N」的数据构造断言。
- **stream 路径漏传**：`routes/customer-service.ts` 有**两处**独立组装点（`:58`/`:105`），
  只改其中一处会导致 chat 与 stream 字段漂移。
  应对：T-005 让计数经 `buildContractExtras()` 带出，两处自动一致；T-006 显式断言（AC-005）。
- **`[v2]` 误重构 orchestration**：v1 specs 错误地把组装位置写成 `orchestration.ts`，
  执行者可能"照 specs 办事"去重构编排层，造成无谓且有害的改动。
  应对：F-008 明令禁止；T-005 标注 v1 描述已作废；AC-008 断言 `git diff` 中 orchestration.ts 无改动。
- **`[v2]` snake_case 未转换导致静默全 null**：源数据为 `order_id`/`status_text` 等，
  若按 camelCase 直接取值，10 个字段会**全部为 null 而测试仍通过**（字段本就可空）——
  最隐蔽的失败模式。
  应对：T-008 用真实完整订单 ORD1002 断言字段值**非空**，而非只断言字段存在。
- **`[v2]` 白名单退化为透传**：图省事直接 `details = order`，丧失安全边界。
  应对：T-007 强制显式 FIELD_MAP 映射；T-008 断言白名单外的键被丢弃。
- **契约双写不同步**：contract.ts 改了忘改 types.ts。
  应对：T-002 作为独立任务强制执行；`8.T-*` 门禁再兜一层。
