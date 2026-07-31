# evidence-panel — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/6.evidence-panel/`

## 任务列表

### 功能 1: 推导层（纯函数）

- [ ] T-001: 新建 `evidence/derive.ts`，定义 `EvidenceView` 与 `deriveEvidence(body)`；函数签名只接受 `ChatResponseBody`，不接受正文字符串 ~30min
- [ ] T-002: 实现执行链路推导（route/toolCalls/retrievedCount/returnedCount/reranked/safety 六类节点及条件渲染） ~30min
- [ ] T-003: 实现「高优」判定（`reranked===true` 且 `rerankScore` 最大）与左边框色规则，含 `reranked===false` 全 null 边界 ~15min
- [ ] T-004: 推导层单测：覆盖四类 route、reranked 真假、retrievedCount 为 0、degraded、空 sources ~30min

### 功能 2: 面板 UI

- [ ] T-005: 右栏容器（300/320px、`min-[1100px]` 断点、JetBrains Mono 内容区）+ `<EvidenceHeader />` + `<StepTimeline />`（竖线与 `-left-[21px]` 圆点） ~30min
- [ ] T-006: `<ModeCard />`（三类 chip + degraded chip 与原因）+ `<SourceList />`（高优/边框色/truncate）+ `<EvidenceFooter />`（traceId 与 `x.xs` 格式）+ 三处空状态 ~30min

### 集成与测试

- [ ] T-007: 流式衔接：`meta` 显 traceId、`tool-result` 实时追加节点、`done` 用 `deriveEvidence` 全量覆盖重建（稳定 key 防闪烁） ~30min

## 依赖关系

- T-002、T-003 依赖 T-001
- T-004 依赖 T-002、T-003
- T-005、T-006 依赖 `3.T-006`
- T-002 依赖 `1.T-001`（`retrievedCount`/`returnedCount` 字段可用）
- T-007 依赖 `5.T-002`（流式事件与 `body`）、T-006

## 风险点

- **⛔ 正则解析正文**：最高危风险 —— 图省事从 `reply` 里找"请勿拆机"判断安全策略。
  应对：T-001 的函数签名不接受字符串正文，从类型层面阻断；AC-012 源码审计；code review 重点。
- **计数硬编码**：直接写 20/5 让界面"看起来对"。
  应对：T-002 绑定字段；`8.T-*` 门禁扫描召回/重排文案附近的 20/5 字面量。
- **高优误判**：用文件名含"安全规范"来标高优。
  应对：T-003 只允许 `rerankScore` 最大值判定；T-004 含 `reranked===false` 边界断言。
- **done 覆盖闪烁**：整体卸载重建导致右栏闪一下。
  应对：T-007 使用稳定 key 复用 DOM。
- **degraded 越权改顶栏**：在右栏顺手把顶栏状态也改了。
  应对：T-006 只渲染 chip；顶栏状态由 `4.T-001` 独占，AC-008 断言顶栏未被直接改色。
- **断点写错**：把 `min-[1100px]` 写成 `lg`(1024)。
  应对：T-005 对照 `docs/assets/workbench-stitch.html` 核验；AC-001 实测。
