# 智修客服 AI 工作台 — 前端需求文档

> 本文档所有视觉细节（布局、组件、颜色、字体、间距、圆角、图标、交互）均通过 **Stitch MCP** 实际读取得到，
> 未经 MCP 验证的内容一律显式标注，不做臆测。
> 本阶段**只产出需求资料，不实现代码**。
>
> **文档状态**：2026-07-31 评审决策已合入（§12 全部裁定完毕，无待决项）。
>
> **变更记录**：
> - `2026-07-31 v2`（specs 变更同步）：禁连端口由 5 个扩为 **6 个**（新增 `11434` Ollama Embedding）；
>   §5.1 / §5.5 B-5 端口表与 §10 门禁脚本同步更新。
>   另经读码核实两处 specs 修正（不影响本文档结论，详见 `specs/1.contract-retrieval-counts/`）：
>   `ChatResponseBody` 组装点在 `routes/customer-service.ts` 而非 `orchestration.ts`；
>   订单详情改由契约层类型化白名单 `OrderStatus.details` 提供。

---

## 1. Stitch 项目信息与实际读取结果

### 1.1 MCP 连通性验证

已加载并成功调用的 Stitch MCP tools：

| Tool | 调用结果 |
|---|---|
| `mcp__stitch__get_project` | ✅ 成功，返回项目元数据 + designTheme + designMd |
| `mcp__stitch__list_screens` | ✅ 成功，返回 1 个可见 screen |
| `mcp__stitch__get_screen` | ✅ 成功（对 3 个 screen 实例分别验证） |
| `mcp__stitch__download_assets` | ⚠️ 返回 "Assets downloaded"，但目标目录**实际未落盘**（见 §1.5） |
| `mcp__stitch__list_design_systems` | 已加载（本次未依赖其输出） |

### 1.2 项目元数据（`get_project` 原始返回）

| 字段 | 值 |
|---|---|
| 资源名 | `projects/10964917433981148706` |
| 标题 | 智修客服 AI 工作台 |
| URL | https://stitch.withgoogle.com/projects/10964917433981148706 |
| projectType | `TEXT_TO_UI_PRO` |
| deviceType | `DESKTOP` |
| origin | `STITCH` |
| visibility | `PRIVATE` |
| 创建时间 | 2026-07-29T17:14:43Z |
| **最后更新** | **2026-07-31T16:08:50Z** |
| 用户角色 | OWNER |

### 1.3 设计稿版本 / screen 清单

`list_screens` 只返回 **1 个可见 screen**，与「页面数量固定为 1」的要求天然一致。

| screen ID | 标题 | 尺寸 | 状态 | 说明 |
|---|---|---|---|---|
| `af1a6fe2fa77400fbdf68dcd5d24e53f` | **智修客服 - 专业版工作台** | 2560×2048 | ✅ **可见 / 当前版本（实现基准）** | 唯一需要还原的页面 |
| `202106a790b64614aeeb348198a12c71` | 智修客服 - AI 售后工作台 | 2560×2048 | 🚫 hidden（历史草稿） | 已被上面的「专业版工作台」取代，**不实现** |
| `11926228590466550876` | design.md | 780×1768 | 🚫 hidden，mimeType=`text/markdown` | 是上传的设计系统 markdown，**不是移动端页面** |
| `assets/394ec45ef83847ecb046c5bc4af6fe3e` | — | 960×540 | 🚫 hidden，`DESIGN_SYSTEM_INSTANCE` | 设计系统实例 |

> **结论**：项目中**不存在**移动端设计稿。小屏行为只能依据当前 screen HTML 中真实存在的
> Tailwind 响应式断点类推导（见 §7），不得凭空新增移动端视觉稿。

HTML 源文件内 `<title>` 为 `智修客服 - AI Workbench`，`<html lang="zh-CN" class="light">`（仅 light 模式，**无暗色稿**）。

### 1.4 设计系统主题（`designTheme.designMd`）

项目级设计系统名为 **"The Barely-There UI"**（ultra-minimal AI-native interface, inspired by OpenAI & Perplexity）。

关键令牌：

- 字体：`Inter`（400/500/600/700）+ `JetBrains Mono`（400/500，用于 code/metadata/technical values）
- 基础圆角：**0px**
- 间距基单位：`0.5rem` (8px)；gutter `1.5rem`；max-width `1280px`
- 动效：ease-out 曲线，200–300ms；hover 200ms
- 卡片：0px 圆角 + 1px 边框 + `0 2px 12px rgba(0,0,0,0.06)` 阴影
- 输入框：label 在上，1px 边框，focus ring 2px offset 2px

> ⚠️ **配色权威裁定（已决策，不再讨论）**
>
> - ✅ **唯一权威**：screen「智修客服 - 专业版工作台」(`af1a6fe2fa77400fbdf68dcd5d24e53f`)
>   内联 `tailwind.config` 的 `theme.extend.colors`（即 §3.1 的 19 个 token）。
> - 🚫 **明确不采用**：项目级 `designTheme` / `namedColors` 的**纯灰阶**配置
>   （primary `#FFFFFF` / secondary `#000000` / tertiary `#808080` / surface `#BDBDBD` 等），
>   以及 `designMd` 中「Branco Puro / Preto Absoluto / Cinza…」一节描述的灰阶色板。
>
> 该灰阶配置属于模板级默认值，**未**应用于本页面。实现、Code Review 与设计验收
> 一律以 §3.1 为准；任何取自项目级 designTheme 的颜色值均判定为**缺陷**。
>
> 说明：`designTheme` 中**非颜色**的部分（Inter / JetBrains Mono 字体族、0px 圆角、
> 0.5rem 间距基单位、200–300ms ease-out 动效）与 screen 内联配置一致，**继续采用**。

### 1.5 已保存的设计资产与下载验收规则

`download_assets` 未真正落盘（详见 §1.5.2），**保留** 直接从 MCP 返回的 `downloadUrl` 拉取原始文件的方案：

```
frontend-workbench/docs/assets/
├── workbench-screenshot.jpg   # 2560×2048 全分辨率设计稿截图（还原比对基准）
└── workbench-stitch.html      # Stitch 生成的 Tailwind HTML（布局/配色/图标权威来源）
```

两个文件均来自 screen `af1a6fe2fa77400fbdf68dcd5d24e53f`，仅保留实现所必需的参考资产。

#### 1.5.1 资产完整性基线（可核验）

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `workbench-screenshot.jpg` | `525481` | `05bfeae50c4d1d684aae553f0aa467ab09c7bf75c3e936713dd067b94e5370da` |
| `workbench-stitch.html` | `16628` | `e8182fbfcbce6d080801f708c47162c970a5fb478c6243f7ea8f90fd3389939b` |

核验命令：

```bash
cd frontend-workbench/docs/assets
shasum -a 256 -c <<'EOF'
05bfeae50c4d1d684aae553f0aa467ab09c7bf75c3e936713dd067b94e5370da  workbench-screenshot.jpg
e8182fbfcbce6d080801f708c47162c970a5fb478c6243f7ea8f90fd3389939b  workbench-stitch.html
EOF
```

#### 1.5.2 ⛔ 资产下载验收规则（强制，适用于本项目所有资产获取）

> **MCP 的 success 回执不能单独作为下载成功的依据。**
> 本次实测：`mcp__stitch__download_assets` 返回 `"Assets downloaded to <dir>"`，
> 但目标目录**根本未被创建**，全盘 `find` 无任何产物。

任何资产下载**必须同时**满足以下三项才可判定成功，缺一即视为失败：

