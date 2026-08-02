# Feature 5: workflow-integration — 需求规格

## 概述

**只在本仓库内**编写"N1-N8 / Stop Hook 应如何调用 Feature 3 的 CLI 命令"
的接入说明文档，以及一个"建议升级为 AGENTS.md 规则"的候选生成器（只
生成建议文本，不自动修改 `AGENTS.md`）。**本 feature 不修改任何
`~/.claude/**` 全局文件**——这是 PLAN.md 已记录的架构边界决定。

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 内文档 + 一个小型只读分析脚本

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始需求 |

## 用户故事

- 作为未来决定是否要把经验检索正式接线进全局 `yd:ai` 工作流的用户，
  我想要一份清晰的"每个节点该调用什么命令、传什么参数、拿到什么输出"
  的文档，以便自己动手接线或者委托给未来的会话去做，而不需要重新
  设计一遍。
- 作为担心 `AGENTS.md` 被意外污染的用户，我想要"稳定规则候选"只是
  一份建议报告，由我自己决定是否采纳，而不是被自动写入。

## 功能需求

1. [F-001] 编写 `mastra-agent/README-EXPERIENCE.md`（对齐现有
   `README-RAG.md`/`README-AGENT.md`/`README-CLIENT.md` 的文档风格），
   说明整套经验子系统的架构、READ/WRITE 流程图（文字版）、七个 CLI
   命令的用途与参数。
2. [F-002] 编写接入说明章节，逐节点给出"建议调用点"（不是强制脚本，
   是给未来会话看的说明）：
   - N1：可选调用 `experience:status`，仅打印健康状况，失败不阻塞。
   - N2/N3：调用 `experience:search` 检索 execute 阶段经验，注入结果
     长度受限（Feature 2 已实现），检索失败按 graceful degrade 处理。
   - N4：调用 `experience:search --stage review`，用 diff 摘要作为
     query，与 Execute 阶段的检索结果分开注入。
   - N5：只记录候选（调用 Feature 1 的 `upsertExperience` 生成
     `candidate` 状态经验），不调用 `finalize`。
   - N6：QA 结果作为补充证据，追加到候选经验的"验证方法"节（如何
     追加、由谁触发，写清楚但不在本 feature 内实现自动追加逻辑——
     属于"调用现有能力的时机说明"，不新增能力）。
   - N8：调用 `experience:finalize`，只有 ALLOW 且门禁通过才真正
     执行；输出的统计数字纳入 N8 现有的"总结"输出格式。
3. [F-003] "建议升级为 AGENTS.md 规则"候选生成器
   （`experience-suggest-rules.ts`）：扫描 `status=verified` 且
   `occurrence_count` **达到或超过**阈值（即 `>=`，可配置，默认 3——
   与 AC-003/design.md 的比较符号保持一致，避免"恰好等于阈值"的边界
   情况因文档表述不一致而在实现时产生分歧）的经验，生成一份
   Markdown 报告列出"候选规则文本 + 支持证据（哪些经验、出现几次）"，
   **只写到 `workflow-experience/suggested-rules/` 目录下**（刻意放在
   `knowledge/experience/` 摄取根目录**之外**——Codex Review 指出若报告
   落在同一目录树下，`experience:ingest`/`experience:rebuild` 会把它当
   经验文档尝试摄取、`experience:audit` 会把它当 schema 校验失败来报告，
   而它本来就没有 frontmatter，两边职责会互相干扰），不碰 `AGENTS.md`
   本身，报告里明确写"以下为建议，需人工审阅后手动写入 AGENTS.md"。
   生成前对每条候选内容调用 `redact()` 防御性再扫描，**`blocked:true`
   的候选必须整条排除出报告**（不能只取 `.text` 而忽略 `blocked`——
   Token/Key/Cookie、疑似聊天原文这两类命中时 `.text` 不保证是安全
   替换后的文本，见 Feature 1 的脱敏设计），报告里对被排除的候选只
   留痕 `document_id` + 排除原因，不回显命中内容本身。
4. [F-004] README/CLAUDE.md 同步：本仓库的 `.claude/CLAUDE.md` 需要
   追加一行指向 `README-EXPERIENCE.md` 的引用（遵循现有"目录结构"
   章节的风格，只追加不改写既有内容）。

## 非功能需求

- 安全: 候选规则生成器的输出报告同样要经过 Feature 1 的 `redact()`
  处理（虽然理论上 `verified` 经验已经脱敏过，但"防御性再扫一次"
  成本很低，避免任何遗漏累积到规则建议报告里）。

## 验收标准

- [ ] [AC-001] `README-EXPERIENCE.md` 存在且包含七个命令的用途说明与
  N1-N8 逐节点的建议调用点。
- [ ] [AC-002] 运行 `experience-suggest-rules.ts` 后，`AGENTS.md`
  文件内容/存在性不变（复用 Feature 4 的 AGENTS.md 不变性测试模式）。
- [ ] [AC-003] 候选规则报告只包含 `occurrence_count >= 阈值` 的
  `verified` 经验，`candidate`/`deprecated` 状态的经验不出现在报告里。
- [ ] [AC-004] `.claude/CLAUDE.md` 的既有章节内容逐字不变，只新增了
  指向 `README-EXPERIENCE.md` 的一行引用。
- [ ] [AC-005] 构造一条含 Token 样式字符串的 `verified` 候选经验，运行
  `experience-suggest-rules.ts` 后该条不出现在报告的建议规则里，报告
  中该 `document_id` 对应条目只显示"已跳过"及原因，不含原始 Token
  片段。

## 依赖

- Feature 3（CLI 命令，文档描述如何调用它们）。
- Feature 1（`redact()`，用于候选规则报告的防御性脱敏）。

## 开放问题

- 是否/何时把本 feature 产出的接入说明正式落实为对
  `~/.claude/commands/yd-ai-nodes/*.md` 的真实修改，由用户在验证过
  本仓库这套子系统后自行决定，不在本 feature 范围内。
