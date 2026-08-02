# scenarios-and-degradation — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |
| 2026-07-31 | v2 | T-002 改为读取 `order.details` 白名单，不再解析泛型 toolCalls |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/7.scenarios-and-degradation/`

## 任务列表

### 功能 1: 场景分发与订单卡

- [x] T-001: 新建 `scenarios/render-slots.ts`：按结构化字段决定安全卡/订单卡/引用角标三个插槽；订单卡采用「有 queryOrderTool 调用 + 有 order」双条件 ~15min
- [x] T-002: 实现订单卡片 6 种状态（成功/部分缺失/不存在/超时/服务错误/网络错误），仅 timeout 与 network_error 带重试；详情区**只读 `order.details`** 的 10 个白名单字段，逐字段空值隐藏（`canCancel` 为 null 不得当作 false），`details` 为 undefined 时不渲染详情区 ~30min `[CHANGED v2: 改读类型化 order.details；禁止解析泛型 toolCalls[].result]`

### 功能 2: 场景差异与引用角标

- [x] T-003: 安全卡组件（safety 三件套 + `warning` 图标，话术取自服务端正文）+ 引用角标（`description`/`security` 图标按 route 与 rank 选择） ~30min
- [x] T-004: 四类 route 差异化验证：repair 空 sources 不渲染角标、general 最小集合、safety 必现安全卡、order 追问场景不渲染卡片 ~30min

### 功能 3: 异常态

- [x] T-005: error 卡（追加而非替换正文，含 message/traceId/重试）+ 右栏「已中断 · 生成失败」节点 + degraded 不阻断正文 + 取消无提示，三种收尾 UI 明确区分 ~30min

### 功能 4: 响应式降级

- [x] T-006: 四个断点行为（md 768 / min-[1100px] / xl 1280）栏位显隐、内边距、对话头部方向、正文字号 ~30min
- [x] T-007: `<Drawer />` 组件（0 圆角、200ms ease-out、遮罩 rgba(36,49,66,0.4)、Esc 关闭与焦点管理）+ 右抽屉复用 feature 6 内容组件 + 左抽屉会话列表；验证四断点无横向滚动 ~30min

## 依赖关系

- T-001 → T-002 顺序执行
- T-002 依赖 `1.T-007`（`order.details` 白名单可用）`[NEW v2]`
- T-003、T-004 依赖 `5.T-006`（AssistantMessage 插槽）
- T-005 依赖 `5.T-003`（收尾状态机）、`6.T-007`
- T-007 依赖 `6.T-006`（右栏内容组件）、`4.T-006`（左栏）
- 下游：`8.T-*` 验收本 feature 全部场景

## 风险点

- **`[v2]` 绕过白名单解析泛型结果**：图省事从 `toolCalls[].result` 直接取字段。
  应对：T-002 只允许读 `order.details`；AC-002d 源码审计订单卡组件无 `toolCalls` 读取。
- **`[v2]` 空值被填默认值**：`carrier` 为 null 时显示「暂无」「顺丰」等编造内容。
  应对：T-002 强制隐藏行或显示「—」；AC-002b 用 ORD1001（多字段为 null）断言无编造内容。
- **`[v2]` `canCancel: null` 被当作 false**："不确定能否取消"被渲染成"不可取消"，
  会导致坐席错误拒绝客户的合法取消请求。
  应对：T-002 明确 null 时隐藏该项，不做布尔回落。
- **订单卡误渲染**：只判 `route === "order"` 导致追问场景出现空卡。
  应对：T-001 双条件判定；AC-002 专项断言。
- **error 清空正文**：用错误卡替换掉已生成内容。
  应对：T-005 明确为追加；AC-007 断言正文保留。
- **取消被当成错误**：`AbortError` 走进错误分支弹提示。
  应对：T-005 三种收尾分别断言；AC-008。
- **抽屉内容复制粘贴**：复制右栏代码导致两处逐渐不一致。
  应对：T-007 强制复用 feature 6 组件。
- **断点改写**：把 `min-[1100px]` 当成 `lg`(1024) 或 `xl`。
  应对：T-006 对照 `docs/assets/workbench-stitch.html`；AC-009 四断点实测。
- **前端硬编码安全话术**：安全卡里写死"请勿拆机"等建议。
  应对：T-003 话术只取服务端正文；AC-003 断言。