1. **真实落盘** — 目标路径下文件确实存在（`test -f`），且路径与声明一致；
2. **文件大小** — 字节数 > 0 且与预期量级相符（不得是 0 字节或截断文件）；
3. **SHA-256** — 校验和与记录基线一致；首次下载时须记录基线（如 §1.5.1）。

配套要求：
- 下载后必须执行 `file` 类型探测，确认 MIME 与预期一致（防止拿到 HTML 错误页当作图片）；
- 校验失败时**必须**报错中止，不得静默继续或使用残缺资产；
- 更换设计稿版本时，须同步更新 §1.5.1 基线表，并在文档变更记录中说明。

### 1.6 截图与 HTML 的差异（实现前需注意）

对比 `workbench-screenshot.jpg` 与 `workbench-stitch.html`，发现渲染差异，**一律以 HTML 为准**：

| 差异点 | HTML | 截图 |
|---|---|---|
| 顶部三个服务状态指示 | 存在（本地模型/知识库/订单服务 + 绿点） | 未渲染出来 |
| 右栏「执行链路」6 个节点 | 存在（含彩色圆点与文案） | 只见竖线，节点未渲染 |
| 输入区快捷问题 chips | 4 个（含「冰箱不制冷」） | 只见 3 个 |

> ⛔ **裁定（已决策）**：这三处是 Stitch **截图渲染缺失**，**不是设计意图**。
>
> **设计意图以 HTML 为准，即：3 个服务状态点、6 个执行链路节点、4 个快捷 chip 全部存在且必须实现。**
>
> - 🚫 **截图缺失不得作为删减实现的理由** —— 不允许因"截图里看不到"而少做任何一项；
> - 🚫 不允许把状态点数量、执行节点数量、chip 数量改成与截图一致；
> - ✅ 验收截图比对时，这三处列为「已知截图偏差」，**实现有、截图无**属正常，不判为不一致；
> - ✅ 反之，若实现中缺少这三处任一项，一律判定为**还原缺陷**。

---

## 2. 页面范围（硬约束）

**页面数量固定为 1**：正式客服工作台（单页应用，无路由跳转）。

**明确不做**：
- ❌ 登录页 / 鉴权页
- ❌ 管理后台
- ❌ 多 Agent 切换页
- ❌ 数据大屏 / 统计报表页
- ❌ 设置页、用户中心

左栏「最近对话」是**同一页面内的会话切换**（仅前端状态），不构成第二个页面。

---

## 3. 设计令牌（100% 来自 screen HTML 内联 `tailwind.config`）

### 3.1 颜色（权威调色板）

| Token | 值 | 用途 |
|---|---|---|
| `page-bg` | `#F5F7FA` | 页面底色、右栏 chip 底 |
| `content-bg` | `#FCFDFE` | 顶栏 / 中间对话区 / 卡片底 |
| `sidebar-left-bg` | `#EEF2F6` | 左侧会话列表背景 |
| `sidebar-right-bg` | `#F7F9FB` | 右侧处理依据背景 |
| `text-primary` | `#243142` | 主文本 |
| `text-secondary` | `#667085` | 次级文本、AI 正文 |
| `text-muted` | `#8A94A3` | 弱化文本、标题小字 |
| `border-color` | `#DCE3EA` | 通用分隔线/边框 |
| `brand-primary` | `#4F6F8F` | 主品牌色（按钮、图标、激活态） |
| `brand-primary-hover` | `#405F7D` | 主按钮 hover |
| `brand-light-bg` | `#E8F0F7` | 用户气泡、激活项、hover 底 |
| `success-green` | `#3F7C5F` | 在线状态点、已完成节点 |
| `success-bg` | `#E9F4EE` | 成功底色 |
| `safety-text` | `#A14D45` | 安全策略文字 |
| `safety-bg` | `#FBEDEA` | 安全提示底 |
| `safety-border` | `#E7B8B2` | 安全提示边框 |
| `citation-bg` | `#E7F3F1` | 引用角标底 |
| `citation-text` | `#3F7C78` | 引用角标文字 |
| `input-border` | `#CBD5DF` | 输入框边框 |

> **无 error 专用色**：HTML 中未定义独立 error 色。`error` / `degraded` 状态统一复用
> `safety-*` 三件套（`#A14D45` / `#FBEDEA` / `#E7B8B2`），保持视觉体系一致。

### 3.2 字体

| 用途 | 字体 | 字号 / 行高 / 字重 |
|---|---|---|
| `h2` | Inter | 24px / 1.3 / 600 |
| `body-md` | Inter | 1rem / 1.6 / 400 |
| `label-sm` | Inter | 14px / 1.4 / 500，letter-spacing 0.01em |
| `code` | **JetBrains Mono** | 14px / 1.5 / 400 |
| `h1` | Inter | 2.5rem / 1.2 / 700（本页未使用） |
| `display-hero` | Inter | 64px / 1.1 / 700（本页未使用） |

引入方式（HTML 中真实存在）：
- `Inter:wght@400;500;600;700`
- `JetBrains Mono:wght@400;500`
- `Material Symbols Outlined:wght,FILL@100..700,0..1`

**JetBrains Mono 使用范围（严格）**：顶栏副标题「家电售后智能助手」、右栏整个内容区、右栏底部 traceId 与耗时。

### 3.3 圆角

```css
* { border-radius: 0px !important; }
```

**全站零圆角**，`DEFAULT` / `lg` / `xl` / `full` 均被覆写为 `0px`。
即使代码里出现 `rounded-full`（状态点、AI 头像），**实际渲染为正方形**。实现时直接写成 0 圆角方块，不要写 `rounded-full`。

### 3.4 间距与滚动条

- `base` 0.5rem / `gutter` 1.5rem / `margin-page` 1.5rem / `max-width` 1280px
- `sm` 3rem / `md` 6rem / `lg` 12rem / `section-gap-sm` 4rem / `section-gap-lg` 8rem
- 自定义滚动条工具类（HTML 中真实存在，必须实现）：

```css
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
```

应用于：左栏、消息流、右栏内容区、快捷问题横向条、textarea。**四个滚动容器全部隐藏滚动条**。

### 3.5 图标（Material Symbols Outlined，共 13 个）

| 图标 | 位置 | 尺寸 |
|---|---|---|
| `delete` | 顶栏「清空会话」 | 18px |
| `add` | 左栏「新建会话」 | 默认 |
| `smart_toy` | AI 消息头像 | 20px |
| `warning` | 安全提示卡标题 | 默认 |
| `description` | 知识类引用角标 | 14px |
| `security` | 安全类引用角标 | 14px |
| `content_copy` | 复制 | 16px |
| `refresh` | 重新生成 | 16px |
| `thumb_up` | 有帮助 | 16px |
| `thumb_down` | 没有帮助 | 16px |
| `memory` | 右栏「处理依据」标题 | 默认 |
| `gpp_maybe` | 右栏「安全策略介入」chip | 12px |
| `arrow_upward` | 发送按钮 | 20px |

### 3.6 动效

- 通用过渡：`transition-colors duration-200`
- 按钮按下：`active:opacity-70`
- 引用角标 hover：`hover:opacity-80`
- 输入框：`focus-within:border-brand-primary`

---

## 4. 精确布局规格

### 4.0 整体骨架

```
body: h-screen flex flex-col overflow-hidden, bg #F5F7FA
├── header  (fixed top-0, w-full, z-50, h-16)
└── div     (flex-1, mt-16, flex, overflow-hidden, max-w-[1920px], mx-auto)
    ├── aside 左  w-[220px]              (hidden < md)
    ├── main  中  flex-1, min-w-0, relative
    │         └── 输入区 absolute bottom-0
    └── aside 右  w-[300px] / xl:w-[320px] (hidden < 1100px)
```

