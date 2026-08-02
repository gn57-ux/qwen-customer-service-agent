# Claude 工作流经验 RAG 学习闭环说明

一个独立于客服知识库的第二条 RAG 管线：把 `/yd:ai` 工作流每一轮开发中
真正踩过、验证过的坑沉淀成结构化经验 Markdown，向量化入库，供未来相似
任务在 Execute/Review 阶段自动检索、注入上下文。

**只在本仓库内提供稳定 CLI 入口**——是否/如何把这些命令接线进
`~/.claude/commands/yd-ai-nodes/*.md`，由用户在验证过本仓库这套子系统
后自行决定，**本 feature 不修改任何全局 `~/.claude/**` 文件**（见
`workflow-experience/specs/PLAN.md` 已记录的架构边界决定）。

---

## 1. 架构

```text
READ（Execute/Review 阶段自动检索）
  任务描述 + stage + task_type + project_scope
    → redact() 脱敏（blocked 时直接跳过，不发往 Embedding 服务）
    → bge-m3 Embedding
    → claude_workflow_experience（Top20，metadata 过滤在同一次
       Qdrant 请求里下推：stage/task_type/project_scope/risk_level/
       status=verified）
    → 按 document_id 去重聚合（每份经验对应 9 个小节 chunk）
    → Reranker 可用时 Rerank 取 Top5；不可用时按向量分数取 Top5，
      明确标注 degraded（不冒充完成 Rerank）
    → 跨小节文档组装（问题表现+根因/正确处理/验证方法）
    → formatForInjection() 长度裁剪
    → 注入 Execute/Review 上下文

WRITE（N5 记录候选 → N8 门禁通过才晋升）
  N5：本轮开发/审查产出的教训
    → redact() 强制脱敏（Token/Key/Cookie/聊天原文命中直接拒绝写入）
    → 结构校验（9 个固定二级标题）→ 去重（相同内容只 +1 计数，
      内容变化才递增版本并归档旧版本）→ 原子写入 → status=candidate
    → 同步摄取向量（失败不回滚 Markdown，只是"暂时没有索引"）
  N8：codexVerdict=ALLOW 且测试通过
    → experience:finalize → candidate 转 verified（同一把 Feature 1
      写入锁内完成"读现状→校验→转换→写回"全程，不是只锁最后写入）
    → 向量点 payload 局部更新 status，不重新 embedding
    → verified 之后才会出现在默认检索结果里
```

## 2. Collection 对照

| Collection | knowledge_set | 内容根目录 | 状态 |
| ---- | ---- | ---- | ---- |
| `customer_service_knowledge` | `customer-service` | `knowledge/repair` | 使用中，**与本子系统物理隔离**（独立 Collection + 独立 knowledge_set 双重保险） |
| `claude_workflow_experience` | `claude-workflow-experience` | `knowledge/experience` | 本子系统新建 |

两者共享同一套 Qdrant/Embedding/Reranker 服务实例，物理隔离靠**独立
Collection**——即使查询代码有 bug 忘记加 filter，独立 Collection 本身
也不可能查到对方的数据。

## 3. 命令一览

```bash
cd mastra-agent

npm run experience:ingest              # 批量摄取 knowledge/experience/**/*.md
npm run experience:ingest -- --rebuild # 先清空 collection 再全量重建
npm run experience:rebuild             # 上一条的别名
npm run experience:search -- \
  --query "..." --stage execute \
  [--task-type backend] [--project-scope xxx] [--scope-mode project-only]
                                        # 命令行调试检索效果
npm run experience:status              # 三项服务连通性 + 按 status 分组的经验数量
npm run experience:audit               # 只读巡检：frontmatter 校验/脱敏扫描/孤儿文件/悬空向量点
npm run experience:finalize -- --input result.json
                                        # N8 专用：candidate → verified（JSON 输入，见下）
npm run experience:test                # 纯逻辑测试，无需真实服务，可完全断网跑（已实测验证）
npm run experience:test:live           # 需要真实 Qdrant/Ollama/Reranker 在线的端到端测试
```

`experience:finalize` 的 JSON 输入形状（`FinalizeInput`，见
`src/experience/finalize.ts`）：

```json
{
  "codexVerdict": "ALLOW",
  "testsPassed": true,
  "privacyOrSecretHit": false,
  "candidateDocumentIds": ["<document_id>", "..."],
  "evidence": { "before": "问题描述", "after": "验证描述" }
}
```

