# Stitch 新版设计基线 — 2026-07-31

来源：Stitch 项目 `10964917433981148706`，screen `智修客服 - 高级视觉版工作台`
（screen id `c1e93f6766574641a7807fa65c00c256`，2560×2048 桌面版，
`updateTime: 2026-08-01T04:42:50.177267Z`，本项目现存唯一 screen，是本轮
唯一视觉权威）。

## 资产与 SHA-256 基线

| 文件 | SHA-256 |
| --- | --- |
| `workbench-stitch-v2.html` | `40f5431847a2264124064301dacdac582f8278384cc984d66d4c65f0667d165` |
| `workbench-stitch-v2-screenshot.jpg`（2560×2432 全尺寸） | `619da7d01ffaf1973c44dff5466cb4f2168e951f1dc07b53a93fdd547484d69` |

旧版设计稿（`frontend-workbench/docs/assets/workbench-stitch.html` /
`workbench-screenshot.jpg`）保留不动，仅作对比参考，不作为本轮验收依据。

## 决策记录：圆角冲突

新稿的 `borderRadius` 定义了非零圆角（见下表），与现有
`web-client/src/app/styles.css` 的全局 `* { border-radius: 0 !important }`
及 `.claude/rules/frontend-conventions.md` 的"全局 0 圆角"强约束直接冲突。
**已征得用户明确决定：采用新稿圆角方案，推翻 0 圆角决策。** 后续实施需要：
- 移除/替换 `styles.css` 的全局强制清零规则；
- 更新 `frontend-conventions.md` 与 `CLAUDE.md` 中"全局 0 圆角"的表述；
- `gate-assets.sh` 等门禁如有依赖 0 圆角假设需一并检查。

## 字体

| 用途 | 字体 | 引入方式 |
| --- | --- | --- |
| 正文/标题 | Inter（400/500/600/700） | `fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700` |
| 等宽（trace/code） | JetBrains Mono（400/500） | 同一 `<link>`，`family=JetBrains+Mono:wght@400;500` |
| 图标 | Material Symbols Outlined（可变字重/填充） | 独立 `<link>`，`family=Material+Symbols+Outlined:wght,FILL@100..700,0..1` |

**图标诊断结论**：现有 `web-client/index.html` 的两个 `<link>` 与新稿**完全一致**，
字体 CDN 本身可正常访问（`curl` 验证 200 + 正确 `@font-face`）。用 JS 在真实
页面检测 `document.fonts.status === "loaded"` 且 `Material Symbols Outlined`
确实在已加载字体列表中，图标 `span` 的渲染宽度也是真实字形宽度（18–24px），
不是文字宽度——**配置本身没有问题**。但历史会话中多次观察到图标显示为字面
文字（`arrow_upward`/`delete` 等），说明这是**间歇性的首屏渲染竞态**（字体
下载/`font-display:swap` 生效的时序问题），而不是网络不可用或类名写错。
任务 1 需要做防御性修复（例如：图标容器在字体确认加载完成前用
`visibility:hidden` 或占位符隐藏，避免闪现裸文字；必要时考虑本地托管字体
文件降低对外部 CDN 时序的依赖），并新增自动化的"可见文本扫描测试"防止
回归（对应本轮硬性要求）。

## 颜色 Token（新增/变更，均来自 `tailwind.config` 内联脚本）

| Token | 值 | 说明 |
| --- | --- | --- |
| `page-bg` | `#F5F7FA` | 页面背景（原色系相近但数值需要核对是否变化） |
| `content-bg` | `#FCFDFE` | 主容器背景 |
| `sidebar-left-bg` | `#EEF2F6` | 左栏背景 |
| `sidebar-right-bg` | `#F7F9FB` | 右栏背景 |
| `text-primary` | `#243142` | 主文字 |
| `text-secondary` | `#667085` | 次文字 |
| `text-muted` | `#8A94A3` | 弱化文字 |
| `border-color` | `#DCE3EA` | 通用边框 |
| `brand-primary` | `#4F6F8F` | 品牌主色（按钮/高亮） |
| `brand-primary-hover` | `#405F7D` | 品牌主色 hover |
| `brand-light-bg` | `#E8F0F7` | 品牌浅底（含背景光晕装饰） |
| `success-green` | `#3F7C5F` | 在线状态点 |
| `success-bg` | `#E9F4EE` | 成功底色 |
| `safety-text` | `#A14D45` | 安全警示文字 |
| `safety-bg` | `#FBEDEA` | 安全警示底色 |
| `safety-border` | `#E7B8B2` | 安全警示边框 |
| `citation-bg` | `#E7F3F1` | 引用来源底色 |
| `citation-text` | `#3F7C78` | 引用来源文字 |
| `input-border` | `#CBD5DF` | 输入框边框 |

