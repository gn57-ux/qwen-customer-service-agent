# quality-gates-and-design-review — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **测试层**、**CI/脚本层**、**验收流程**
- 不涉及: 业务实现（本 feature 只做验证）

## 功能模块设计

### 模块 1: 门禁编排

`web-client/package.json` 脚本：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "vite build",
    "test": "vitest run",
    "smoke": "node --import tsx scripts/smoke.ts",
    "gate:no-direct": "bash scripts/gate-no-direct.sh",
    "gate:no-hardcoded-count": "bash scripts/gate-no-hardcoded-count.sh",
    "gate:assets": "bash scripts/gate-assets.sh",
    "gates": "npm run typecheck && npm run build && npm run test && npm run gate:no-direct && npm run gate:no-hardcoded-count && npm run gate:assets"
  }
}
```

`gates` **刻意不含** `smoke` 与设计复核：前者需 Mastra 与下游真实运行，
后者需人工/MCP 介入 —— 混进来会让 CI 因环境缺失而假失败。二者作为独立门禁手动执行。

### 模块 2: 扫描脚本

**`scripts/gate-no-direct.sh`**（门禁 5）：扫描 5 个端口与 `getAgent(`。

**注意排除项**：扫描范围限定 `web-client/src`，且需排除 `src/client.ts` 自身注释
（其中合法地提到了 `:8000`/`:8002` 作为"禁止直连"的说明文字）。

```bash
grep -rnE ':(8000|8001|8002|6333|8787|11434)|getAgent\(' web-client/src \
  --include='*.ts' --include='*.tsx' \
  --exclude='client.ts' \
  && { echo '❌ 检测到禁止的直连或绕过用法'; exit 1; } || echo '✅ 无直连'
```

> 若 `client.ts` 本身被修改引入直连，由 code review 与 `2.T-007` 的实现约束兜底；
> 脚本层面排除它是为了避免其顶部说明性注释造成永久假阳性。

**`scripts/gate-no-hardcoded-count.sh`**（门禁 6）：

```bash
grep -rnE '(已召回|重排完成|Top)\s*[·:]?\s*(20|5)\b' web-client/src \
  --include='*.ts' --include='*.tsx' \
  && { echo '❌ 检测到召回/重排计数硬编码'; exit 1; } || echo '✅ 无硬编码计数'
```

**已知盲区**：变量名绕过（`const TOP_5 = 5`）无法被文案正则捕获。
**补偿手段**：`6.T-004` 单测用非 20/5 的构造值（`retrievedCount: 17`、`returnedCount: 3`）
断言渲染文案，从行为层面证明数值确实来自字段而非常量。

**`scripts/gate-assets.sh`**（门禁 7）：

```bash
cd frontend-workbench/docs/assets && shasum -a 256 -c checksums.txt
```

`checksums.txt` 内容来自需求 §1.5.1 基线。

### 模块 3: 测试分层

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯函数单测 | Vitest | `deriveEvidence()`（feature 6）、订单状态映射、聚合规则 |
| 组件测试 | Vitest + Testing Library | 四类 route、5 类事件、异常态、订单 6 态、顶栏四态 |
| 契约测试 | Vitest | chat 与 stream 两路径计数一致、contract/types 镜像一致 |
| 冒烟 | tsx 脚本 | 三端点真实往返 |

**mock 策略**：组件测试通过 feature 3 的 client Context 注入 mock client
（`chat`/`streamChat`/`status` 均可控），⛔ 不 mock 全局 `fetch` —— 那会掩盖
「组件绕过 client.ts 直接 fetch」这一正是要防的问题。

### 模块 4: 设计复核流程

1. 通过 Stitch MCP 重新拉取 screen `af1a6fe2fa77400fbdf68dcd5d24e53f`，
   按 §1.5.2 三项验收（落盘 + 大小 + SHA-256）确认资产未变
2. 实现侧在 **1280×1024** 与 **2560×2048** 两档截图
3. 与 `docs/assets/workbench-screenshot.jpg` 并排比对，逐项核对 §9.1 九项
4. 三处已知截图偏差（§1.6）标注为「已知偏差」，不判为不一致

**颜色验收**：取色器逐一比对 19 个 token，要求**十六进制完全相等**，不接受近似色。

## 接口契约

无新增接口。本 feature 产出：3 个门禁脚本 + `checksums.txt` + `gates` 聚合脚本 + 测试用例。

## 数据模型

无。

## 安全考虑

- 门禁 5 是**防止前端直连下游**的最后一道自动化防线，不得因误报而放宽正则
- `status()` 脱敏断言（`2.T-008`）在本 feature 的组件测试中再验一次
- smoke 脚本不得把真实凭据或内部地址写入仓库，baseUrl 从环境变量读取
- CI 日志需避免打印完整响应体（可能含内部信息）

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| `gates` 是否含 smoke | **不含** | smoke 需真实服务，混入会让 CI 因环境缺失假失败 |
| `gates` 是否含设计复核 | **不含** | 需人工/MCP 介入，无法无交互执行 |
| 扫描是否排除 `client.ts` | **排除** | 其注释合法提及端口，否则永久假阳性 |
| mock 层级 | **注入 mock client，不 mock 全局 fetch** | mock fetch 会掩盖"组件绕过 client.ts"的问题 |
| 计数硬编码的盲区 | **正则 + 非 20/5 构造值单测双保险** | 单靠正则无法捕获变量名绕过 |
| 颜色验收标准 | **十六进制完全相等** | 近似色会随迭代漂移，失去基准意义 |
| 截图偏差处理 | **列为已知偏差，不判不一致** | 偏差源于 Stitch 截图渲染，非实现缺陷 |