`experience:status`/`experience:audit` 是巡检命令，任一依赖服务不可用
只在对应字段标注"离线"，命令本身不失败（退出码始终 0）；
`experience:ingest`/`experience:search` 在依赖服务完全不可用时会明确
报错/标注 `degraded`，不会静默产出误导结果。

配置全部走环境变量，缺省值见仓库根 `.env.example`：
`EXPERIENCE_QDRANT_COLLECTION`/`EXPERIENCE_KNOWLEDGE_SET`/
`EXPERIENCE_KNOWLEDGE_ROOT` 三个变量独立于客服知识库的
`QDRANT_COLLECTION`/`KNOWLEDGE_SET`/`KNOWLEDGE_ROOT`，
`QDRANT_URL`/`EMBEDDING_BASE_URL`/`EMBEDDING_MODEL`/`RERANK_BASE_URL`
与客服知识库共享同一套基础设施地址。

## 4. N1-N8 建议接入点

以下均为**本仓库提供的稳定入口示例**，不是要求全局文件立刻这样改——
是否/如何接线进 `~/.claude/commands/yd-ai-nodes/*.md` 由用户在验证后
自行决定，本仓库这套子系统本身不修改任何全局文件。

### N1（可选）

```bash
npm run experience:status
```

只打印健康状况，失败不阻塞 N1 后续步骤。

### N2/N3（Execute 阶段检索）

```bash
npm run experience:search -- \
  --query "{当前 task 描述}" --stage execute \
  --task-type backend --project-scope ai-kefu
```

`degraded=true` 时仍继续执行 N2/N3，只是不注入经验，不阻塞开发。

### N4（Review 阶段检索）

```bash
npm run experience:search -- \
  --query "{本轮 diff 摘要}" --stage review \
  --task-type backend --project-scope ai-kefu
```

用 diff 摘要作为 query，与 Execute 阶段的检索结果分开注入，不合并成
一次检索。

### N5（只记录候选，不 finalize）

调用 `upsertExperience()`（`src/experience/write.ts`，经 Feature 1 31
轮 Codex Review 加固）生成 `status=candidate` 的经验，**不调用
`experience:finalize`**——候选此时不会出现在默认检索结果里。

### N6（QA 结果作为补充证据）

QA 结果建议追加到候选经验的"验证方法"节——**本 feature 只说明这个
时机，不实现自动追加逻辑**：如何追加、由谁触发，属于调用现有能力
（`upsertExperience()` 对同一 `document_id` 的更新会走版本递增路径）
的时机说明，不新增能力。

### N8（门禁通过才晋升）

```bash
npm run experience:finalize -- --input result.json
```

只有 `codexVerdict=ALLOW` 且门禁通过才真正执行晋升；输出的"新增
verified / 已是 verified / 保持 candidate"统计数字建议纳入 N8 现有的
"总结"输出格式。

## 5. 候选规则生成器

```bash
npm run experience:suggest-rules
```

扫描 `status=verified` 且 `occurrence_count >= 阈值`（默认 3，可用
`EXPERIENCE_RULE_THRESHOLD` 覆盖）的经验，生成一份 Markdown 报告到
`workflow-experience/suggested-rules/{YYYY-MM-DD}.md`——**只生成建议，
不自动写入 `AGENTS.md`**，报告里明确写"以下为建议，需人工审阅后手动
写入 AGENTS.md"。报告目录刻意放在 `knowledge/experience/` 摄取根目录
**之外**，不会被 `experience:ingest`/`rebuild`/`audit` 误扫描。

生成前对每条候选内容做防御性 `redact()` 再扫描：命中 Token/Key/
Cookie/疑似聊天原文的候选整条排除出报告，报告里只留痕 `document_id` +
排除原因，不回显命中内容本身。

## 6. 边界声明

- 本子系统与客服知识库物理隔离（独立 Collection），互不影响。
- `knowledge/experience/` 目录不存在或相关服务不可达时，
  `experience:*` 命令自身报错/降级，但**不影响**宿主项目其他现有命令
  （`npm run dev`/`npm test` 等）——已在 Feature 4 quality-gates 实测
  验证（完全断网、Qdrant/Ollama 均未启动时，`experience:test` 纯逻辑
  部分 188/188 全部通过）。
- 本子系统不修改 `AGENTS.md`，不修改任何 `~/.claude/**` 全局文件。
