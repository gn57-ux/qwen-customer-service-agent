# N5: 标记完成

**强制，不可跳过。** 遗漏会导致断点恢复时重复执行任务。

## 步骤

1. 用 Edit 工具打开 tasks.md，找到当前任务对应的行
2. 将 `- [ ]` 改为 `- [x]`，**仅改 checkbox，不改其他内容**
3. **立即验证**：改完后重新读取 tasks.md，确认该任务确实已标记为 `[x]`

```diff
- - [ ] T-007: 安装依赖 ~5min
+ - [x] T-007: 安装依赖 ~5min
```

## 关键约束

- 每完成一个 task **立即标记**，不批量、不延后
- Edit 失败则重试直到成功
- `/clear` 之前必须确认标记已写入

## Learning Loop — 沉淀经验（写端）

如有值得记录的内容（踩坑、难点、架构决策、可复用封装），**双写**：

1. **`{SPECS_DIR}/LESSONS.md`**（全量时间线，N1 会整份加载）：追加一条 `## {日期} — {Feature名} / {Task标题}`。
2. **结构化 Memory**（供 N2 未来 feature 精确检索，这是自学习闭环的「写」端，对应 N2 的「读」端）：
   - 位置：`{SPECS_DIR}/memory/{kebab-slug}.md`，每条经验一个文件
   - 索引：写完在 `{SPECS_DIR}/memory/INDEX.md` 追加一行 `- [{标题}]({slug}.md) — {一句话钩子} | tags: {tag1,tag2}`（N2 检索先扫这个索引）
   - 文件格式（frontmatter 让 N2 可按 feature/类型/标签检索）：

```markdown
---
title: {简短标题}
feature: {来源 feature 名}
type: pitfall | decision | reusable | env
tags: [{关键词，便于检索：模块名/技术栈/错误类型}]
date: {YYYY-MM-DD}
---

**问题/场景**：…
**解法/结论**：…
**复用方式**：（reusable 类必填——别的 feature 怎么直接拿来用）
```

**记录什么**：架构决策及理由、踩坑记录、跨 feature 影响、环境/依赖特殊处理、可复用封装。
**不记录**：常规开发、显而易见的事情。
**已存在相近条目** → 更新该 Memory 文件，不新建重复（LESSONS.md 一侧仍按时间顺序追加，不去重）。

## 工作流经验 RAG — 跨项目沉淀（写端，可选，与上方 Learning Loop 互不替代）

上方的 LESSONS.md/memory/ 是**本 specs 目录内**的记录；如果这条经验**跨项目通用**（不是本项目特有的业务细节），额外投稿到跨项目经验库，供其它项目未来在 N2 检索到。**只在上方 Learning Loop 判定"有值得记录的内容"时才做这一步；上方判定不记录，这里也不做。**

1. **前置判断**：`YD_EXPERIENCE_REPO` 未设置或目录下无 `mastra-agent/package.json` → 输出一次标准降级提示（同 N2 节点文件「降级提示」定义），跳过本节其余步骤。
2. 已配置时，把刚写入 memory/{slug}.md 的内容改写成经验文档正文——**第一行必须是一级标题 `# {标题}`，在所有二级标题之前**（schema 强制校验，缺失会被拒绝写入），之后是 9 个固定二级标题（内容从 memory 条目扩写，不需要重新构思）：
   ```text
   # {经验标题}
   ## 触发场景      ← memory 的"问题/场景"
   ## 问题表现       ← 具体报错/异常表现，无则简述影响
   ## 错误做法       ← 走过的弯路，无则写"无，直接采用正确做法"
   ## 根因           ← 为什么会这样
   ## 正确处理       ← memory 的"解法/结论"
   ## 验证方法       ← 怎么确认解法有效（测试/复现步骤）
   ## 适用范围       ← memory 的"复用方式"，或本 task 涉及的模块/技术栈
   ## 不适用范围     ← 不确定就写"暂无已知例外"
   ## 可提升为稳定规则的条件  ← 什么情况下值得写进 AGENTS.md/CLAUDE.md，不确定就写"待更多项目验证后再评估"
   ```
3. 构造 JSON 写入临时文件（**不要用 `<(...)` 进程替换传给 `--input`**——`npm run` 转发子进程时 fd 不总能存活到 `node` 读取的时刻，实测会报 `Unexpected end of JSON input`；用 Write 工具写一个真实临时文件最可靠），`title` 用 memory 条目标题；`stage` 固定 `execute`；`taskType` 按本 task 工种：前端→`frontend`，后端/合约→`backend`，数据库→`data`，文档→`docs`，其余→`workflow`；`projectScope` 用 `PROJECT_NAME`；`riskLevel` 按本 task 是否涉及认证/支付/数据完整性等敏感操作：涉及→`medium`/`high`，普通业务逻辑→`low`；`source` 固定 `"yd:ai N5"`；`body` 第一行必须是 `# {标题}\n`：
   ```json
   {"title":"...","stage":"execute","taskType":"...","projectScope":"...","source":"yd:ai N5","riskLevel":"...","body":"# {标题}\n## 触发场景\n...\n\n## 问题表现\n...\n\n## 错误做法\n...\n\n## 根因\n...\n\n## 正确处理\n...\n\n## 验证方法\n...\n\n## 适用范围\n...\n\n## 不适用范围\n...\n\n## 可提升为稳定规则的条件\n..."}
   ```
   ```bash
   cd "$YD_EXPERIENCE_REPO/mastra-agent" && npm run experience:write -- --input {临时文件路径}
   ```
4. **失败/非零退出（含"内容命中脱敏拦截被拒绝"）** → 输出一次标准降级提示，不重试、不暂停、不影响 N5 其余步骤——这条通道失败绝不能拖慢或阻塞主任务的完成标记。
5. 成功（`ok=true`）时，从输出里取 `document_id`，追加一行到 `{SPECS_DIR}/.experience-pending.jsonl`（不存在则新建；这是本次 `/yd:ai` 运行的临时候选清单，供 N8 finalize 用，不是产物，不需要提交）。
6. 输出提示（仅在本节实际写入成功时输出）：`🌐 跨项目经验候选已提交：{document_id}`。

> 这一步只产生 `candidate` 状态，**不会**自动变成会被检索到的 `verified` 经验——晋升统一在 N8 做一次性 finalize（见 N8 节点文件），不在这里现场判断。

```text
✅ Feature {F}/{总F} | 任务 {N}/{总数} — {标题}
🔍 AI review: {结果} | 🤖 Codex review: {结果}
📊 Feature {done}/{total} | 总体 {done_f}/{total_f}
```

## 自动提交与续跑

仅在收到 `CODEX_REVIEW_ALLOW` 后执行：

1. 运行当前 Feature 规定的测试、`git diff --check` 和禁改路径检查。
2. 根据当前 Feature 的 tasks/specs 精确列出文件并逐项 `git add`；禁止 `git add .` 与 `git add -A`。
3. 用单一职责提交信息 commit 当前 Feature；不得夹带其他 Feature、运行时产物、模型或用户无关文件。
4. commit 后立即继续 N6/N7 与下一个可执行 Feature，不在这里停下等待用户。
5. 默认不 push、不合并 main；只有原始目标明确授权才可执行。