**页面整体不滚动**（`overflow-hidden`），滚动只发生在三个内部容器里。
外层容器 `max-w-[1920px] mx-auto` — 超宽屏居中留白。

### 4.1 顶部服务状态（header）

- `fixed top-0 w-full z-50`，高 `h-16`(64px)，`bg #FCFDFE`，`border-b #DCE3EA`
- 水平内边距 `px-gutter`(24px)，`flex justify-between items-center`
- **左组**（`flex items-center gap-4`）：
  - `智修客服` — Inter 24px/1.3 **bold**，`#243142`
  - `家电售后智能助手` — **JetBrains Mono 14px**，`#8A94A3`，左侧 `border-l #DCE3EA` + `pl-4`，`hidden md:inline`
- **中组 — 服务状态**（`hidden md:flex gap-6`，label-sm 14px/500，`#8A94A3`）：
  三项，每项 `flex items-center gap-2` + 8×8px 状态点（0 圆角方块）：
  1. `本地模型: {状态}` ← `status().localModel`
  2. `知识库: {状态}` ← `status().knowledgeBase`
  3. `订单服务: {状态}` ← `status().orderService`

  设计稿三项均为「在线」+ 绿点，属**示例值**；实际文案与配色由 `ServiceState` 四态决定
  （`unknown` 未知 `#8A94A3` / `online` 在线 `#3F7C5F` / `degraded` 降级 `#A14D45` / `error` 异常 `#A14D45`）。
  数据**只能**来自 `GET /customer-service/status`，详见 §5.5 需求 B。
- **右组**：`清空会话` 按钮 — `delete` 图标 18px + 文字（`hidden md:inline`），色 `#667085`，`hover:text-brand-primary`，`active:opacity-70`

### 4.2 左侧会话列表（aside）

- 宽 **220px** 固定（`flex-shrink-0`），`bg #EEF2F6`，`border-r #DCE3EA`
- `p-4`(16px)，`flex-col justify-between`，`h-full overflow-y-auto no-scrollbar`
- `hidden md:flex` — **<768px 隐藏**

**上半部分：**
- 「新建会话」按钮：`w-full`，`bg #4F6F8F`，文字色 `#FCFDFE`，`py-3 px-4`，`gap-2`，
  `add` 图标 + 文字，label-sm 14px，`hover:bg #405F7D`，`mb-6`(24px)
- 「最近对话」标题：label-sm 14px，`#8A94A3`，`mb-4`，`tracking-wider`
- 列表 `ul.space-y-1`，每项 `px-3 py-2`，**14px**，`truncate`，`transition-colors duration-200`
  - **激活态**：`bg #E8F0F7` + `text #243142` + `border-l-2 #4F6F8F` + **bold**
  - 默认态：`text #667085`，`hover:bg #E8F0F7`

设计稿中的 5 条示例会话（实现时为动态数据）：
`冰箱到货后需要静置多久`（激活）/ `电视开机后黑屏` / `显示器无信号排查` / `查询订单 ORD1001` / `冰箱出现异常噪音`

**底部固定文案**：`本地运行 · 数据不会离开当前设备` — 12px，`#8A94A3`，`mt-8 pt-4 text-center`

### 4.3 中间客服对话（main）

`flex-1 flex flex-col h-full bg #FCFDFE relative min-w-0`

**(a) 对话区头部** — `px-8 py-6`，`border-b`，`flex-col md:flex-row justify-between items-start md:items-center gap-4`，`flex-shrink-0`
- 标题 `家电售后智能客服` — 22px（md 以上 24px），bold，`#243142`
- 副标题 `可咨询冰箱、彩电、显示器维修问题` — 15px（md 以上 16px），`#667085`，`mt-1`
- 右侧能力徽章（`flex gap-2`）：`QLoRA` `RAG` `Tools` — `bg #E8F0F7`，`text #4F6F8F`，`px-3 py-1`，13px

**(b) 消息流** — `flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-8 no-scrollbar pb-40`

> `pb-40`(160px) 是为绝对定位的输入区预留的避让空间，**不可省略**，否则最后一条消息会被输入区遮挡。

- **用户消息**：`flex justify-end`；气泡 `bg #E8F0F7`，`px-6 py-4`，`max-w-2xl`(672px)，
  文字 15px（md 16px），`#243142`
- **AI 消息**：`flex justify-start`；容器 `max-w-3xl`(768px) `space-y-4`
  1. **身份行**（`flex items-center gap-2 mb-2`）：`smart_toy` 20px `#4F6F8F` + `智修客服` label-sm **bold** `#243142`
  2. **正文**：`#667085`，行高 1.6（md 1.7）
  3. **安全提示卡**（条件渲染）：`border #E7B8B2`，`bg #FBEDEA`，`my-4 p-3`
     - 标题行：`warning` 图标 + bold 文字，色 `#A14D45`，`gap-2 mb-1`
     - 正文：14px，`#A14D45`，`leading-relaxed`
  4. **引用角标**（`flex flex-wrap gap-2 mt-4`）：`bg #E7F3F1`，`text #3F7C78`，12px，`px-3 py-1.5`，
     `flex items-center gap-1`，图标 14px（知识类 `description` / 安全类 `security`），
     `cursor-pointer hover:opacity-80`
     - 文案格式：`[序号] {title} · {section}`
  5. **操作行**（`flex gap-4 mt-2`，`#8A94A3`，12px，图标 16px）：
     `content_copy 复制` / `refresh 重新生成` / `thumb_up 有帮助` / `thumb_down 没有帮助`，`hover:text-text-primary`

### 4.4 底部输入区（absolute，位于 main 内）

`absolute bottom-0 left-0 w-full bg #FCFDFE border-t #DCE3EA p-4 md:px-8`
内层：`max-w-4xl`(896px) `mx-auto flex flex-col gap-3`

1. **快捷问题条**：`flex gap-2 mb-1 overflow-x-auto no-scrollbar`
   每个 chip：`border #DCE3EA`，`text #667085`，12px，`px-3 py-1`，`whitespace-nowrap`，`hover:bg #E8F0F7`
   设计稿 4 个：`冰箱不制冷` / `电视开机黑屏` / `显示器无信号` / `查询ORD1001`
2. **输入框容器**：`relative border #CBD5DF bg #FCFDFE focus-within:border-brand-primary transition-colors`
   - `textarea`：`rows=2`，`w-full bg-transparent border-none focus:ring-0 resize-none`，
     `p-4 pb-12`（`pb-12` 给发送按钮让位），`no-scrollbar`，
     placeholder `请输入维修问题或订单号，例如：查询订单ORD1001`（色 `#8A94A3`）
   - **发送按钮**：`absolute bottom-3 right-3`，`bg #4F6F8F`，`text #FCFDFE`，`p-2`，
     `arrow_upward` 20px，`hover:bg #405F7D`
3. **免责声明**：`text-center`，12px，`#8A94A3` —
   `AI建议仅供初步排查，不可替代专业维修诊断。`

### 4.5 右侧处理依据（aside）

- 宽 **300px**（`xl:` ≥1280px 时 **320px**），`bg #F7F9FB`，`border-l #DCE3EA`，`flex-shrink-0`
- `hidden min-[1100px]:flex` — **<1100px 隐藏**（注意断点是 1100，不是 lg/1024）

**(a) 头部** `p-6 border-b`
- `处理依据` — 18px，`#243142`，前置 `memory` 图标 `#4F6F8F`，`gap-2`
- `本次回答的可验证执行记录` — 12px，`#8A94A3`，`mt-1`

