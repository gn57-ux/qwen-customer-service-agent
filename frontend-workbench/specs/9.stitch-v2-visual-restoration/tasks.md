# Feature 9: Stitch v2 视觉还原 — 任务清单

约定：每个任务完成后立即在真实浏览器截图核验（1920px 至少），不等全部
任务做完再检查；发现不合格立即修正本任务再进入下一个。全部任务共用的
硬性底线：不改 `mastra-agent/**`/契约/业务逻辑；保留 161 个现有测试与
3 个门禁；单元测试通过但截图不合格 = 任务失败。

- [x] 0. 全局 token 准备：更新 `tailwind.config.ts`（圆角/boxShadow/
      body-md 行高），更新 `styles.css`（移除全局 0 圆角规则、新增
      `.glow-blue`/`.glow-green`/`.bg-gradient-page`），`npm run
      typecheck && npm run build` 通过
- [x] 1. 字体与图标加载修复：`useIconFontReady` 直接遍历 `document.fonts`
      查找 `family` 精确匹配且 `status==="loaded"` 的 `FontFace`（不用
      `FontFaceSet.check()`，其语义在三轮 Codex Review 中被证明不可靠）+
      styles.css 静态扫描测试 + 真实浏览器核验 `icons-ready`/opacity/
      `document.fonts` 状态，颜色/圆角/阴影：不涉及（本任务只管字体
      加载时序）
- [x] 2. 全局背景与主容器质感：光晕装饰 + 主容器留白/圆角 16px/
      合并后的组合阴影（`shadow-main`+`shadow-inner-top` 并列不会叠加，
      已在 styles.css 合并成一个值，见 design.md），1920px/1000px 实测
      对称留白（32px/16px）、无横向溢出（`w-full`+margin 组合曾导致
      裁切，已改用 `calc()` 显式宽度修复，Codex Review 定位）
- [x] 3. 顶栏视觉还原：高度 64px、`backdrop-blur-md`、边框透明度
      60%、状态点辉光（仅在线态）、清空按钮 `rounded-md`，
      `getComputedStyle` 核实高度/圆角/box-shadow
- [x] 4. 左栏视觉还原：宽度 220px、新建会话按钮圆角 10px、选中态
      左边框 3px + 右侧圆角 6px（design.md 更正：非 12px）+ 内部高光，
      未选中项四角圆角 6px（Codex Review 发现并修复：曾与选中态共用
      `rounded-r-md` 导致未选中项左侧方角；曾用 `w-full`+`ml-[3px]`
      导致溢出侧栏 3px，已改 `w-[calc(100%-3px)]`）
- [x] 5. 中间消息与安全卡片还原：用户气泡不对称圆角
      `12px/12px/12px/4px`、渐变背景、`px-5 py-3.5`（Codex Review 发现
      并修复：曾遗留旧的 `px-6 py-4`）；安全卡改用新稿独立配色
      （`#F2C5BE`/`#FDF5F3`/`#C55B51`，非旧 `safety-*` token），实测
      `getComputedStyle` 核实 padding/圆角/背景渐变均正确
- [x] 6. 右栏证据面板还原：固定宽度 320px（移除旧 xl 前 300px 中间态，
      断点 `min-[1100px]`）、引用卡片白底+圆角 12px+`#E2E8F0`边框+
      hover 阴影加深、高优先级边框统一为 `#C55B51`（与 SafetyCard 一致）
- [ ] 7. 输入区还原：先用 Stitch MCP 重新定位输入区真实 HTML 片段，
      再实施，四档视口下不遮挡消息、发送按钮无图标闪烁
- [ ] 8. 响应式与截图回归：1920/1280/1024/375 四档截图（尝试落盘，
      工具限制如实说明）、161+新增测试全绿、3 门禁通过、
      `git diff --check`、冻结路径扫描、`.claude/` 文档同步更新
      "全局 0 圆角"表述

## 提交前汇总要求（对应本轮硬性要求）

- [ ] 最终提交前汇总三组截图路径：修改前 / Stitch 基准 / 修改后
- [ ] 经过 Codex Stop Hook Review 自动修正至 ALLOW 后再提交
- [ ] 不 push，停在 Review 点汇报
