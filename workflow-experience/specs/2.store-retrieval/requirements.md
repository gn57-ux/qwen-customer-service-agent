# Feature 2: store-retrieval — 需求规格

## 概述

在独立的 Qdrant Collection `claude_workflow_experience` 中建立向量存储，
复用现有 bge-m3 Embedding 与 Reranker 服务，实现"写入经验时自动向量化
入库"与"按 stage/task_type/project_scope/risk_level/status 过滤 + 语义
检索"的完整 READ/WRITE 打通，并把检索结果格式化为可直接注入 Execute/
Review 上下文的精简文本。

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 内新增子模块，依赖 Feature 1 的数据模型与写入函数

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始需求 |

## 用户故事

- 作为 `/yd:ai` 的 N2/N3 执行阶段，我想要根据当前 task 描述自动召回 3-5
  条最相关的历史经验，以便少走前人已经踩过的坑。
- 作为 N4 Review 阶段，我想要用 diff 摘要单独检索"审查类"经验，以便
  Codex Review 前置上下文更聚焦。
- 作为经验库运维者，我想要客服知识库与工作流经验库物理隔离，以便任何
  一边的故障或误操作都不会影响另一边。

## 功能需求

1. [F-001] 独立 Qdrant Collection：`claude_workflow_experience`，
   `knowledge_set=claude-workflow-experience`，向量维度与客服知识库一致
   （bge-m3 实测维度，当前 1024），复用同一个 Qdrant 服务实例（同 server
   多 collection），不新建 Qdrant 部署。
2. [F-002] `ExperienceStore` 类：接口形状对齐 `KnowledgeStore`（复用
   `health`/`describe`/`createIndex`/`upsert`/`query`/`listPoints`/
   `countPoints` 等方法签名，便于未来统一测试模式），但**独立实现**
   （不修改 `rag/store.ts`），构造时使用独立的 Mastra vector id（如
   `"claude-workflow-experience"`）避免与客服知识库的 vector 实例冲突。
3. [F-003] 摄取：经验 Markdown 写入成功（Feature 1 的 `upsertExperience`
   完成后）→ 对正文分块（复用或参考 `rag/markdown.ts` 的分块策略，经验
   文档结构固定为 9 节，可以按二级标题整节切块，不需要复杂的
   合并/拆分逻辑）→ Embedding → upsert 到 `claude_workflow_experience`。
   `deprecated` 状态的经验对应向量点需要打上 `status=deprecated` payload
   字段（不删除向量，检索侧过滤即可，保留可审计性）。
4. [F-004] 检索管线：输入（任务描述 + stage + task_type + project_scope）
   → 脱敏（复用 Feature 1 的 `redact()`）→ Embedding → 向量 Top20 →
   按 metadata（stage/task_type/project_scope/risk_level/status=verified）
   过滤 → Reranker 可用时 Rerank 取 Top5，不可用时**明确标注
   degraded**（不得把向量分数排序冒充 Rerank 结果）→ 最终注入 3-5 条。
5. [F-005] `project_scope` 过滤语义：请求可指定"仅当前项目"或"当前项目 +
   global"，不支持"仅 global"（当前项目内检索天然应该包含全局通用经验）。
   `RetrieveQuery` 必须提供显式字段（`scopeMode`）表达这两种模式，不能
   只有"当前项目 + global"一种硬编码行为，否则"仅当前项目"这一模式在
   契约层面无法被调用方使用（Codex Review 第十一轮指出的契约缺口）。
6. [F-006] 格式化注入：每条结果必须包含 title、lesson summary、correct
   action、verification method、source file、document_version、
   relevance score 七项；总注入长度有上限（字符数），超限时按
   relevance score 从低到高裁剪，不得裁剪到语义不完整（裁剪单位是
   "整条经验"，不是截断单条经验内部文本）。
7. [F-007] 隔离性：任何摄取/检索操作都不得读取、修改、删除
   `customer_service_knowledge` collection 或其 `customer-service`
   knowledge_set 的数据。