**(b) 内容区** `flex-1 overflow-y-auto p-6 space-y-8`，**JetBrains Mono 14px/1.5**，`no-scrollbar`

- **执行链路**
  - 小标题：12px，`uppercase tracking-wider`，`#8A94A3`，`mb-3`
  - `ul.space-y-4`，左侧 `border-l #DCE3EA ml-2 pl-4` 形成时间轴竖线
  - 每个节点 `relative`，圆点 `absolute -left-[21px] top-1 w-2 h-2`（8×8，0 圆角）
  - 设计稿 6 个节点及配色：
    | # | 文案 | 圆点色 | 文字 |
    |---|---|---|---|
    | 1 | 已识别 · 冰箱不制冷 | `#3F7C5F` | `#243142` |
    | 2 | 已调用 · 维修知识库 | `#3F7C5F` | `#243142` |
    | 3 | 已召回 · 20个候选片段 | `#4F6F8F` | `#243142` |
    | 4 | 重排完成 · Top 5 | `#4F6F8F` | `#243142` |
    | 5 | 已生成 · 安全维修建议 | `#4F6F8F` | `#243142` |
    | 6 | 已触发 · 拆机风险策略 | `#A14D45` | `#A14D45` **bold** |

    > 其中 `20个候选片段` 与 `Top 5` 是**设计稿示例值**，实现须分别绑定
    > `retrievedCount` 与 `returnedCount`（§5.5 需求 A），⛔ 禁止硬编码。
- **回答模式卡**：`bg #FCFDFE border #DCE3EA p-4`
  - 小标题 `回答模式` 12px `#8A94A3` `mb-3`（注意：**无** uppercase）
  - chips `flex flex-wrap gap-2` 12px：
    - `本地QLoRA` — `bg #F5F7FA border #DCE3EA px-2 py-1 text #243142`
    - `RAG知识增强` — 同上
    - `安全策略介入` — `bg #FBEDEA border #E7B8B2 text #A14D45` + `gpp_maybe` 12px 图标
- **引用来源**
  - 小标题 12px `uppercase tracking-wider` `#8A94A3` `mb-3`
  - `ul.space-y-2`，每项 `bg #FCFDFE border #DCE3EA p-3`，`border-l-2`（品牌色或安全色），
    `hover:bg #E8F0F7 cursor-pointer`
    - 标题：13px `#243142` `truncate`
    - 元信息：10px `#8A94A3` `opacity-60`（设计稿示例 `DOC-8821` / `DOC-9904 (高优)`）

**(c) 底部栏** `p-4 border-t bg #F7F9FB flex justify-between items-center`，**JetBrains Mono 12px** `#8A94A3`
- 左：`TRACE-A84F21` ｜ 右：`2.8s`

---

## 5. 数据契约与状态映射（关键约束）

### 5.1 唯一数据通道

```
React 组件
   └── web-client/src/client.ts  ← createCustomerServiceClient()
          └── @mastra/client-js MastraClient (apiPrefix: "")
                 └── Mastra :4111
                        ├── POST /customer-service/chat
                        ├── POST /customer-service/stream
                        └── GET  /customer-service/status   ← 新增（§5.5 需求 B）
```

**硬性禁止**（门禁扫描项，见 §10）：

| 端口 | 服务 | 说明 |
|---|---|---|
| `8000` | FastAPI | ❌ 禁止前端直连 |
| `8001` | Mock 后端 | ❌ 禁止前端直连 |
| `8002` | llama-server | ❌ 禁止前端直连 |
| `6333` | Qdrant | ❌ 禁止前端直连 |
| `8787` | Reranker | ❌ 禁止前端直连 |
| `11434` | Ollama Embedding | ❌ 禁止前端直连 |

同时禁止：
- ❌ 绕过 `client.ts` 自行 `fetch` / `axios` 调用 Mastra
- ❌ 使用 `client.getAgent(id).generate()`（会绕开服务端确定性路由与强制工具逻辑）
- ❌ 在 `status()` 内使用裸 `fetch` 绕开 `MastraClient.request()`

所有对话与状态请求**必须**经由 `web-client/src/client.ts` 导出的
`chat()` / `streamChat()` / `status()`。

### 5.2 结构化响应契约（`web-client/src/types.ts`，实读）

```ts
type RouteCategory = "safety" | "order" | "repair" | "general";

interface ChatResponseBody {
  reply: string;
  route: RouteCategory;
  toolCalls: ToolCallRecord[];          // { name, arguments, result }
  sources?: KnowledgeSourceItem[];      // { title, section, sourceFile,
                                        //   documentVersion, vectorScore, rerankScore }
  reranked?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  order?: OrderStatus;                  // { found, partial?, missingFields?,
                                        //   error?: not_found|timeout|server_error|network_error }
  traceId: string;
  latencyMs: number;
}
```

**本次评审新增（见 §5.5 需求 A / B）：**

```ts
interface ChatResponseBody {
  // ...上述现有字段
  retrievedCount: number;   // 新增：向量检索实际 hits.length
  returnedCount: number;    // 新增：最终返回 sources 数量
}

// 新增 status route 的响应契约
type ServiceState = "unknown" | "online" | "degraded" | "error";
interface ServiceStatusBody {
  localModel:    ServiceState;
  knowledgeBase: ServiceState;   // 聚合 Qdrant + Embedding + Reranker
  orderService:  ServiceState;
}
```

### 5.3 ⛔ 右侧依据区数据来源铁律

> **右栏「处理依据」的每一个字段，只能来自结构化 `ChatResponseBody`。
> 严禁对 `reply` 正文做正则匹配 / 关键词猜测 / 字符串解析来推导任何状态。**

具体映射：

| UI 元素 | **唯一**数据来源 | 规则 |
|---|---|---|
| 执行链路①「已识别 · X」 | `route` | `safety→安全咨询` / `order→订单查询` / `repair→维修排查` / `general→一般咨询` |
| 执行链路②「已调用 · X」 | `toolCalls[].name` | `searchKnowledgeBase→维修知识库`；`queryOrderTool→订单服务`；每个被调用的工具一个节点 |
| 执行链路③「已召回 · N 个候选片段」 | **`retrievedCount`** | 见 §5.5 需求 A；`0` 时不渲染该节点；⛔ 禁止硬编码 20 |
| 执行链路④「重排完成 · Top N」 | **`returnedCount`**（须 `reranked === true`） | 见 §5.5 需求 A；`reranked !== true` 时**不渲染**；⛔ 禁止硬编码 5 |
| 执行链路⑤「已生成」 | `done` 事件到达 | — |
| 执行链路⑥「已触发 · 安全策略」 | `route === "safety"` | 仅此条件；用 `safety-text` 色 + bold |
| 回答模式 `本地QLoRA` | 常量（本地 QLoRA 模型固定生成路径） | 恒显示 |
| 回答模式 `RAG知识增强` | `sources` 非空 | 空则不显示 |
| 回答模式 `安全策略介入` | `route === "safety"` | — |
| 引用来源 列表 | `sources[]` | 标题=`title`；元信息=`${sourceFile} · ${documentVersion}` |
| 引用来源「高优」标记 | `reranked === true` 且该项 `rerankScore` 为最大值 | **不得**用文件名/标题猜测 |
| 引用来源 左边框色 | `route === "safety"` 时 rank-1 用 `#A14D45`，其余 `#4F6F8F` | 结构化推导，非文本猜测 |
| 正文引用角标 `[n] title · section` | `sources[n-1].title` + `.section` | 图标：`route === "safety"` 且为 rank-1 用 `security`，否则 `description` |
| 底部 `TRACE-xxxx` | `traceId` | 原样展示，不截断语义 |
| 底部 `2.8s` | `latencyMs` | 格式化为 `(latencyMs/1000).toFixed(1) + "s"` |
| degraded 提示 | `degraded === true` + `degradedReason` | 见 §6 |
| 订单卡片 | `order` | 见 §8.1 |