共 19 个具名颜色 token（与既有"19/19 色彩 Token"验收口径的数量一致，但
**数值本身有变化**，需要以本表为准逐一核对，不能直接沿用旧基线的十六进制值）。

## 圆角（新增，替代 0 圆角规则）

| Token | 值 |
| --- | --- |
| `DEFAULT` | 12px |
| `lg` | 16px |
| `xl` | 24px |
| `full` | 9999px |

实际使用中还大量出现任意值圆角：`rounded-[10px]`（新建会话按钮）、
`rounded-[12px]`（安全卡/引用卡/气泡）、`rounded-r-md`/`rounded-md`
（会话列表选中项/顶栏按钮）、气泡的不对称圆角（用户气泡
`rounded-[12px] rounded-tr-[4px]`）——实施时需要逐组件核对任意值，不能
只套用四个具名 token。

## 阴影

| Token | 值 |
| --- | --- |
| `shadow-main` | `0 24px 60px rgba(36,54,78,0.14), 0 4px 16px rgba(36,54,78,0.08)`（主容器） |
| `shadow-soft` | `0 2px 8px rgba(36,54,78,0.06)`（卡片/按钮） |
| `shadow-inner-top` | `inset 0 1px 0 rgba(255,255,255,0.6)`（高光内阴影，用于选中态/主容器顶部） |
| `glow-blue`（自定义 class） | `0 0 12px rgba(79,111,143,0.4)` |
| `glow-green`（自定义 class） | `0 0 8px rgba(63,124,95,0.6)`（在线状态点的辉光） |

## 间距与三栏尺寸

- 主容器：`max-w-[1920px] mx-auto m-4 lg:m-8`——**新稿把整个工作台做成
  居中悬浮卡片**（四周留白 16px/32px + `rounded-lg` + `shadow-main` +
  背景两处 `blur-3xl` 光晕装饰），不再是贴边满屏三栏。这是与现有实现
  最大的布局层面差异，需要在 PRD 里作为"全局背景与主容器质感"任务单独
  列出，不能只当作细节颜色调整处理。
- 顶栏高度：`h-16`（64px），`px-6` 横向内边距，毛玻璃 `backdrop-blur-md`
  + 半透明背景 `bg-content-bg/80`。
- 左栏：`w-[220px]`，断点 `md`（768px）以下隐藏——与现有实现宽度/断点
  需要逐一核对（现有实现左栏宽度是否也是 220px 待第 4 号任务核实）。
- 右栏：`w-[320px]`，断点 `min-[1100px]` 以下隐藏——断点写法与现有项目
  一致（自定义 `min-[1100px]`，不是 Tailwind 默认 `lg`(1024px)），这一点
  沿用正确，不是本轮需要修的差异。
- 用户消息气泡：`max-w-2xl`；助手正文区：`max-w-3xl`；订单/安全卡片
  容器：`max-w-4xl mx-auto`。

## 图标清单（`material-symbols-outlined` 实际用例，13 处）

`menu`（左栏抽屉，隐藏视口）、`delete`（清空会话）、`add`（新建会话）、
`memory`（处理依据面板标题，出现两次）、`arrow_upward`（发送按钮）等，
与现有实现的图标名称基本一致，主要变化在尺寸（`text-[13px]`/`text-[18px]`/
`text-[20px]` 精细分级，不是统一尺寸）与颜色（部分图标带
`text-brand-primary`/`text-safety-text`/`text-[#4F6F8F]` 等语义色）。

## 修改前基线（本轮初始化时的真实前端状态）

已在真实浏览器（`http://localhost:5173`，1920×1080）打开当前
`web-client` 实现并截图核验：三栏布局骨架、颜色基调与新稿整体相似度较高
（同一设计语系的迭代，不是推倒重来），主要差异集中在：主容器是否悬浮
留白、圆角数值、阴影质感、部分卡片的精细配色。**截图文件本身受工具限制
无法保存到磁盘**（与此前 `acceptance-2026-07-31` 报告记录的限制相同），
本节结论基于当时的实时截图目测比对，后续每个任务完成后的截图验收将在
`frontend-workbench/specs/9.stitch-v2-visual-restoration/screenshots/`
下尝试保存，若工具限制仍然存在会如实说明。

图标测试本身发现：当前实现在 JS 层面字体加载正确（`document.fonts`
确认 `Material Symbols Outlined` 已加载），但历史会话反复观察到图标显示
为字面文字，判定为间歇性首屏竞态，不是配置错误——纳入任务 1 的修复范围。
