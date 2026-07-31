# workbench-app-scaffold — 需求规格

## 概述

在**现有 `web-client/` 内部**搭建 React + Vite + TypeScript + Tailwind 应用层，并把 Stitch screen 内联的设计令牌（19 色 / 字体 / 0 圆角 / 间距 / no-scrollbar）原样移植为项目配置，为后续 UI feature 提供还原基座。

## 项目信息

- 项目名: ai-kefu
- 架构类型: 多包单仓
- 需求来源: `docs/智修客服AI工作台-前端需求.md` §3、§11.1、§11.2、§1.4

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始需求 |

## 用户故事

- 作为开发者，我想要一套与设计稿同构的令牌配置，以便后续组件直接用类名还原而不必反复查色值。
- 作为维护者，我想让前端长在既有 web-client 里，以便对话调用天然复用 `client.ts`，不出现第二套客户端。

## 功能需求

1. [F-001] 在 `web-client/` **内部**新增 React+Vite+TS 应用层（`index.html`、`vite.config.ts`、`src/app/` 等），**禁止**新建第二个客户端包。
2. [F-002] `package.json` 增加 `dev` / `build` / `test` 脚本与 React、Vite、Tailwind、Vitest 等依赖，保留现有 `typecheck` / `smoke`。
3. [F-003] 移植 screen 内联 `tailwind.config` 的 `theme.extend`：19 个颜色 token、`fontFamily`、`fontSize`、`spacing`（§3.1/§3.2/§3.4）。
4. [F-004] 全局零圆角：`* { border-radius: 0px !important; }`，且 `borderRadius` 的 `DEFAULT`/`lg`/`xl`/`full` 均覆写为 `0px`。
5. [F-005] 实现 `.no-scrollbar` 工具类（`::-webkit-scrollbar{display:none}` + `-ms-overflow-style` + `scrollbar-width`）。
6. [F-006] 引入字体：`Inter` 400/500/600/700、`JetBrains Mono` 400/500、`Material Symbols Outlined`。
7. [F-007] 应用根节点结构符合 §4.0：`h-screen flex flex-col overflow-hidden`，页面整体不滚动。
8. [F-008] 建立 `client.ts` 单例注入点（Context 或模块级单例），后续所有 UI 只经此访问 Mastra。
9. [F-009] `typecheck` 与 `build` 必须通过。

## 非功能需求

- **性能**: 生产构建成功且无错误级告警；字体加载不阻塞首屏渲染（`display=swap`）。
- **安全**: 应用层不得出现任何被禁端口（8000/8001/8002/6333/8787/11434，共 6 个）字面量。
- **兼容性**: 桌面端优先；不实现暗色模式（设计稿 `class="light"`，无暗色稿）。
- **可维护性**: 令牌集中在 tailwind 配置，组件层不得散落硬编码色值。

## 验收标准

- [ ] [AC-001] `npm run typecheck` 0 error。
- [ ] [AC-002] `npm run build` 成功。
- [ ] [AC-003] `npm run dev` 可启动并渲染空外壳，页面 body 无滚动条。
- [ ] [AC-004] 19 个颜色 token 全部可用，取色与 §3.1 十六进制完全相等。
- [ ] [AC-005] 任意元素实测 `border-radius` 为 0px（含被写成 `rounded-full` 的元素）。
- [ ] [AC-006] `.no-scrollbar` 生效，滚动容器不显示滚动条。
- [ ] [AC-007] Inter 与 JetBrains Mono 均正确加载并可被 `font-*` 类命中。
- [ ] [AC-008] `web-client/` 下仍只有一个客户端实现，未出现重复的 `client.ts`。
- [ ] [AC-009] 全仓扫描应用层源码，无被禁端口字面量。

## 依赖

- 现有 `web-client/src/client.ts`、`types.ts`（复用，不改写）
- 新增: react、react-dom、vite、@vitejs/plugin-react、tailwindcss、vitest、@testing-library/react
- 设计源: `docs/assets/workbench-stitch.html`（令牌唯一权威）

## 开放问题

- 无（技术栈与令牌来源均已在评审中裁定）
