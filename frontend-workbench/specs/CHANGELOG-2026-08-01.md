# 变更日志 — 2026-08-01

## Feature 9: stitch-v2-visual-restoration

新版 Stitch 设计稿视觉还原，只改前端展示层（`web-client/src/**`、
`tailwind.config.ts`、`styles.css`）与前端设计验收文档，业务逻辑、数据
契约、`mastra-agent/**`、`services/**` 等一律未改动。

### 新增

- Stitch v2 设计资产基线：`frontend-workbench/docs/assets/stitch-v2/`
  （`workbench-stitch-v2.html`/`workbench-stitch-v2-screenshot.jpg` +
  SHA-256 校验和 + `DESIGN-BASELINE-v2.md` 逐项记录字体/图标/颜色/
  阴影/圆角/边框/间距/三栏尺寸）。
- `useIconFontReady` hook：直接遍历 `document.fonts` 查找 `family`
  精确匹配且 `status==="loaded"` 的 `FontFace`，解决 Material Symbols
  图标偶发显示为字面文字（`arrow_upward`/`delete` 等）的问题——不用
  `FontFaceSet.check()`，其语义在三轮 Codex Review 中被证明不可靠。
- 全局背景/主容器悬浮卡片化：装饰性光晕 + 留白 + 圆角 + 组合阴影。
- 圆角系统从"全局 0 圆角"改为分层圆角（`DEFAULT:12px lg:16px xl:24px
  full:9999px` + 大量任意值）——**推翻了此前的强约束，已征得用户
  明确同意**。

### 关键文件

- `web-client/src/app/hooks/use-icon-font-ready.ts` — 图标字体加载确认
- `web-client/src/app/App.tsx` — 主容器悬浮卡片化、光晕背景
- `web-client/tailwind.config.ts` — 圆角/阴影/`body-md` 行高 token
- `web-client/src/app/styles.css` — 移除全局 0 圆角规则、新增组合阴影/
  渐变背景/图标防闪烁 class
- `web-client/src/app/components/{Header,LeftSidebar,UserBubble,
  SafetyCard,RightPanel,SourceList,StepTimeline,Composer}.tsx` —
  逐组件视觉还原

### 架构决策

- Tailwind 的 `box-shadow`/`margin` 类工具类不会"叠加"，两个 utility
  同时写在 class 里时效果是覆盖不是合并（哪个生效取决于 Tailwind 生成
  样式表的内部顺序，不是 JSX 书写顺序）——`shadow-main shadow-inner-top`
  与 `w-full mx-auto m-4` 两处真实 bug 均由此而来，已分别改用手写合并
  的自定义 class 与 `calc()` 显式宽度表达式修复。
- 条件样式（`active ? A : B`）如果把"只该属于一态"的样式放进不带条件
  的公共前缀，会静默应用到另一态——本次 `rounded-r-md` 的教训。
- 视觉还原类任务除了"新稿有什么、代码里加什么"的正向核对，收尾阶段
  还应做一次反向核对：列出全部具名 design token，检查引用数量是否符合
  预期（本次由此发现 `input-border` 与新稿实际值有一位十六进制的漂移）。
- 截图工具限制（`mcp__Claude_Browser__*` 无法把截图保存为磁盘文件）
  下的验收替代方案：逐任务记录 `getComputedStyle`/
  `getBoundingClientRect`/`scrollWidth` 的具体实测数值，而不是笼统声明
  "因工具限制未截图"。

## Feature 9 定向修正：移除预设快捷问题 chip

首轮验收遗漏：`Composer.tsx` 仍保留四条预设维修/订单示例快捷问题 chip
（此前设计任务 7 里记录为"新稿未渲染该场景，保持现状"的空白项）。用户
明确裁定最终决定为**不显示预设快捷问题**，已整体移除该常量、渲染容器
与 `map` 逻辑；输入框借助父级 `flex flex-col gap-3` 自动上移，无需
手动调整 margin。`Composer.test.tsx` 同步替换为"确认四段文案不作为
按钮渲染"的断言。已扫描确认 `web-client/src` 生产代码不再含这四段文案，
测试数据中的合理保留用法未被误删。
