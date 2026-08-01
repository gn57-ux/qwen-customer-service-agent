# Feature 9: Stitch v2 视觉还原 — 需求文档

## 背景

Stitch 项目 `10964917433981148706` 产出了新版视觉升级页面「智修客服 - 高级
视觉版工作台」（screen `c1e93f6766574641a7807fa65c00c256`，
`updateTime: 2026-08-01`），是当前唯一 screen，本轮以此为**唯一视觉权威**，
旧设计稿（`docs/assets/workbench-stitch.html`）仅作对比参考。完整设计基线
见 `frontend-workbench/docs/assets/stitch-v2/DESIGN-BASELINE-v2.md`。

## 范围

**只做视觉还原**：颜色、圆角、阴影、间距、字体/图标加载、响应式断点表现。
**不做**：不修改 `mastra-agent/**`、契约字段、Agent/RAG/Tools 逻辑、
`services/**`、`datasets/**`、`training/**`、`configs/**`、`knowledge/**`、
`models/**`。业务逻辑与数据契约必须逐字节保持不变——本 Feature 完成后，
`web-client` 对 `useClient()` 的调用方式、`ChatResponseBody` 消费方式、
场景判定逻辑（`scenarios/*.ts`）均不应有任何改动，只允许改 CSS/className/
纯展示型 JSX 结构与 `tailwind.config.ts`/`styles.css`。

## 已裁定的设计冲突

新稿定义了非零圆角系统（`DEFAULT:12px lg:16px xl:24px full:9999px`），与
现有「全局 0 圆角」强约束冲突。**已征得用户明确决定：采用新稿圆角方案，
推翻 0 圆角决策**（不是本 Feature 内部可自行决定的事项，已通过
`AskUserQuestion` 征得同意，记录在案）。据此：
- `web-client/src/app/styles.css` 的全局 `* { border-radius: 0 !important }`
  规则需要移除或改为按新 token 生效；
- `.claude/rules/frontend-conventions.md`、`.claude/CLAUDE.md` 中"全局 0
  圆角设计系统"的表述需要同步更新为新方案；
- `web-client/scripts/gate-assets.sh` 等门禁如隐含"0 圆角"假设需要检查
  是否需要调整（初步判断该门禁校验的是设计资产文件 SHA-256，不直接校验
  运行时圆角值，预计不受影响，但需在任务 8 中显式核实）。

## 验收标准（贯穿全部子任务）

1. **"浏览器最终像素"是唯一验收标准**——组件存在、design token 数值一致、
   单元测试通过，均不能替代真实浏览器截图/computed style 核验。单元测试
   通过但截图不合格 = 任务仍然失败。
2. **Material Symbols 显示为名称文字（如 `arrow_upward`/`delete` 字面文本）
   必须判 FAIL**，即使只在页面刚加载的一瞬间出现也算 FAIL（新增自动化
   "可见文本扫描测试"防止回归，见任务 1）。
3. **页面大面积空白、比例明显失衡、输入区遮挡消息、任何视口宽度下出现
   横向滚动/溢出，必须判 FAIL**。
4. 四档视口（1920/1280/1024/375）都必须实测并尽量保存截图文件；如工具
   限制导致无法保存到磁盘，需在报告中如实说明（不得假称已保存）。
5. 保留现有 161 个 `web-client` 测试与 3 个门禁全部通过；新增图标字体
   加载测试与可见文本扫描测试。
6. 业务契约字段、`useClient()` 调用边界、场景判定纯函数签名不得改动
   （现有 `contract-mirror.test.ts`、`gate-no-direct.sh`、
   `gate-no-hardcoded-count.sh` 必须继续通过，且不因为本 Feature 修改
   而需要调整判定逻辑本身，只能是外观类文件变化触发的重新运行）。

## 任务拆分（对应 design.md 的实施顺序）

1. 字体与图标加载修复
2. 全局背景与主容器质感
3. 顶栏视觉还原
4. 左栏视觉还原
5. 中间消息与安全卡片还原
6. 右栏证据面板还原
7. 输入区还原
8. 响应式与截图回归

每个任务在 `design.md`/`tasks.md` 中都必须包含明确的像素/颜色/阴影/圆角
数值与截图验收要求，不能只写"参照 Stitch 还原"这种模糊描述。
