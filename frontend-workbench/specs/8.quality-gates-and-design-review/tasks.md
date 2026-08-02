# quality-gates-and-design-review — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |
| 2026-07-31 | v2 | T-001 扫描端口 5→6；T-005 新增订单 details 空值测试 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/8.quality-gates-and-design-review/`

## 任务列表

### 功能 1: 门禁脚本

- [x] T-001: `scripts/gate-no-direct.sh`（**6 端口** `8000|8001|8002|6333|8787|11434` + `getAgent(` 扫描，排除 client.ts 自身注释）与 `scripts/gate-no-hardcoded-count.sh`（召回/重排文案 20/5 扫描） ~30min `[CHANGED v2: 端口 5→6，新增 Ollama Embedding 11434]`
- [x] T-002: `scripts/gate-assets.sh` + `docs/assets/checksums.txt`（基线取自需求 §1.5.1） ~15min
- [x] T-003: `package.json` 编排 `gates` 聚合脚本（typecheck→build→test→三个 gate），刻意不含 smoke 与设计复核 ~15min

### 功能 2: 测试补全

- [x] T-004: 组件测试补全：四类 route、5 类流式事件、degraded/error/空状态/取消 ~30min（审计确认 Feature 4-7 已全覆盖，无缺口）
- [x] T-005: 组件测试补全：订单 6 种状态 + `order.details` 空值处理（null 字段不被填充默认值、`canCancel: null` 不当作 false）+ 顶栏四态 + `status()` 5 项（聚合三分支/初始 unknown/超时失败/脱敏） ~30min `[CHANGED v2: 新增 order.details 空值断言]`（审计确认 Feature 2/4/7 已全覆盖，无缺口）
- [x] T-006: 契约测试：chat 与 stream 计数一致（Feature 1 已覆盖）、contract.ts 与 types.ts 镜像一致（新增 `contract-mirror.test.ts`，含字段签名+可选标记+类型+引用别名解析）；smoke 已覆盖 chat/stream/status 三端点（Feature 1/2 已完成） ~30min

### 功能 3: 设计还原验收

- [x] T-007: 通过 `gate-assets.sh` 完成 §1.5.2 资产三项验收（落盘+大小+SHA-256 全部 OK）；启动本地 dev server 用浏览器工具在 1280×1024 / 1920×1080 / 375×812（移动断点）截图，与 `workbench-screenshot.jpg` 并排比对，逐项核对 §9.1；三处已知偏差（顶栏 3 状态点、右栏 6 执行节点、第 4 个 chip）确认为静态截图缺失、非实现缺陷；颜色 token 逐一比对（19/19 十六进制完全一致）、图标（13/13 基线齐全 + 2 个响应式新增）、断点/抽屉交互real浏览器验证通过 ~30min

## 依赖关系

- T-001、T-002、T-003 依赖 feature 1-7 全部完成
- T-004、T-005 依赖 `7.T-*`（全部场景实现完毕）
- T-005 依赖 `2.T-008`、`4.T-004`
- T-006 依赖 `1.T-006`、`2.T-007`
- T-007 依赖 T-004~T-006 全绿

## 风险点

- **门禁假阳性导致被放宽**：`client.ts` 注释提及端口触发误报，进而有人放宽正则甚至删掉门禁。
  应对：T-001 用 `--exclude='client.ts'` 精确排除，而非削弱正则。
- **门禁 6 被变量名绕过**：`const TOP_5 = 5` 逃过文案正则。
  应对：T-004/T-005 用非 20/5 的构造值（如 17/3）断言渲染结果，行为层兜底。
- **mock fetch 掩盖直连**：组件测试 mock 全局 fetch，导致绕过 client.ts 的实现也能测过。
  应对：T-004 强制经 Context 注入 mock client。
- **CI 因环境缺失假失败**：把 smoke 塞进 `gates`，无 Mastra 环境时 CI 永久红。
  应对：T-003 明确 `gates` 不含 smoke。
- **颜色验收放水**：目测"差不多"就通过。
  应对：T-007 要求取色器逐一比对，十六进制完全相等。
- **把已知截图偏差当缺陷返工**：浪费时间去"修"实现中本就正确的三处。
  应对：T-007 事先标注 §1.6 三处为已知偏差。
