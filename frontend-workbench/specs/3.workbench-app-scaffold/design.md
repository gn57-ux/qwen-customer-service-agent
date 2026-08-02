# workbench-app-scaffold — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **前端应用层（新增）**、**构建配置**
- 不涉及: 服务端、数据库、Python 服务

## 功能模块设计

### 模块 1: 目录结构（在 web-client 内部扩展）

```
web-client/
├── package.json          # 追加 dev/build/test 脚本与依赖（保留 typecheck/smoke）
├── tsconfig.json         # 追加 jsx / DOM lib
├── index.html            # 新增：Vite 入口
├── vite.config.ts        # 新增
├── tailwind.config.ts    # 新增：移植 screen 内联 theme.extend
├── postcss.config.js     # 新增
├── scripts/smoke.ts      # 保留不动
└── src/
    ├── client.ts         # ⛔ 保留不动（唯一 Mastra 通道）
    ├── types.ts          # ⛔ 仅由 feature 1/2 扩展契约
    └── app/              # 新增：UI 应用层
        ├── main.tsx      # 入口挂载
        ├── App.tsx       # 根组件（§4.0 骨架）
        ├── styles.css    # Tailwind 指令 + 全局规则
        ├── client-context.tsx   # client.ts 单例注入
        └── components/   # 后续 feature 4-7 填充
```

**关键约束**：应用层放在 `src/app/`，与 `client.ts`/`types.ts` **平级而非覆盖**，
物理上保证「扩展而非新建客户端」。

### 模块 2: 设计令牌移植

**来源**: `docs/assets/workbench-stitch.html` 的内联 `tailwind.config`（**唯一权威**）
**⛔ 明确不采用**: 项目级 `designTheme` 的灰阶配色（`#FFFFFF`/`#000000`/`#808080`）——
取自该处的颜色值判定为缺陷（需求 §1.4 裁定）。

`tailwind.config.ts` 的 `theme.extend` 需逐字移植：

- `colors`: 19 个 token（`page-bg` … `input-border`），见需求 §3.1
- `borderRadius`: `DEFAULT`/`lg`/`xl`/`full` 全部 `"0px"`
- `fontFamily`: `h1`/`h2`/`body-md`/`label-sm`/`display-hero`/`display-hero-mobile` → Inter；`code` → JetBrains Mono
- `fontSize`: 含 lineHeight/fontWeight/letterSpacing 的元组形式（`h2`/`body-md`/`label-sm`/`code` 等）
- `spacing`: `base`/`gutter`/`margin-page`/`sm`/`md`/`lg`/`section-gap-*`/`max-width`

> 移植方式：**逐字段照抄**，不做"优化归并"。设计稿的 `spacing.md = 6rem` 之类看似奇怪的值
> 是模板遗留，照抄即可（本页面实际未用到），改写反而制造偏差。

### 模块 3: 全局样式

`src/app/styles.css`：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* 来自 screen HTML <style>，逐字保留 */
* { border-radius: 0px !important; }
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
```

**字体引入**：沿用 screen HTML 的 Google Fonts `<link>`（`display=swap`），
写在 `index.html` 的 `<head>`。

> 注意：`* { border-radius: 0 !important }` 会让 `rounded-full` 失效。
> 组件层应**直接写 0 圆角方块**，不要写 `rounded-full` 再靠全局覆写——
> 后者可读性差且依赖 `!important` 的隐式行为（需求 §3.3）。

### 模块 4: 根骨架

`App.tsx` 实现 §4.0：

```tsx
<div className="bg-page-bg font-body-md text-text-primary antialiased h-screen flex flex-col overflow-hidden">
  <Header />                                                        {/* feature 4 */}
  <div className="flex-1 mt-16 flex overflow-hidden w-full max-w-[1920px] mx-auto">
    <LeftSidebar /> <MainChat /> <RightPanel />                     {/* feature 4/5/6 */}
  </div>
</div>
```

本 feature 只出**空壳占位**，三栏内容由 feature 4/5/6 填充。

### 模块 5: client 注入

`client-context.tsx`：模块级创建 `createCustomerServiceClient({ baseUrl })` 单例，
经 React Context 下发；`baseUrl` 从 `import.meta.env.VITE_MASTRA_BASE_URL` 读取，默认 `http://127.0.0.1:4111`。

**测试可替换性**：Context 允许注入 mock client，供 feature 5-8 的组件测试使用。

⛔ 组件层禁止 `new MastraClient(` / `fetch(` / `axios`，只能 `useClient()`。

## 接口契约

本 feature 不新增对外接口，只消费 `client.ts` 既有导出：
`createCustomerServiceClient()` → `chat` / `streamChat` / `status`（`status` 由 feature 2 提供）。

## 数据模型

无。

## 安全考虑

- `baseUrl` 只允许指向 Mastra `:4111`；被禁端口不得出现在源码或 env 默认值中
- 不引入任何直连下游服务的代理配置（Vite `server.proxy` 不得配置到 8000/8002 等）
- 依赖引入需为社区主流包，避免供应链风险

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 应用层位置 | **`web-client/src/app/`** | 需求硬约束"扩展现有 web-client"；与 client.ts 平级保证复用 |
| 样式方案 | **Tailwind** | 与 Stitch 产物同构，令牌可逐字移植，还原成本最低 |
| 令牌来源 | **screen 内联 config** | 需求 §1.4 裁定；项目级 designTheme 灰阶明确不采用 |
| 令牌移植方式 | **逐字照抄** | "优化归并"会引入与设计稿的偏差 |
| 0 圆角实现 | 全局 `!important` + 组件不写 `rounded-*` | 保留设计稿行为，同时避免组件层依赖隐式覆写 |
| client 注入 | **Context 单例** | 便于组件测试注入 mock；避免各组件自建实例 |
| 暗色模式 | **不实现** | 设计稿 `class="light"`，无暗色稿 |
| 测试框架 | **Vitest + Testing Library** | 与 Vite 同构，配置成本低 |
