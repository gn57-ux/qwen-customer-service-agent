# Feature 5: workflow-integration — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |

## 项目架构

- 架构类型: 文档 + 一个只读分析脚本
- 涉及层: 文档（`mastra-agent/README-EXPERIENCE.md`）、CLI（复用
  Feature 1/3 的导出）

## 功能模块设计

### 模块 1: `README-EXPERIENCE.md`

结构参考现有 `README-RAG.md`（含"架构图（文字版）""Collection 对照表""
常用命令"等章节）：

```markdown
# Claude 工作流经验 RAG 学习闭环

## 架构

READ：任务描述 + stage + task_type + project_scope
  → 脱敏 → bge-m3 Embedding → claude_workflow_experience（Top20）
  → metadata 过滤 → Rerank（可用时）Top5 → 注入 Execute/Review 上下文

WRITE：Review ALLOW + 测试通过
  → 候选 Lesson（N5，status=candidate）
  → 脱敏 → 结构校验 → 去重 → 原子写入
  → N8 experience:finalize → status=verified → 可检索

## Collection 对照

| Collection | knowledge_set | 内容 | 状态 |
| ---- | ---- | ---- | ---- |
| customer_service_knowledge | customer-service | knowledge/repair | 使用中 |
| claude_workflow_experience | claude-workflow-experience | knowledge/experience | 本次新建 |

## 命令一览

（七个 experience:* 命令的用途、参数、示例）

## N1-N8 建议接入点

（逐节点说明，见 requirements.md F-002，此处展开为具体命令行示例）
```

### 模块 2: N1-N8 接入点文字说明（同一文件的一个章节，不新建独立文件）

每个节点给出**示例调用片段**（伪代码/命令行，不是要求全局文件立刻这样
改）：

```text
### N2/N3 示例
npm run experience:search -- \
  --query "{当前 task 描述}" --stage execute --task-type backend \
  --project-scope ai-kefu
→ 若 degraded=true，仍继续执行，只是不注入经验（不阻塞开发）
```

明确写一句边界声明：*"以上均为本仓库提供的稳定入口，是否/如何接线进
`~/.claude/commands/yd-ai-nodes/*.md` 由用户在验证后自行决定，本 feature
不修改任何全局文件。"*

### 模块 3: `experience-suggest-rules.ts`

```ts
const cfg = loadExperienceConfig();
const store = new ExperienceStore(cfg);
const threshold = Number(process.env.EXPERIENCE_RULE_THRESHOLD || 3);

// 复用 experience-audit.ts 已有的"扫描 knowledge/experience/**"逻辑
// （提取为共享函数，避免 Feature 3 与 Feature 5 各写一份文件扫描）
const candidates = allExperiences.filter(
  (e) => e.status === "verified" && e.occurrenceCount >= threshold
);

const entries = candidates.map((e) => {
  const redacted = redact(summarize(e));
  // ⛔ 必须检查 blocked，不能只读 .text——Codex Review 指出：
  // Token/Key/Cookie、原始聊天片段这两类命中时，redact() 按 Feature 1
  // design.md 的定义直接返回 blocked:true 且**不保证 .text 是安全替换
  // 后的文本**（这两类被认为"没有安全脱敏方式"，直接标记拒绝而不是
  // 替换）。若只读 .text 而忽略 blocked，未处理的敏感原文会被写进
  // 建议规则报告，正好绕开了防御性脱敏本该拦住的东西。
  if (redacted.blocked) {
    return { skipped: true as const, documentId: e.documentId, reason: "内容包含无法安全处理的敏感信息（Token/Key/Cookie 或疑似聊天原文），已跳过，不纳入建议报告" };
  }
  return {
    skipped: false as const,
    suggestedRule: redacted.text,
    evidence: { documentId: e.documentId, occurrenceCount: e.occurrenceCount, sourceFile: e.sourceFile },
  };
});

const report = entries
  .map((entry) => (entry.skipped ? renderSkippedBlock(entry) : renderMarkdownBlock(entry)))
  .join("\n\n");
// 被跳过的条目仍需要在报告里留痕（"某经验因敏感信息被排除"），但不
// 泄露具体命中内容本身——renderSkippedBlock 只输出 documentId + 原因，
// 不输出 summarize(e) 的任何片段。

await atomicWriteExperience( // 复用 Feature 1 的原子写入，不是新写一套
  // ⛔ 刻意不放在 knowledge/experience/** 之下——那是 experience:ingest/
  // rebuild/audit 的扫描根目录，报告落在同一棵树里会被误当成经验文档
  // 摄取（缺 frontmatter 会摄取失败）或误报 schema 校验失败（Codex
  // Review 发现的真实设计冲突，已修正）。
  path.join(repoRoot, "workflow-experience/suggested-rules", `${today}.md`),
  report,
);
```

**明确不写 `AGENTS.md`**——这是本模块唯一的硬约束，测试见 Feature 4
的 AGENTS.md 不变性模式，本 feature 补一条同类测试（AC-002）。

### 模块 4: `.claude/CLAUDE.md` 追加

按现有文件的"目录结构"章节格式追加一行（不改写其他内容）：

```markdown
- `mastra-agent/README-EXPERIENCE.md` — Claude 工作流经验 RAG 学习闭环
```

## 接口契约

`experience-suggest-rules.ts` 复用 Feature 1/2/3 的全部导出，不新增
对外接口。

## 数据模型

候选规则报告文件：`workflow-experience/suggested-rules/{YYYY-MM-DD}.md`，
纯 Markdown，无需 frontmatter（这不是要被摄取进 Qdrant 的经验文档，是
给人看的建议报告，按需在 `.gitignore` 里评估是否要提交进版本库——倾向
提交，作为决策留痕）。**该目录不在 `knowledge/experience/` 摄取根目录
之内，`experience:ingest`/`experience:rebuild`/`experience:audit` 均不
会扫描到它**，避免报告被误摄取或误报 schema 失败。

## 安全考虑

- 报告生成前对每条候选做防御性 `redact()`，即使理论上 `verified` 经验
  已经脱敏过。
- 报告文件本身路径固定在 `workflow-experience/suggested-rules/`（摄取
  根目录之外），不写入仓库其他位置，尤其不写 `AGENTS.md`。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 接入点文档形式 | 独立文件 vs README 内一个章节 | README 内章节——避免文档数量膨胀，且天然与"架构说明"放在一起便于对照阅读 |
| 建议规则报告是否提交进 git | 提交 vs gitignore | 提交——作为"哪些规则曾被建议、何时建议"的决策留痕，体积很小（纯文本），不是运行时产物 |
