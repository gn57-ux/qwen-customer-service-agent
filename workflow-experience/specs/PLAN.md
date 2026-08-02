# 开发计划索引 — Claude 工作流经验 RAG 学习闭环

## 背景

目标不是一次性完成的选修作业，而是让 `~/.claude` 下的 `yd:init`/`yd:prd`/`yd:ai`/
`yd:audit`、N1-N8、`/goal` 和 Stop Hook 在**未来任意项目**里都能自动检索历史
经验、任务完成后沉淀新经验、持续改善 Execute 与 Review 质量。

**代码项目**：`/Users/ruolan/Documents/ai客服`（主要落地在 `mastra-agent/`，
经验文档落在 `knowledge/experience/`）。
**已确认的架构前提**（只读调研结论，见方案报告）：
- `mastra-agent/src/rag/{config,embedding,markdown,rerank}.ts` 的摄取/embedding/
  rerank 逻辑本来就是跨 domain 通用的，`README-RAG.md` 里已预留
  `claude_workflow_experience`（"将来整理的 `knowledge/experience/*.md`，尚未创建"）
  这条线——本次是填补既有规划的空白，不是新建架构。
- 唯一不能直接复用的是 `QdrantKnowledgeStore` 构造函数硬编码的 Mastra
  vector id（`"customer-service-knowledge"`），需要一个平行的 `ExperienceStore`
  类，换成独立 id，避免同进程内两个 Collection 的向量库实例冲突。
- **全局 `~/.claude/commands/**` 本轮不修改**——只在本仓库内提供稳定 CLI 入口
  + 接入文档，全局工作流是否正式接线由用户后续验证后决定，保证"新项目没有
  experience 配置时原工作流仍可运行"这条硬性要求天然成立。

## 本次 PRD（2026-08-01）切分为 5 个 feature

| 序号 | feature | 说明 | 依赖 | 状态 |
| ---- | ------- | ---- | ---- | ---- |
| 1 | data-model | 经验 Markdown 数据模型、脱敏、原子写入+锁、去重/幂等/occurrence_count/content_hash/supersedes、生命周期状态机（candidate/verified/deprecated） | - | 待开发 |
| 2 | store-retrieval | 独立 Qdrant Collection（`ExperienceStore`）、复用 embedding/rerank、Top20→metadata 过滤→Rerank Top5→降级、格式化注入（含长度限制） | 1 | 待开发 |
| 3 | cli-commands | `experience:{ingest,search,test,status,audit,rebuild,finalize}` 七个命令 + 跨项目可移植性（环境变量覆盖、无固定用户名/路径、中文路径、找不到子系统自动降级） | 1, 2 | 待开发 |
| 4 | quality-gates | 22 项质量/安全门禁测试落地（隔离性、幂等、去重、并发锁、生命周期过滤、脱敏扫描、降级路径、Hook 边界等） | 1, 2, 3 | 待开发 |
| 5 | workflow-integration | 仅本仓库内文档：N1-N8/Stop Hook 如何调用上述 CLI 入口的接入说明；"建议升级为 AGENTS.md" 候选生成器（只生成建议，不自动写入） | 3 | 待开发 |

**推荐执行顺序**：1 → 2 → 3 →（4、5 可并行，均只依赖 1-3）

## ID 编号约定

- 功能需求 / 任务 / 验收标准 ID **在单个 feature 内编号**，跨 feature 用
  `{序号}.` 前缀区分。例：`2.T-001` = 序号 2 这个 feature 的 T-001。
- 跨 feature 依赖写全限定 ID，如 `3.T-001 依赖 2.T-004`。

## 开放问题（已向用户确认或明确记录为技术选型，非阻塞）

1. **N1-N8 集成是否修改全局 `~/.claude/commands/**`？** → 本轮按推荐方案
   **不修改**，仅本仓库提供 CLI + 文档（见 feature 5），除非用户后续明确要求
   接线全局文件。
2. **Stop Hook 重入保护/幂等键** → 不修改 `codex-review-on-stop.js`，并发
   安全完全由 `experience:finalize` 自身的文件锁承担（技术选型，非业务歧义）。
3. **`knowledge/` 冻结例外** → 用户本轮明确指示经验文档存
   `knowledge/experience/`，视为对 `.claude/CLAUDE.md` 冻结范围的明确例外，
   严格限定不触碰 `knowledge/repair/` 等既有内容。