> 设计稿中 `DOC-8821`、`DOC-9904`、`TRACE-A84F21`、`2.8s`、`20个候选片段`、`Top 5`
> 全部是**设计稿占位示例**，实现时**必须**替换为上表映射的真实字段，不得硬编码。

### 5.4 流式事件处理（`streamChat()` 必须使用）

必须调用 `streamChat(message, history, onEvent, { signal })`，并处理全部 5 类事件：

| 事件 | data | UI 行为 |
|---|---|---|
| `meta` | `{ traceId }` | 立即在右栏底部显示 traceId；右栏进入「处理中」骨架态 |
| `tool-result` | `ToolCallRecord` | **实时**向执行链路追加节点（`queryOrderTool` → 同时渲染订单卡片） |
| `text-delta` | `{ delta }` | 增量追加到当前 AI 气泡正文，保持滚动贴底 |
| `done` | `ChatResponseBody` | 用完整结构化对象**覆盖重建**右栏全部内容 + 引用角标 + 操作行 |
| `error` | `{ message, traceId }` | 进入错误态（§6.2），停止流式，保留已收到的正文 |

补充要求：
- 流式期间发送按钮变为**停止**态，点击触发 `AbortSignal`；
  已知限制：`@mastra/client-js@1.33.0` 在响应头返回前无法原生取消，
  拿到 reader 后 abort 可靠生效 —— UI 需对「请求头返回前点停止」做乐观置灰处理。
- `AbortError` 属于用户主动取消，**不显示错误提示**，仅结束流并保留已生成内容。
- 未收到 `done` 就流结束 → 客户端抛「流式响应提前结束」→ 按 §6.2 错误态处理。

### 5.5 契约扩展（原「契约缺口」，已决策为正式需求）

> 以下两项在评审中已确认**升级为正式需求**，不再是"降级处理的缺口"。
> 本阶段只写需求，实现由后续 task 承接（见 §13）。

---

#### 需求 A — 检索计数字段（`retrievedCount` / `returnedCount`）

**A-1 服务端：`searchKnowledgeBase` 结构化输出新增两个字段**

| 字段 | 类型 | 定义（**严格**） |
|---|---|---|
| `retrievedCount` | `number` | **向量检索实际命中数**，即 `hits.length`（Qdrant 返回的原始候选数量） |
| `returnedCount` | `number` | **最终返回给上层的数量**，即 `sources` / `results` 的实际长度 |

- 两者必须取自真实运行时数据，**不得**使用配置项 `topK` / `limit` 等"预期值"代替；
- `retrievedCount >= returnedCount` 恒成立；重排（rerank）只做截断与重排序，不新增候选；
- 检索失败或未检索时，两者均为 `0`（**不得**为 `undefined` 或缺省）。

**A-2 契约层：`ChatResponseBody` 与 SSE `done` 同步暴露**

```ts
interface ChatResponseBody {
  // ...现有字段
  retrievedCount: number;   // 新增：向量检索命中数
  returnedCount: number;    // 新增：最终返回条数
}
```

- 必须**同步**更新 `mastra-agent/src/mastra/contract.ts` 与 `web-client/src/types.ts`
  （两边字段名与可选性必须完全一致，遵循 types.ts 顶部既有约定）；
- `POST /customer-service/chat` 响应体与 SSE `done` 事件的 data **必须携带相同的两个字段**，
  两条路径不得出现字段差异。

**A-3 前端展示**

| UI 文案 | 数据来源 |
|---|---|
| `已召回 · {retrievedCount} 个候选片段` | `retrievedCount` |
| `重排完成 · Top {returnedCount}` | `returnedCount` |

- ⛔ **禁止硬编码 `20` 或 `5`**，禁止任何形式的默认值兜底为设计稿示例值；
- `retrievedCount === 0` 时不渲染「已召回」节点；
- `reranked !== true` 时不渲染「重排完成」节点（即使 `returnedCount > 0`）。

---

#### 需求 B — 服务状态探测（`GET /customer-service/status`）

**B-1 服务端：Mastra 新增自定义 route**

```
GET /customer-service/status
```

- 挂在**根路径**（与现有两个 route 一致，`/api` 为 Mastra 内置保留前缀，禁止占用）；
- 响应体：

```ts
interface ServiceStatusBody {
  localModel:    ServiceState;
  knowledgeBase: ServiceState;
  orderService:  ServiceState;
}
type ServiceState = "unknown" | "online" | "degraded" | "error";
```

**B-2 各字段语义**

| 字段 | 探测对象 | 状态判定 |
|---|---|---|
| `localModel` | 本地推理服务（llama-server） | 可用 `online`；不可用 `error` |
| `knowledgeBase` | **聚合** Qdrant + Embedding + Reranker | 见下方聚合规则 |
| `orderService` | 订单后端 | 可用 `online`；不可用 `error` |

**`knowledgeBase` 聚合规则（关键）**：

| 条件 | 结果 |
|---|---|
| Qdrant + Embedding + Reranker 均可用 | `online` |
| **Reranker 不可用，但 Qdrant + Embedding（基础检索）可用** | **`degraded`** |
| Qdrant 或 Embedding 不可用（基础检索不可用） | `error` |
| 探测未完成 / 无法判定 | `unknown` |

> 即：Reranker 属于**增强能力**，其失效降级但不致命；基础检索失效才是 `error`。

**B-3 探测实现要求（服务端）**

- **必须有超时**：每个下游探测独立超时，建议 ≤ 2s；超时即判为该项不可用，
  **不得**因某个下游挂起导致 `/status` 整体阻塞；
- **必须脱敏错误**：响应体**只返回**上述四个枚举状态，
  ⛔ 禁止透出下游 URL、端口、IP、主机名、堆栈、原始异常消息等内部细节；
  详细错误只写服务端日志；
- 探测应可并发执行，`/status` 整体响应时间受控（建议 ≤ 3s）。

**B-4 客户端：`web-client/src/client.ts` 新增 `status()`**

```ts
interface CustomerServiceClient {
  chat(...): Promise<ChatResponseBody>;
  streamChat(...): Promise<ChatResponseBody>;
  status(): Promise<ServiceStatusBody>;   // 新增
}
```

- ⛔ **必须**通过 `MastraClient.request()` 调用（与现有两个 route 完全一致的方式），
  沿用 `apiPrefix: ""`；禁止在 `status()` 内使用裸 `fetch` / `axios` 绕开 MastraClient；
- `ServiceStatusBody` / `ServiceState` 类型定义放入 `web-client/src/types.ts`，
  与 `mastra-agent` 契约保持镜像同步。

**B-5 前端禁止直连端口（扩充）**

前端**禁止**直连以下任何端口，一律经 Mastra `:4111`：

| 端口 | 服务 |
|---|---|
| `8000` | FastAPI |
| `8001` | Mock 后端 |
| `8002` | llama-server |
| `6333` | Qdrant |
| `8787` | Reranker |
| `11434` | Ollama Embedding |

**B-6 顶栏状态展示规则（取代原推断方案）**

