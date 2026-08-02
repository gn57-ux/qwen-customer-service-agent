# yd 工作流接入模板

把已完成的 Claude 工作流经验 RAG 学习闭环（`mastra-agent/src/experience/`）接入
`~/.claude` 全局 yd 工作流的**可移植模板**。这份目录本身是本仓库内的存档副本，
不是 `~/.claude` 的直接软链或运行位置——`~/.claude` 在仓库之外，无法被 git 追踪，
真正生效的版本在用户本机的 `~/.claude/commands/**`；这里的副本供审查、版本管理、
以及未来分发给其它想接入同一套经验库的人。

## 包含文件

```
commands/
├── yd:init.md                   ← Step 1.5（分析项目后）新增可选检索
├── yd:prd.md                    ← Step 8（design.md 生成）新增可选检索
└── yd-ai-nodes/
    ├── N2-enter-feature.md      ← 新增"工作流经验 RAG — 跨项目检索（读端）"
    ├── N5-mark-done.md          ← 新增"工作流经验 RAG — 跨项目沉淀（写端）"
    └── N8-finish.md             ← 新增"工作流经验 RAG — 候选晋升（finalize）"
```

每个文件相对原版的改动都是**纯新增小节**，不改写、不删除任何既有内容——对照
`~/.claude/backups/experience-integration-<timestamp>/` 下的原版备份可逐字核对。

## 安装

1. 把上面 5 个文件对应复制到 `~/.claude/commands/`（覆盖同名文件）。
2. 在 shell profile（`~/.zshrc`/`~/.bashrc`）里设置：
   ```bash
   export YD_EXPERIENCE_REPO=/path/to/ai客服   # 指向本仓库的检出路径
   ```
3. 确保 `$YD_EXPERIENCE_REPO/mastra-agent` 下的 Qdrant/Ollama/Reranker 服务按
   `mastra-agent/README-EXPERIENCE.md` 的说明启动（可选——服务不可用时全部
   接入点会优雅降级，不影响原 yd 工作流本身）。

## 回滚

对照 `~/.claude/backups/experience-integration-<timestamp>/` 把对应文件复制回
`~/.claude/commands/`（含 `yd-ai-nodes/` 子目录）即可完全恢复到接入前状态；
每次改动前都先建新的时间戳备份，不覆盖旧备份。

## 设计要点

- **不修改 schema/枚举**：`stage`/`task_type`/`risk_level` 严格复用 Feature 1
  已冻结的枚举（`execute/review/qa/finish`、`frontend/backend/rag/model/
  data/git/docs/workflow`、`low/medium/high`），未新增 `init`/`prd` 专属
  stage——`/yd:init`/`/yd:prd`/N2 的检索统一用 `stage=execute`（"未来执行会
  用到的经验"这一语义在项目初始化/PRD 设计阶段同样适用），避免为了语义
  精确而改动已冻结的 Feature 1 校验逻辑。
- **降级提示统一为一条固定文案**（不是完全静默）：`YD_EXPERIENCE_REPO` 未
  配置、命令报错、非零退出等一切"本次不可用"的情形，统一输出一次：
  ```text
  经验增强本次不可用，已跳过，不影响当前工作流。
  ```
  不包含机器路径、端口、堆栈、环境变量的值或命令的原始报错文本。**"成功
  执行但召回为空"不算降级**（零结果是正常检索结果），不输出任何提示。
  N8 的"当次运行没有产生任何候选"也不算降级（多数运行本就不会产生可沉淀
  的经验），同样不输出提示，避免每次跑完都刷一行无意义信息。
- **不泄露真实路径到 `~/.claude`**：所有命令通过 `$YD_EXPERIENCE_REPO`
  环境变量间接引用仓库路径，`~/.claude/commands/**` 里不出现任何具体机器的
  绝对路径——环境变量本身在用户 shell profile 里配置，不在这份模板或
  `~/.claude` 任何文件内。
- **写端（N5）只产出 candidate，不自动晋升**：`experience:write` 写入的
  经验状态恒为 `candidate`；只有 N8 的 finalize 步骤才会把本次运行累积的
  候选批量晋升为 `verified`（可被检索）。这是 Feature 1 生命周期设计的
  既有约束，接入层没有绕过它的开关。
- **N8 finalize 的证据前提**：`codexVerdict`/`testsPassed` 固定传
  `ALLOW`/`true`，因为能走到 N8 说明本次运行里每个被标记 `[x]` 的 task
  都已经在 N4 拿到 `CODEX_REVIEW_ALLOW`——不存在"带着 BLOCK 的 task 混进
  候选列表"的情况，不是绕过校验的捷径。
- **N8 只在整批候选都拿到"已解决"终态时才清空 `.experience-pending.jsonl`**
  （Codex Review 发现的真实 bug，已修复）：`experience:finalize` 的退出码
  现在只要批次里有任何 `not_found`/`lock_lost`/`vectors_missing` 这类可
  重试的未决结果就非零；N8 只在退出码为 0 时才删除待处理清单——命令失败或
  部分候选未解决时保留文件，下次任意项目跑 N8 会重新尝试，不会永久丢失
  候选引用。
- **finalize 会核实向量点确实存在，不会在向量缺失时谎报晋升成功**
  （Codex Review 发现的真实 bug，已修复）：`experience:write` 在
  Embedding/Qdrant 不可用时会降级为"只写 Markdown、跳过摄取"；此时对应
  的 9 个向量点在 Qdrant 里根本不存在，而 Qdrant 的 `points/payload`
  更新接口对不存在的 id 静默忽略、不报错。`finalize.ts` 新增
  `store.pointsExist()` 核实，缺失时返回新的 `vectors_missing` 结果（不
  写 Markdown、不调用 `updatePayload`），需要先 `experience:rebuild` 或
  重新摄取才能真正晋升——避免"Markdown 说 verified，但搜不到"这种状态
  不一致。
- **新增的 `experience:write` CLI**（`mastra-agent/scripts/experience-write.ts`
  + 核心逻辑 `src/experience/write-and-ingest.ts` 的 `writeExperienceWithFallback()`）
  ：Embedding 服务不可达时只跳过向量摄取，Markdown 候选文档本身仍会正常
  落盘（下次 `experience:rebuild` 可补齐索引），不是"要么全部成功要么全部
  失败"。
- **增量 `experience:ingest` 会清理孤儿向量点，`--rebuild` 删除失败会
  中止**（Codex Review 发现的两个真实 bug，均已修复，间接影响 N5/N8
  背后的摄取行为，虽然接入点本身没有改动）：文档被删除、或编辑成无法
  通过校验的内容后，`experience:ingest`（不带 `--rebuild`）现在会核对
  Qdrant 现存点与当前合法文档集合，清理不再对应任何合法文件的孤儿点——
  之前旧向量（可能是 `verified`）会原样保留、继续可被检索。清理严格
  限定在 `claude_workflow_experience` 自己的 knowledge_set，不触达
  `customer_service_knowledge`。`--rebuild` 的 collection 删除步骤此前
  会吞掉所有失败（包括真实删除失败），现在只忽略"collection 本来就不
  存在"，真实失败会中止并非零退出，不再谎称已完成 rebuild。

## 已知边界（本轮未覆盖，非阻塞）

- N4（Review）、N6（QA）未新增经验相关步骤——PII 出站过滤、Codex Review
  仲裁等既有机制已经足够严谨，本轮判断这两个节点不需要额外接入点。

## Review 策略

默认一次完整 Review；仅在明确 BLOCK 时允许一次定向修复复审；达到约定轮次
后若仍有问题，停止并向用户汇报未决项，不进入无限修复循环。