8. [F-008] Embedding/Qdrant/Reranker 不可用时的降级契约**必须区分两种
   不同严重程度**（Codex Review 指出：笼统写"任一不可用都返回空结果"
   与 F-004/AC-003 要求的"Reranker 不可用时仍返回向量排序结果"直接
   矛盾，两条需求不能同时按字面实现）：
   - **Embedding 或 Qdrant 不可用**：检索**无法执行**（没有向量、或
     无法查询向量库），返回空结果 `{ lessons: [], degraded: true,
     degradedReason: "embedding_unavailable" | "qdrant_unavailable" }`。
   - **仅 Reranker 不可用**：检索**仍可执行**（向量检索本身不依赖
     Reranker），返回按向量分数排序的 Top 3-5 条结果，
     `{ lessons: [...], degraded: true, degradedReason:
     "reranker_unavailable" }`——不是空结果。
   无论哪种情况都不得抛出未捕获异常导致调用方（N2/N3/N4）阻塞。

## 非功能需求

- 性能: 单次检索（含 embedding + 向量检索 + rerank）应在 3 秒内完成
  （与现有客服 RAG 检索的量级一致）。
- 安全: 检索输入同样要走脱敏（任务描述里可能包含被检索方不该看到的
  敏感信息，即使只是本地日志/注入文本也要脱敏）；脱敏结果为
  `blocked: true` 时（命中密钥类或疑似聊天原文），**必须在调用
  Embedding 服务之前拦截**，不得把未经安全处理的原始输入发往可配置
  地址的外部 Embedding 服务或其日志。
- 兼容性: `ExperienceStore`/检索函数不依赖固定用户名或 `/Users/ruolan`
  路径，Qdrant/Embedding/Rerank 服务地址均可通过环境变量覆盖（复用
  `rag/config.ts` 的环境变量读取模式）。

## 验收标准

- [ ] [AC-001] 摄取一条 `verified` 状态的经验后，向量点成功写入
  `claude_workflow_experience`，`customer_service_knowledge` 的点数量
  和内容不变（真实对比摄取前后计数）。
- [ ] [AC-002] 检索请求带 `status=verified` 过滤时，`candidate`/
  `deprecated` 状态的经验不出现在结果里。
- [ ] [AC-003] Reranker 服务不可用时，检索仍返回结果（基于向量分数），
  且返回对象里有明确的 `degraded: true` 标记，不假装完成了 Rerank。
- [ ] [AC-004] Qdrant 服务不可用时，检索函数返回空结果 + 错误说明，
  不抛出未捕获异常，调用方（模拟 N2 流程）能继续往下走。
- [ ] [AC-005] 注入文本总长度超过配置上限时，被裁剪的是完整的低分经验
  条目，不是某条经验内部文本被截断到语义不完整。
- [ ] [AC-006] `scopeMode="project-and-global"`（或不传，默认值）、
  `projectScope="my-project"` 的检索请求能同时召回
  `project_scope="my-project"` 和 `project_scope="global"` 的经验，不会
  召回其他项目的 scope。
- [ ] [AC-006b] `scopeMode="project-only"`、`projectScope="my-project"`
  的检索请求**只**召回 `project_scope="my-project"` 的经验，即使库中
  存在相关度更高的 `project_scope="global"` 经验也不得出现在结果里——
  验证"仅当前项目"模式在契约与实现两层都真实可用，不是只存在于文档
  描述里（Codex Review 第十一轮指出 AC-006 之前只覆盖了"当前项目 +
  global"一种模式，遗漏了 F-005 要求的另一种）。
- [ ] [AC-007] `taskDescription` 含 Token 样式字符串时，检索函数在
  调用 Embedding 服务**之前**就返回 `degraded: true, degradedReason:
  "input_blocked"`（用 mock/记录调用次数的方式断言 `embedder.embed()`
  确实未被调用，不是"调用了但服务端拒绝"）。
- [ ] [AC-008] 命中同一 `documentId` 的多个不同小节（如"错误做法"与
  "根因"两节都进入 Top20）时，去重聚合后只产出一条 `RetrievedLesson`
  （不是每个小节各出一条重复/残缺的结果），且该条的 `summary`/
  `correctAction`/`verificationMethod` 分别来自"问题表现+根因"/
  "正确处理"/"验证方法"对应小节的真实正文（不是命中小节本身的文本，
  也不是空字符串）——验证 F-006 的跨小节组装真实生效，这是 Codex
  Review 第十一轮指出的核心契约缺口对应的验收标准。

## 依赖

- Feature 1（数据模型、`upsertExperience`、`redact`）。
- 现有 `mastra-agent/src/rag/{embedding,rerank}.ts`（直接复用，不修改）。
- 现有 Qdrant 服务（同一实例，新增一个 collection）。

## 开放问题

- 无（沿用 PLAN.md 记录的架构边界决定）。