- ⛔ **顶栏不得再根据"最近一次聊天请求"的结果推断服务在线状态** —— 该方案作废；
- 顶栏三项状态**只能**来自 `status()` 的返回值；
- **初始请求尚未完成时，三项一律显示 `unknown`**（灰色 `#8A94A3`），
  ⛔ 不得乐观预设为"在线"；
- `status()` 调用失败（网络错误/超时/非 2xx）时，三项显示 `error`；
- 状态与配色映射：

| `ServiceState` | 中文 | 圆点色 |
|---|---|---|
| `unknown` | 未知 | `#8A94A3` |
| `online` | 在线 | `#3F7C5F` |
| `degraded` | 降级 | `#A14D45` |
| `error` | 异常 | `#A14D45` |

- 刷新时机：页面首次挂载 + 每次对话 `done`/`error` 之后 + 手动重试；
  轮询间隔若实现，须 ≥ 30s，且页面隐藏时暂停。

**B-7 测试要求（强制）**

`status()` 与状态展示**必须**有测试覆盖，至少包含：
1. 四种 `ServiceState` 各自的顶栏渲染与配色；
2. `knowledgeBase` 聚合规则三条分支（全可用 / Reranker 挂 → `degraded` / 基础检索挂 → `error`）；
3. 初始未完成 → 显示 `unknown`；
4. `status()` 超时与失败 → 显示 `error`，且不抛未捕获异常；
5. 响应体脱敏断言：返回内容中**不含** URL / 端口 / 堆栈等内部细节。

---

## 6. 展示状态规格

### 6.1 需要展示的 7 类状态（对应需求第 4 条）

| 状态 | 展示位置 | 数据来源 |
|---|---|---|
| **QLoRA** | 头部徽章 `QLoRA` + 右栏回答模式 `本地QLoRA` | 常量 |
| **RAG** | 头部徽章 `RAG` + 右栏 `RAG知识增强` + 执行链路「已召回 · {retrievedCount} 个候选片段」 | `sources` 非空 + `retrievedCount` |
| **Rerank** | 执行链路「重排完成 · Top {returnedCount}」+ 来源「高优」标记 | `reranked === true` + `returnedCount` + `rerankScore` |
| **queryOrderTool** | 执行链路「已调用 · 订单服务」+ 中间区订单卡片 | `toolCalls[name==="queryOrderTool"]` + `order` |
| **安全策略** | 正文安全提示卡 + 右栏 `安全策略介入` chip + 执行链路⑥ | `route === "safety"` |
| **引用来源** | 正文引用角标 + 右栏引用来源列表 | `sources[]` |
| **degraded / error** | 见 §6.2 | `degraded` / `error` 事件 |

### 6.2 degraded 与 error 视觉规格

**degraded（`degraded === true`）** — 回答仍然可用，只是链路降级：
- 右栏「回答模式」区追加 chip：`降级运行` — `bg #FBEDEA border #E7B8B2 text #A14D45` + `gpp_maybe` 12px
- chip 下方一行 12px `#A14D45` 展示 `degradedReason` 原文（无则显示 `未提供降级原因`）
- **不阻断**正文展示，AI 气泡正常渲染
- ⛔ **不得**直接据此改写顶栏状态点 —— 顶栏只反映 `status()` 的结果（§5.5 B-6）。
  正确做法：`done` 事件后**触发一次 `status()` 刷新**，由 `status()` 决定顶栏颜色

**error（`error` 事件 / 请求抛错）**：
- 在 AI 气泡位置渲染错误卡：`border #E7B8B2 bg #FBEDEA p-3`，
  `warning` 图标 + bold `回复生成失败`（色 `#A14D45`），
  正文 14px 展示 `message`，下方 12px `#8A94A3` 展示 `traceId`
- 提供 `refresh 重试` 按钮（复用操作行样式），点击以相同入参重发
- 右栏保留已收到的 `meta`/`tool-result` 节点，并追加红色节点 `已中断 · 生成失败`
- 已通过 `text-delta` 收到的部分正文**保留展示**，不清空

**空状态（无任何会话时）**：
- 消息流居中显示：标题 `家电售后智能客服`（`#243142`）+ 副标题
  `可咨询冰箱、彩电、显示器维修问题`（`#667085`）+ 4 个快捷问题 chips
- 右栏内容区显示 12px `#8A94A3` 占位：`暂无处理记录，发送问题后展示执行链路`
- 右栏底部 traceId / 耗时位显示 `—`

---

## 7. 响应式规格（桌面优先，断点全部来自 HTML 实读）

| 断点 | 实读依据 | 行为 |
|---|---|---|
| **≥1280px (xl)** | `xl:w-[320px]` | 右栏 320px；三栏完整；内边距 `md:px-8` |
| **1100–1279px** | `min-[1100px]:flex` | 右栏 300px；三栏完整 |
| **768–1099px (md)** | `hidden min-[1100px]:flex` | **右栏隐藏**；左栏 220px + 中间区；对话头部仍为横向 |
| **<768px** | `hidden md:flex` / `md:inline` | **左栏隐藏**、**顶栏服务状态隐藏**、顶栏副标题隐藏、「清空会话」只剩图标；对话头部转 `flex-col`；消息区内边距降为 `px-4`；正文 15px、行高 1.6 |

**降级补充要求**（设计稿无移动端稿，以下为基于断点的必要可用性补充，实现时保持同一套设计令牌）：
- 右栏隐藏（<1100px）后，必须在对话头部提供 `memory` 图标入口，点击以**右侧抽屉**形式展示完整「处理依据」，内容与右栏 100% 一致
- 左栏隐藏（<768px）后，必须在顶栏左侧提供菜单入口，点击以**左侧抽屉**形式展示会话列表 + 新建会话
- 抽屉遵循：0 圆角、`bg` 同原栏位、200ms ease-out、遮罩 `rgba(36,49,66,0.4)`
- 任何断点下**页面 body 不得出现横向滚动**

---

## 8. 四类业务场景的交互与异常

### 8.1 订单类（`route === "order"`，`queryOrderTool`）

在 AI 正文下方渲染**订单卡片**（样式复用右栏「回答模式卡」：`bg #FCFDFE border #DCE3EA p-4`）：

| `order` 状态 | 判定 | UI |
|---|---|---|
| 查询成功 | `found === true && !partial` | 正常订单信息卡，左边框 `#3F7C5F` |
| 部分字段缺失 | `found === true && partial === true` | 卡片 + 12px `#8A94A3` 提示：`部分信息缺失：{missingFields.join("、")}` |
| 订单不存在 | `error === "not_found"` | 安全色卡：`订单不存在，请核对订单号` |
| 超时 | `error === "timeout"` | 安全色卡：`订单服务响应超时` + `重试` 按钮 |
| 服务错误 | `error === "server_error"` | 安全色卡：`订单服务异常，请稍后再试` |
| 网络错误 | `error === "network_error"` | 安全色卡：`网络异常，无法连接订单服务` + `重试` 按钮 |

- 未提供订单号时服务端会**先追问**（不调用工具）→ 前端此时 `toolCalls` 中无 `queryOrderTool`，
  **不渲染**订单卡片与「已调用 · 订单服务」节点
- 快捷问题 `查询ORD1001` 点击后直接填入输入框（不自动发送），便于用户改单号

### 8.2 维修类（`route === "repair"`）

- 正文按设计稿渲染多段 + 有序列表（`<br>` 分隔的编号步骤，保持 1.6/1.7 行高）
- 引用角标使用 `description` 图标
- 右栏完整展示：已识别 → 已调用维修知识库 → 已召回 → 重排完成 → 已生成
- `sources` 为空时：不渲染引用角标与来源列表，右栏「已召回」节点不显示，
  回答模式不显示 `RAG知识增强`

