# Feature 2: store-retrieval — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 新增子模块
- specs 路径: workflow-experience/specs/2.store-retrieval/

## 任务列表

### 功能 1: 独立配置与存储层

- [ ] T-001: `loadExperienceConfig()`（复用 `rag/config.ts`，独立 collection/
  knowledgeSet/knowledgeRoot 覆盖）~15min
- [ ] T-002: `ExperienceStore` 类（对齐 `KnowledgeStore` 接口，独立 Mastra
  vector id），含 `createIndex`/`upsert`/`describe` 实现，`query()` 支持
  传入 `ExperienceQueryFilter` 并下推为 **MongoDB 风格扁平 filter 对象**
  （同 `rag/store.ts` 现有 `query()` 的 `filter: { knowledge_set: ... }`
  写法一致，由 `QdrantVector`/`QdrantFilterTranslator` 翻译为 Qdrant 原生
  REST 条件；`projectScopeIn` 用 `{ project_scope: { $in: [...] } }`
  表达 OR/any-of 语义——**⛔ 不要手写 Qdrant 原生 REST 的 `must`/`match`
  数组直接传给 filter 参数**，那是翻译器的输出形状不是输入形状，
  已通过检查本机已安装的 `@mastra/qdrant` 源码确认，见 design.md 第十轮
  Codex Review 修正记录），下推到向量检索这一次请求里完成（不是查询后
  再筛） ~30min

### 功能 2: 摄取管线

- [ ] T-003: 经验文档按 9 个固定二级标题分块（`ExperienceChunk`），
  `ingestExperience()` 串联 embedding → upsert ~30min
- [ ] T-004: Feature 1 `upsertExperience()` 成功后接入摄取调用点（写入
  成功但摄取失败时不回滚 Markdown，只记录告警） ~15min

### 功能 3: 检索管线

- [ ] T-005: `retrieveExperience()` 主流程：脱敏（**`blocked` 时在调用
  `embedder.embed()` 之前直接返回 `degradedReason: "input_blocked"`，
  不发送未处理输入给 Embedding 服务**）→ embedding → 按 `query.scopeMode`
  计算 `projectScopeIn`（`"project-only"` → `[projectScope]`，否则
  `[projectScope, "global"]`——⛔ 不要硬编码成永远带 global，见
  design.md 第十一轮 Codex Review 修正记录）→ 调用
  `store.query(vector, 20, filter)` 一次性下推 status/stage/taskType/
  projectScopeIn/riskLevel 过滤条件（Top20 本身即为合格候选，不做
  二次应用层过滤） ~30min
- [ ] T-005b: **按 `document_id` 去重聚合**：Top20 小节级 `StoreHit[]`
  分组，每个 `document_id` 只保留分数最高的一条作为代表 hit，产出
  "文档级候选列表"——这一步是 T-006 Rerank 和 T-006b 文档组装的前置
  依赖（design.md 第十一轮 Codex Review 指出：不去重会让 Rerank/格式化
  拿到的是单节 chunk 而不是完整文档，无法凑出 `RetrievedLesson` 需要的
  跨小节字段） ~15min
- [ ] T-006: Rerank 接入 + 降级分支（对 T-005b 产出的"文档级候选列表"
  的代表 chunk 文本跑 Rerank/按 representativeScore 排序，取 Top 3-5
  documentId；`degraded`/`degradedReason` 明确标注，不冒充完成
  Rerank） ~30min
- [ ] T-006b: **文档级组装**：对最终入选的每个 documentId，读取其代表
  hit payload 里的 `source_file`，用 Feature 1 `schema.ts` 导出的
  `parseExperienceSections()` 抽取"问题表现/根因/正确处理/验证方法"
  四节正文，组装成完整 `RetrievedLesson`（`summary`="问题表现"+"根因"，
  `correctAction`="正确处理"，`verificationMethod`="验证方法"）；读取/
  解析失败时跳过该候选并记录告警，不让整次检索失败 ~30min
- [ ] T-007: `formatForInjection()`（长度上限裁剪，按整条经验丢弃，非
  内部截断） ~15min

### 集成与测试

- [ ] T-008: 隔离性 + 降级路径 + 过滤正确性测试，覆盖 AC-001~AC-008
  （含真实起停 Reranker/Qdrant 服务模拟不可用场景，比照现有
  `rag/rerank.test.ts` 的写法；AC-006b 的 `scopeMode="project-only"`
  排除 global 场景、AC-008 的同文档多小节去重聚合+跨小节字段组装场景
  是第十一轮 Codex Review 新增的必测项，不能只测 AC-006 那一种
  scopeMode） ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003 依赖 T-002 与 1.T-001~1.T-006（Feature 1 全部完成）
- T-004 依赖 T-003
- T-005 依赖 T-002
- T-005b 依赖 T-005
- T-006 依赖 T-005b
- T-006b 依赖 T-006 与 1.T-001~1.T-002（需要 Feature 1 导出的
  `parseExperienceSections()`）
- T-007 依赖 T-006b
- T-008 依赖 T-001~T-007 全部完成（含 T-005b/T-006b）

## 风险点

- `ExperienceStore` 与 `QdrantKnowledgeStore` 代码重复度较高，未来两边
  独立修复 bug 时可能出现"一边修了另一边没修"的漂移——设计上已接受这个
  取舍（优先隔离安全性），后续如证明维护成本过高可以重新评估抽取公共
  基类，但那属于后续优化，不在本 feature 范围内。
- 摄取失败不回滚 Markdown 的设计依赖 `experience:rebuild`（Feature 3）
  作为补偿机制，本 feature 完成时 `rebuild` 尚未实现，需要在测试里用
  "手动重新调用 ingestExperience" 代替验证补偿路径的可行性，不能假装
  `rebuild` 已存在。
