# workbench-app-scaffold — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始任务 |
| 2026-07-31 | v1.1 | 实现完成。T-001 的 `test` 脚本落地为 `vitest run`，为使其真正可运行补了 `vitest.config.ts`（jsdom 环境）与 `src/app/App.test.tsx` 冒烟测试（5 项：挂载不抛错、根容器 h-screen+overflow-hidden、三栏断点显隐类、useClient() 脱离 Provider 报错、mock client 注入生效）——这两个文件不在原 6 个 task 的显式清单里，但属于让 T-001 的验收标准（`test` 脚本可用）成立所必需的最小追加。另外补了 `.gitignore` 的 `dist/`/`.vite/` 条目（此前缺失，`vite build` 产物会被误提交）。 |

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- specs 路径: `frontend-workbench/specs/3.workbench-app-scaffold/`

## 任务列表

### 功能 1: 构建配置

- [x] T-001: `package.json` 追加 react/react-dom/vite/@vitejs/plugin-react/tailwindcss/vitest/@testing-library/react 依赖与 `dev`/`build`/`test` 脚本，保留现有 `typecheck`/`smoke` ~30min
- [x] T-002: 新增 `vite.config.ts`、`postcss.config.js`、`index.html`（含三组字体 link），并扩展 `tsconfig.json` 的 jsx 与 DOM lib ~30min

### 功能 2: 设计令牌

- [x] T-003: 新增 `tailwind.config.ts`，逐字移植 screen 内联 `theme.extend` 的 19 个 colors 与 borderRadius 全 0 ~30min
- [x] T-004: 移植 `fontFamily`/`fontSize`（含 lineHeight/fontWeight/letterSpacing 元组）/`spacing` 三组令牌 ~15min
- [x] T-005: 新增 `src/app/styles.css`：Tailwind 三指令 + 全局 0 圆角 + `.no-scrollbar` 工具类 ~15min

### 功能 3: 应用骨架

- [x] T-006: 新增 `main.tsx`、`App.tsx`（§4.0 根骨架 + 三栏空壳占位）与 `client-context.tsx`（client.ts 单例注入 + 支持 mock 替换） ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003 → T-004 → T-005 顺序执行（同一套令牌配置）
- T-006 依赖 T-002、T-005
- 本 feature 无跨 feature 依赖；`4.T-*`、`5.T-*`、`6.T-*` 均依赖本 feature 完成

## 风险点

- **令牌被"优化"**：移植时把看似冗余的 `spacing.md=6rem` 等模板遗留值删掉或归并，导致后续偏差。
  应对：T-003/T-004 要求逐字照抄，code review 对照 `docs/assets/workbench-stitch.html` 核验。
- **取错调色板**：误用项目级 designTheme 的灰阶配色（`#FFFFFF`/`#000000`/`#808080`）。
  应对：design.md 已明确裁定；review 时对照需求 §3.1 的 19 个值逐一核对。
- **新建第二套客户端**：图省事在 `src/app/` 下另写一个 fetch 封装。
  应对：T-006 强制经 Context 注入 `client.ts`；`8.T-*` 门禁扫描 `fetch(`/`new MastraClient(`。
- **Tailwind 未扫描到 app 目录**：`content` 配置漏 `src/app/**`，样式全部丢失。
  应对：T-003 配置后立即用 T-006 的空壳验证渲染效果。