### 8.3 安全类（`route === "safety"`）

- 正文**必须**渲染安全提示卡（`#E7B8B2` / `#FBEDEA` / `#A14D45` + `warning` 图标）
- 引用角标中安全类使用 `security` 图标
- 右栏：执行链路末位 `已触发 · 安全策略`（safety 色 + bold）；回答模式含 `安全策略介入`；
  来源列表 rank-1 左边框用 `#A14D45`
- 安全提示卡文案来自服务端正文，**不在前端硬编码安全话术**

### 8.4 普通问候（`route === "general"`）

- 仅渲染 AI 气泡正文 + 操作行
- **不渲染**：引用角标、安全卡、订单卡
- 右栏：只有 `已识别 · 一般咨询` + `已生成`；回答模式仅 `本地QLoRA`；
  引用来源区显示空占位 `本次回答未引用知识库`
- 这是验证「右栏不臆造内容」的关键回归场景

---

## 9. 验收标准

### 9.1 设计还原验收

| 项 | 标准 |
|---|---|
| **截图对比** | 1280×1024 与 2560×2048 两档，与 `assets/workbench-screenshot.jpg` 并排比对；三处已知截图偏差（§1.6）不计为差异 |
| **颜色** | 取色器验证 §3.1 全部 19 个 token 精确一致（十六进制完全相等，不允许近似色） |
| **字体** | Inter 与 JetBrains Mono 均正确加载；§3.2 使用范围正确（右栏整体等宽） |
| **圆角** | 全站 0px，含状态点、头像、按钮、卡片、chips |
| **间距** | 顶栏 64px；左栏 220px；右栏 300/320px；消息 `space-y-8`；`pb-40` 避让正确 |
| **层级** | 顶栏 `z-50` 固定；输入区绝对定位贴底；最后一条消息不被遮挡 |
| **滚动** | body 无滚动；四个 `no-scrollbar` 容器滚动条不可见；新消息自动贴底 |
| **空状态** | §6.2 空状态完整正确 |
| **图标** | 13 个 Material Symbols 全部正确且尺寸一致 |

### 9.2 功能验收

- 四类场景（订单/维修/安全/普通问候）交互与异常态全部符合 §8
- 流式 5 类事件全部可见生效（§5.4）
- degraded / error / 取消 三态符合 §6.2
- 右栏所有数据可追溯到 `ChatResponseBody` 字段（§5.3）
- **计数字段（§5.5 需求 A）**：
  - 「已召回」绑定 `retrievedCount`、「重排完成」绑定 `returnedCount`
  - 全仓检索确认无 `20` / `5` 硬编码或默认值兜底
  - `chat` 响应体与 SSE `done` 两条路径字段一致
- **服务状态（§5.5 需求 B）**：
  - 顶栏三项仅由 `status()` 驱动，初始态为 `unknown`
  - `knowledgeBase` 聚合三分支正确（含 Reranker 挂 → `degraded`）
  - `status()` 响应体已脱敏，无 URL / 端口 / 堆栈
  - 探测超时生效，`/status` 不因下游挂起而阻塞

### 9.3 资产完整性验收

- `assets/` 两个文件的字节数与 SHA-256 与 §1.5.1 基线一致
- 资产获取流程遵守 §1.5.2 三项判定（落盘 + 大小 + 校验和），不以 MCP 回执为准

---

## 10. 测试与门禁

| # | 门禁 | 命令 / 方式 | 通过标准 |
|---|---|---|---|
| 1 | **typecheck** | `npm run typecheck`（web-client） | 0 error |
| 2 | **build** | `npm run build`（Vite 生产构建） | 成功，无警告级错误 |
| 3 | **UI/组件测试** | Vitest + Testing Library | 覆盖四类 route、5 类流式事件、degraded/error/空状态、订单 6 种状态 |
| 4 | **Mastra Client smoke** | `npm run smoke`（复用现有 `scripts/smoke.ts`） | 对 :4111 真实往返成功 |
| 5 | **禁止直连扫描** | 源码扫描 5 个端口 + `getAgent(` | **0 命中** |
| 6 | **计数硬编码扫描** | 扫描 `20` / `5` 字面量出现在召回/重排文案处 | **0 命中** |
| 7 | **资产完整性** | `shasum -a 256 -c` 比对 §1.5.1 基线 | 全部 OK |
| 8 | **设计复核** | Stitch MCP 重新拉取 screen 或浏览器截图，与实现并排比对 | 符合 §9.1 |

**门禁 5 建议实现**（CI 可执行，端口已扩充至 5 个）：

```bash
grep -rnE ':(8000|8001|8002|6333|8787|11434)|getAgent\(' web-client/src \
  --include='*.ts' --include='*.tsx' \
  && { echo '❌ 检测到禁止的直连或绕过用法'; exit 1; } || echo '✅ 无直连'
```

**门禁 6 建议实现**：

```bash
grep -rnE '(已召回|重排完成|Top)\s*[·:]?\s*(20|5)\b' web-client/src \
  --include='*.ts' --include='*.tsx' \
  && { echo '❌ 检测到召回/重排计数硬编码'; exit 1; } || echo '✅ 无硬编码计数'
```

**特别校验**：所有网络调用必须溯源到 `web-client/src/client.ts`；
组件层不得出现 `fetch(` / `axios` / `new MastraClient(`。

**测试补充**：门禁 3 的组件测试须包含 §5.5 B-7 列出的 5 项 `status()` 测试。

---

## 11. 技术栈与工程约束

### 11.1 技术栈

- **React + Vite + TypeScript**（需求第 6 条）
- 样式：Tailwind CSS（与 Stitch 产物同构，直接移植内联 `tailwind.config` 的 `theme.extend`，还原成本最低）
- 测试：Vitest + @testing-library/react

### 11.2 必须扩展现有 web-client（不新建客户端）

现状实读：

```
web-client/
├── package.json          # name: customer-service-client，deps: @mastra/client-js@1.33.0
├── tsconfig.json
├── src/client.ts         # ✅ createCustomerServiceClient / chat / streamChat（复用，勿重写）
├── src/types.ts          # ✅ ChatResponseBody 等契约镜像（复用，勿重写）
└── scripts/smoke.ts      # ✅ 现有 smoke（复用）
```

**扩展方式**：在 `web-client/` **内部**新增 React + Vite 应用层
（如 `src/app/`、`index.html`、`vite.config.ts`），
`package.json` 增加 `dev` / `build` / `test` 脚本与 React/Vite/Tailwind 依赖。

**严禁**：
- ❌ 新建第二个客户端包（如 `frontend-workbench/app/`、`web-client-v2/`）
- ❌ 复制或重写 `client.ts` / `types.ts` 的逻辑
- ❌ 修改 `client.ts` 的对外契约（如需扩展须先同步 `mastra-agent/src/mastra/contract.ts`）

> 说明：`frontend-workbench/` 目录**仅存放本需求文档与设计资产**，不放实现代码。

### 11.3 禁止修改的路径（需求第 15 条）

- ❌ `services/**`
- ❌ `datasets/**`
- ❌ `training/**`
- ❌ `configs/**`
- ❌ `knowledge/**`
- ❌ 模型资产（`models/**`）
- ❌ 已冻结的评测报告

本次改造**不触碰**上述任何路径。

**⚠️ 范围变更（本次评审）**：`mastra-agent/**` 由「不在改动范围」调整为
**在实现阶段属可改动范围**，因为 §5.5 需求 A / B 已确认为正式需求，必须落到服务端：

