---
description: web-client 前端开发约定（组件模式、测试模式、设计系统、契约边界）
globs: web-client/src/**/*.ts,web-client/src/**/*.tsx
---

# web-client 前端约定

## 数据访问边界

- 组件层只能通过 `useClient()`（`src/app/client-context.tsx`）访问后端，
  ⛔ 禁止组件内出现 `fetch(`、`axios`、`new MastraClient(`、`getAgent(`。
- ⛔ 禁止直连下游端口：8000（FastAPI）、8001（Mock 后端）、8002（llama-server）、
  6333（Qdrant）、8787（Reranker）、11434（Ollama Embedding）。前端只允许
  访问 Mastra 服务（默认 `:4111`）。由 `scripts/gate-no-direct.sh` 强制扫描
  （排除 `client.ts` 自身注释，避免其中的说明性文字触发假阳性）。

## 契约与结构化数据

- `src/types.ts` 是 `mastra-agent/src/mastra/contract.ts` 的手动类型镜像，
  改字段要同步改两处（`mastra-agent` 侧的 `contract-mirror.test.ts` 会校验）。
- 场景差异化渲染（安全卡/订单卡/引用角标）、右栏「处理依据」的一切展示内容
  必须能追溯到 `ChatResponseBody` 的具体字段，⛔ 禁止对 `reply` 正文做正则/
  关键词匹配来推断状态（`evidence/derive.ts`、`scenarios/*.ts` 的函数签名
  故意不接受正文字符串，从类型层面阻断这条路）。
- 订单详情只读 `order.details` 白名单（10 个字段，全部可空），⛔ 不解析泛型
  `toolCalls[].result`；字段为 `null`/`undefined` 时隐藏该行或显示"—"，
  ⛔ 不得填默认值；`canCancel: null` 表示"不确定"，不等于 `false`，不得回落。
- 召回/重排计数（`retrievedCount`/`returnedCount`）严禁硬编码 20/5——包括
  测试里的构造值也要避开这两个数字，否则会触发
  `scripts/gate-no-hardcoded-count.sh` 的文案正则误报。

## 设计系统

- **圆角系统（2026-08-01 起，Feature 9 变更）**：不再是全局 0 圆角——旧的
  `* { border-radius: 0 !important }` 已移除，`tailwind.config.ts` 的
  `borderRadius` 现为 `DEFAULT:12px lg:16px xl:24px full:9999px`（逐字
  迁移自新版 Stitch 设计稿，见下）。组件层**可以**使用 `rounded-*`，但
  必须按 `frontend-workbench/specs/9.stitch-v2-visual-restoration/
  design.md` 里逐组件列出的具体数值（含大量任意值如 `rounded-[10px]`/
  `rounded-[12px]`/不对称圆角），⛔ 不要凭直觉统一套用某一个圆角值。
  这一决策是经用户明确确认后推翻旧版"全局 0 圆角"约定的，改回 0 圆角
  前必须先跟用户确认，不能因为看到旧提交历史就擅自改回去。
- 颜色/字体/间距/断点令牌逐字迁移自 `frontend-workbench/docs/assets/
  stitch-v2/workbench-stitch-v2.html`（Stitch 新版设计稿，2026-08-01 起
  的唯一视觉权威；旧版 `workbench-stitch.html` 仅作历史对比），改动前
  先核对该文件，不要凭直觉改写数值（尤其断点：`min-[1100px]` 不是
  `lg`(1024)；圆角/阴影等新增 token 见 `docs/assets/stitch-v2/
  DESIGN-BASELINE-v2.md`）。
- 响应式抽屉（`components/Drawer.tsx`）必须复用桌面版的同一份内容组件
  （`EvidencePanelContent`/`SessionListContent`），不要复制一份——否则两处
  会随迭代逐渐不一致。

## 测试模式

- 组件测试通过 `<ClientProvider client={mockClient}>` 注入可控 mock，
  ⛔ 不 mock 全局 `fetch`（会掩盖"组件绕过 client.ts 直连"这一正是要防的
  问题）。
- 并发/竞态防护统一用"自增 token + 归属绑定 ref"模式（见
  `hooks/use-service-status.ts`、`hooks/use-chat-stream.ts`）：发起异步操作
  时取一个 token，回调里比对 token 是否仍是最新，不是就丢弃写入。
- 组件动画/生命周期状态（如 `Drawer` 的进退场）要在 render 阶段同步派生
  （比较 prop 与上一次渲染的 ref，不相等就同步 `setState`），不要放进
  `useEffect`——后者要等 commit 之后才跑，会比 prop 变化晚一整个渲染周期。
- 响应式组件如果同时持有非展示状态（焦点陷阱、订阅、定时器），配合 CSS
  断点隐藏的同时还要用 `matchMedia` 监听同一断点主动收口状态（如 `onClose()`），
  CSS 隐藏不会让 JS 状态自动同步。
