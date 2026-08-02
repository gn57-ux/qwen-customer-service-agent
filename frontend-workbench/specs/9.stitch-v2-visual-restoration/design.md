# Feature 9: Stitch v2 视觉还原 — 设计文档

设计权威：`frontend-workbench/docs/assets/stitch-v2/workbench-stitch-v2.html`
+ `workbench-stitch-v2-screenshot.jpg`（SHA-256 见同目录
`DESIGN-BASELINE-v2.md`）。全部数值引用自该文件的内联 `tailwind.config`
与实际 class 用例，不凭记忆或旧稿臆测。

## 全局 token 改动（`web-client/tailwind.config.ts`）

| 项 | 现状 | 目标 |
| --- | --- | --- |
| `borderRadius.DEFAULT` | `0px` | `12px` |
| `borderRadius.lg` | `0px` | `16px` |
| `borderRadius.xl` | `0px` | `24px` |
| `borderRadius.full` | `0px` | `9999px` |
| `boxShadow` | 未定义 | 新增 `main`/`soft`/`inner-top`（见下） |
| `fontSize.body-md` 行高 | `1.6` | `1.7` |
| 颜色 19 项 | 逐值核对 | **数值不变**（新旧稿一致，仅作确认，不修改） |

`boxShadow` 新增：
```
main: "0 24px 60px rgba(36,54,78,0.14), 0 4px 16px rgba(36,54,78,0.08)"
soft: "0 2px 8px rgba(36,54,78,0.06)"
inner-top: "inset 0 1px 0 rgba(255,255,255,0.6)"
```
另需在 `styles.css` 新增两个非 Tailwind-token 的自定义 class（新稿内联
`<style>` 定义，不在 `tailwind.config` 里）：
```css
.glow-blue { box-shadow: 0 0 12px rgba(79, 111, 143, 0.4); }
.glow-green { box-shadow: 0 0 8px rgba(63, 124, 95, 0.6); }
.bg-gradient-page { background: linear-gradient(135deg, #F5F8FC 0%, #EDF2F7 100%); }
```

## `web-client/src/app/styles.css` 改动

移除全局 `* { border-radius: 0 !important }` 强制清零规则（已征得用户
同意推翻 0 圆角决策，见 requirements.md）。移除后各组件的 `rounded-*`
class 需要按本文档各任务小节的具体数值显式指定，**不能留空导致退回
浏览器默认圆角**，也不能全局套用某一个圆角值——新稿本身圆角是"分层级"
的（按钮 10px、卡片 12px、气泡不对称 12px/4px、主容器 lg=16px 等）。

## 任务 1：字体与图标加载修复

**现状诊断**（已用真实浏览器 JS 检测确认，见 DESIGN-BASELINE-v2.md）：
`index.html` 的两个 Google Fonts `<link>` 与新稿一致，`document.fonts`
最终会显示 `Material Symbols Outlined: loaded`，但存在**间歇性首屏
竞态**——字体下载完成前，`.material-symbols-outlined` span 会先以
fallback 字体渲染出图标名称的文字（如 `arrow_upward`），历史会话中
反复观察到这一现象持续到用户可见的程度（不是毫秒级、不可感知的正常
FOUC）。

**修复方式**：
- 在 `web-client/src/app/styles.css` 中给 `.material-symbols-outlined`
  增加：初始 `opacity: 0`，配合 JS 层在 `document.fonts.ready` resolve
  后统一切换一个根节点 class（如 `html.icons-ready`）来把 opacity 设回
  1；避免任何时刻用户看到裸文字闪现。实现位置放在 `main.tsx` 或一个新的
  极小 hook（如 `useIconFontReady`），不得侵入业务组件逻辑。
- 保留现有两个 `<link>`（CDN 本身可用，不改为本地托管——除非任务 8
  的截图回归发现该方案在真实网络环境下仍不稳定，才升级为本地字体文件
  这个更重的方案）。

**验收（像素级，浏览器实测）**：
- 页面从空白到完全可交互的全过程中，`material-symbols-outlined` 的
  `textContent`（`menu`/`delete`/`add`/`memory`/`arrow_upward` 等）在
  任何一帧截图里都不得以可读文字形式出现——用 Playwright/浏览器工具
  连续截图或录制短时间间隔的多次截图核验，不能只截一张"稳定后"的图。
- 新增自动化"可见文本扫描测试"（Vitest + Testing Library）：渲染顶栏/
  左栏/输入区组件后，断言 DOM 中不存在裸露的、等于已知图标名称
  （`menu`/`delete`/`add`/`memory`/`arrow_upward`/`chat`/...）且父级
  带 `material-symbols-outlined` class 的可见文本节点。

## 任务 2：全局背景与主容器质感

**现状**：现有实现是贴边满屏三栏（无留白、无主容器阴影）。
**目标**（新稿结构）：
- 页面根背景使用 `bg-gradient-page`（`linear-gradient(135deg, #F5F8FC
  0%, #EDF2F7 100%)`），两个装饰性光晕 `absolute` 定位、`w-96 h-96`
  （384px）、`bg-brand-light-bg`、`blur-3xl`、`opacity-50`，分别在
  左上角（`-translate-x-1/2 -translate-y-1/2`）与右下角
  （`translate-x-1/2 translate-y-1/2`），`pointer-events-none`。