| 路径 | 允许的改动 |
|---|---|
| `mastra-agent/src/mastra/contract.ts` | 新增 `retrievedCount` / `returnedCount` / `ServiceStatusBody` / `ServiceState` |
| `mastra-agent/src/mastra/tools/*`（searchKnowledgeBase） | 结构化输出新增两个计数字段 |
| `mastra-agent/src/mastra/routes/customer-service.ts` | 新增 `GET /customer-service/status` |
| `mastra-agent/src/mastra/orchestration.ts` | 透传计数字段至 chat 响应与 SSE `done` |
| `web-client/src/types.ts` | 镜像同步上述契约类型 |
| `web-client/src/client.ts` | 新增 `status()`（经 `MastraClient.request()`） |

改动须遵守 `types.ts` 顶部既有约定：**服务端契约与客户端镜像必须同步、字段名与可选性一致**。
除上表外，`mastra-agent/**` 的其他改动仍需单独评审。

### 11.4 版本控制约束（需求第 16 条）

- ❌ 不 `git add` / 不 `commit` / 不 `push`
- ✅ 变更保留在工作区，**停在 Review 点**由人工审阅

---

## 12. 风险与决策记录

**决策日期**：2026-07-31 ｜ **状态**：全部已裁定，无待决项

| # | 事项 | 决策 | 状态 |
|---|---|---|---|
| A | 召回/重排计数无契约字段（§5.5-A） | **升级为正式需求**：新增 `retrievedCount`（= `hits.length`）与 `returnedCount`（= 最终返回数），chat 响应体与 SSE `done` 同步暴露；UI 绑定这两个字段；禁止硬编码 20/5 | ✅ 已定，待实现 |
| B | 无服务健康检查（§5.5-B） | **升级为正式需求**：新增 `GET /customer-service/status` + `client.status()`；返回 `localModel`/`knowledgeBase`/`orderService`，四态 `unknown`/`online`/`degraded`/`error`；`knowledgeBase` 聚合 Qdrant+Embedding+Reranker，Reranker 单挂为 `degraded`；顶栏禁止再由聊天请求推断；须有超时、脱敏与测试 | ✅ 已定，待实现 |
| C | 无移动端设计稿 | 按 §7 抽屉方案降级，复用同一套设计令牌 | ✅ 已定 |
| D | 无暗色稿（`class="light"`） | 本期不实现暗色模式 | ✅ 已定 |
| E | 项目级灰阶主题与 screen 蓝灰配色冲突（§1.4） | **screen 内联 `tailwind.config` 为唯一权威**；项目级 designTheme 灰阶配置**明确不采用**，取自该处的颜色值判定为缺陷 | ✅ 已定 |
| F | Stitch 截图三处渲染缺失（§1.6） | **以 HTML 为设计意图**：3 状态点 / 6 执行节点 / 4 chip 全部必须实现；**截图缺失不得作为删减理由** | ✅ 已定 |
| G | `download_assets` 假成功（§1.5.2） | **保留 `downloadUrl` 直取方案**；资产下载须以真实落盘 + 文件大小 + SHA-256 三项验收；**MCP success 回执不能单独作为成功依据** | ✅ 已定 |

**新增风险（由本次决策引入）**：

| # | 事项 | 影响 | 缓解 |
|---|---|---|---|
| H | 契约扩展涉及服务端改动（§11.3 范围变更） | `mastra-agent/**` 进入可改范围，波及面变大 | 严格限定为 §11.3 表中六处；契约两侧必须同步改 |
| I | `/status` 探测可能拖慢首屏 | 首屏等待下游探测 | 每项独立超时 ≤2s，并发执行，整体 ≤3s；UI 先渲染 `unknown` 不阻塞 |
| J | 状态探测可能泄露内部拓扑 | 端口/URL/堆栈外泄 | B-3 强制脱敏，只返回四态枚举；B-7 含脱敏断言测试 |

---

## 13. Tasks 建议（实现阶段拆分，本阶段不执行）

> 依赖顺序：契约先行 → 服务端 → 客户端 → UI → 门禁。
> T1–T3 属 `mastra-agent/**`，须遵守 §11.3 范围限制。

| # | Task | 范围 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 | 契约扩展：`retrievedCount` / `returnedCount` / `ServiceStatusBody` / `ServiceState` | `mastra-agent/.../contract.ts` + `web-client/src/types.ts` | — | 两侧字段名与可选性完全一致 |
| T2 | `searchKnowledgeBase` 输出真实计数 | `mastra-agent/.../tools/*` | T1 | 取自运行时 `hits.length`，非配置 `topK`；`retrievedCount >= returnedCount` |
| T3 | 新增 `GET /customer-service/status`（含超时 + 脱敏 + 聚合规则） | `mastra-agent/.../routes/customer-service.ts` | T1 | §5.5 B-2/B-3 全部满足 |
| T4 | 计数字段透传至 chat 响应与 SSE `done` | `mastra-agent/.../orchestration.ts` | T1,T2 | 两条路径字段一致 |
| T5 | `client.status()`（经 `MastraClient.request()`，`apiPrefix: ""`） | `web-client/src/client.ts` | T1,T3 | 无裸 `fetch`；smoke 可真实往返 |
| T6 | Vite + React + TS + Tailwind 应用层脚手架（移植 screen 内联 `theme.extend`） | `web-client/`（内部） | — | typecheck + build 通过；不新建第二个客户端包 |
| T7 | 三栏骨架 + 顶栏（状态绑定 `status()`，初始 `unknown`） | UI | T5,T6 | §4.0–4.2、§5.5 B-6 |
| T8 | 中间对话区 + 流式 5 类事件 + 输入区 | UI | T6 | §4.3–4.4、§5.4 |
| T9 | 右栏处理依据（执行链路绑定计数字段 / 回答模式 / 引用来源） | UI | T4,T6 | §4.5、§5.3；无正则猜测、无硬编码计数 |
| T10 | 四类场景与异常态（订单 6 态 / 安全 / 维修 / 问候 / degraded / error / 取消） | UI | T8,T9 | §6、§8 |
| T11 | 响应式降级（<1100 右栏抽屉、<768 左栏抽屉） | UI | T7–T9 | §7；任何断点无横向滚动 |
| T12 | 测试：组件测试 + `status()` 5 项测试 + Mastra smoke | 测试 | T5–T11 | §10 门禁 3/4 |
| T13 | 门禁脚本：直连扫描（5 端口）+ 计数硬编码扫描 + 资产 SHA-256 | CI | T12 | §10 门禁 5/6/7 全绿 |
| T14 | 设计还原复核（Stitch MCP 重取 + 截图并排比对） | 验收 | T11 | §9.1；三处已知截图偏差不判为缺陷 |

---

## 附录：数据来源声明

| 内容 | 来源 |
|---|---|
| 项目元数据、设计系统、designMd | `mcp__stitch__get_project` 实读 |
| screen 清单与版本 | `mcp__stitch__list_screens` + `mcp__stitch__get_screen` ×3 实读 |
| 布局/配色/字体/间距/圆角/图标/交互 | `assets/workbench-stitch.html`（MCP `htmlCode.downloadUrl` 实取） |
| 视觉比对基准 | `assets/workbench-screenshot.jpg` 2560×2048（MCP `screenshot.downloadUrl` 实取） |
| 数据契约 | `web-client/src/types.ts`、`web-client/src/client.ts`、`mastra-agent/src/mastra/contract.ts` 实读 |
| 订单错误枚举与工具行为 | `mastra-agent/src/mastra/contract.ts`、`agent.e2e.test.ts` 实读 |

**本文档不含任何未经上述来源验证的臆测内容。**