- 主容器：`max-w-[1920px] mx-auto`，外边距 `m-4`（16px，`lg:` 断点即
  ≥1024px 时 `m-8`=32px），`bg-content-bg`，`rounded-lg`（=16px），
  `border border-border-color`，`shadow-main-with-inner`（**不是**
  `shadow-main shadow-inner-top` 两个 Tailwind class 并列——实测发现
  box-shadow 是单值属性，两个 shadow-* 工具类共享同一个 `--tw-shadow`
  变量，样式表顺序在后的会完全覆盖前一个，不会叠加；新稿 HTML 原样
  就是两个 class 并列写法，但那样只有其中一层阴影会真实生效，不符合
  "浏览器最终像素"验收标准，已在 `styles.css` 手动合并成一个组合
  `box-shadow` 值，同时包含外部投影与内部顶部高光）。

**验收**：1920px 视口下主容器四周应有可见留白与阴影投射（不是贴边）；
1024px 以下 `m-8`→`m-4` 的过渡需实测（Tailwind `lg:` 断点=1024px，
与本项目其余"自定义 `min-[1100px]`"断点不是同一套，此处沿用 Tailwind
默认 `lg`，需在 tasks.md 里明确标注避免和右栏断点混淆）。光晕不能造成
横向/纵向滚动溢出（`overflow-hidden`/`pointer-events-none` 需确认生效）。

## 任务 3：顶栏视觉还原

- 高度 `h-16`（64px，现有需核实是否一致）；`px-6`（24px）横向内边距。
- 背景：`bg-content-bg/80` + `backdrop-blur-md`（毛玻璃效果，现有可能是
  纯色不透明背景，需要改为半透明+模糊）。
- 底边框：`border-b border-border-color/60`（60% 透明度，不是纯色）。
- 标题：`text-[22px] font-bold text-text-primary`；副标题
  `text-text-muted font-code text-[13px]`，左侧 `border-l
  border-border-color/60 pl-4`，`md` 断点以下隐藏。
- 三个状态点：`w-1.5 h-1.5`（6px）圆点 + `glow-green` 辉光（在线态）。
- 清空会话按钮：`p-2 rounded-md`（=12px，注意不是 `rounded-full`），
  hover `bg-brand-light-bg`。

**验收**：`getComputedStyle` 核实高度 64px、`backdrop-filter` 生效、
按钮圆角 12px；截图确认状态点有柔和辉光而非纯色硬点。

## 任务 4：左栏视觉还原

- 宽度 `w-[220px]`，`md`（768px）断点以下隐藏为抽屉。
- 背景 `bg-sidebar-left-bg`，右边框 `border-r border-border-color/60`。
- 新建会话按钮：背景 `#344E68`（注意这是任意值，不在 19 个具名 token
  里，需要核实是否要新增为具名 token 还是直接写十六进制——如未来有第二
  处复用建议提为 token，本任务先按新稿原样使用任意值），文字白色，
  `rounded-[10px]`，`shadow-soft`，hover `bg-brand-primary-hover`。
- 会话列表选中态：背景 `#E4ECF4`，左边框 `border-l-[3px]
  border-[#4F6F8F]`，`shadow-inner-top`，`rounded-r-md`（**更正**：不是
  之前误写的 12px——`rounded-r-md` 用的是 Tailwind 内置 `md` 尺寸
  （0.375rem=6px），`borderRadius.DEFAULT/lg/xl` 的自定义覆盖不影响
  `md` 这个 key，新稿本身也确实是 6px 圆角，只圆右侧两角，因为左边有
  强调边框）。未选中项 hover `bg-[#E4ECF4]/50`，左侧留 `ml-[3px]`
  对齐选中项的边框宽度。

**验收**：选中/未选中两态截图对比，边框宽度 3px、圆角只在右侧生效
（左侧应为直角，与强调边框衔接）。

## 任务 5：中间消息与安全卡片还原

- 用户气泡：渐变背景 `bg-gradient-to-br from-[#EEF4FA] to-[#E2ECF6]`，
  边框 `border-[#D9E6F2]`，不对称圆角 `rounded-[12px] rounded-tr-[4px]`
  （右上角小圆角，模拟"尖角指向发送方"的气泡观感），`shadow-soft`，
  `max-w-2xl`。
- 助手正文：`max-w-3xl`，无气泡背景（延续现有"纯文本+独立卡片"布局）。
- 安全警示卡片：边框 `border border-[#F2C5BE]`，背景 `bg-[#FDF5F3]`，
  `rounded-[12px]`，左侧强调边框 `border-l-[3px] border-l-[#C55B51]`，
  `shadow-soft`，内部 `p-4 flex gap-3`。**此卡片的配色不在 19 个具名
  token 里（`#F2C5BE`/`#FDF5F3`/`#C55B51` 均为任意值），与 `safety-*`
  三个具名 token（`#A14D45`/`#FBEDEA`/`#E7B8B2`）不是同一组值**——需要
  在实施前与设计基线核对这是否是"同一语义、新旧稿之间的数值微调"还是
  "两套并存的安全色"，若确认是新旧稿的同语义微调，以新稿任意值为准；
  如果拿不准，按"浏览器最终像素"原则以新稿截图色值为准，不臆测。

**验收**：气泡不对称圆角肉眼可辨（右上角明显更小）；安全卡片颜色需要
用取色工具/`getComputedStyle` 核实实际渲染色值与上述任意值一致。

## 任务 6：右栏证据面板还原

- 宽度 `w-[320px]`，断点 `min-[1100px]`（沿用现有自定义断点，不是
  Tailwind `lg`）。
- 背景 `bg-sidebar-right-bg`，左边框 `border-l border-border-color/60`。
- 执行链路时间轴：`border-l border-[#DCE3EA] ml-2 pl-4 py-1` 竖线连接
  各节点。
- 引用来源卡片：`bg-white rounded-[12px] border border-[#E2E8F0]
  p-3 shadow-soft hover:shadow-md`，左侧强调边框按类型区分颜色
  （`border-l-[3px] border-l-[#4F6F8F]` 常规 / `border-l-[3px]
  border-l-[#C55B51]` 高优先级）。

**验收**：hover 状态阴影从 `shadow-soft` 加深为 `shadow-md`（Tailwind
默认值，需确认未被自定义覆盖）；两种优先级卡片的左边框颜色可区分。

## 任务 7：输入区还原

已重新定位新稿 HTML 全文的输入区真实片段（搜索"输入"关键字定位到
`<!-- Bottom Input Area -->` 注释块），逐字段核对结果：

- 外层容器：`absolute bottom-0 left-0 w-full bg-gradient-to-t
  from-content-bg via-content-bg to-transparent pb-6 px-4 md:px-8
  pt-4 z-20`——用渐变淡出遮罩替代旧的纯色背景 + 顶部实线边框，视觉上
  让输入区与上方消息列表之间有柔和过渡而不是硬分割线。
- 输入框容器：`relative bg-white rounded-[12px] border
  border-[#CBD5E1] shadow-soft focus-within:border-[#8BA5C2]
  focus-within:ring-1 focus-within:ring-[#8BA5C2]/50`——白底 + 12px
  圆角 + 聚焦态边框/光环颜色变化，均为任意值，不在 19 个具名 token 里。
- `textarea`：`p-4 pb-12 text-[15px] placeholder-[#94A3B8]
  rounded-[12px]`（原实现是 `font-body-md`/`placeholder-text-muted`，
  已按新稿改为直接的字号/占位符任意色值）。
- 发送按钮：`bg-[#344E68] text-white p-2 rounded-lg
  hover:bg-[#2B4158] hover:-translate-y-[1px] shadow-sm`，图标
  `text-[18px]`（原实现是 `text-[20px]`，已按新稿改小）；`rounded-lg`
  引用的是 `tailwind.config.ts` 自定义后的 16px，不是 Tailwind 默认
  8px。**"停止生成"按钮新稿未提供样式**（该次截图不是流式中状态），
  按钮色保留品牌色 `brand-primary` 以维持语义区分，但同步应用了圆角/
  阴影/hover 位移等新稿通用交互效果，属于合理外推，不是凭空臆造数值。
- 底部提示文字：`text-[12px] text-[#94A3B8]`（原来是
  `text-text-muted`，已改任意色值）。
- **快捷 Chip（更正，2026-08-01 定向修正后的最终决定）**：此前记录为
  "新稿未出现该交互，保持现状不变"的空白项，已由用户明确裁定为
  **最终决定：不显示预设快捷问题**，四条预设文案已从 `Composer.tsx`
  整体移除（不是"暂时保留待确认"）。移除后输入框容器与消息区之间的
  间距由父级 `flex flex-col gap-3` 自动收拢，不需要额外调整 margin。

**验收**：与任务 1-6 相同标准——已用 `getComputedStyle` 核实输入框
圆角 12px/白底、发送按钮 `#344E68`/圆角 16px；四档视口下是否遮挡消息区
留给任务 8 统一核验。

## 任务 8：响应式与截图回归

- 断点核对表：`md`=768px（左栏）、`min-[1100px]`（右栏，自定义）、
  `lg`=1024px（主容器外边距 `m-4`→`m-8`，与右栏断点不是同一个阈值，
  实施与测试时不能混淆）。
- 四档视口 1920/1280/1024/375 全部截图，尝试保存到
  `frontend-workbench/specs/9.stitch-v2-visual-restoration/screenshots/
  {before,stitch-baseline,after}/`；如工具限制导致无法落盘，如实在
  报告中说明，不得假称已保存。
- 回归现有 161 个测试 + 3 个门禁 + 新增的图标加载测试与可见文本扫描
  测试，全部必须通过；`git diff --check`、冻结路径扫描同步执行。
- 检查 `.claude/rules/frontend-conventions.md`、`.claude/CLAUDE.md`
  中"全局 0 圆角"表述的同步更新（文档一致性，避免文档与代码脱节）。
