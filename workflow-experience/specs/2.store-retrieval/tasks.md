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

- [x] T-001: `loadExperienceConfig()`（复用 `rag/config.ts`，独立 collection/
  knowledgeSet/knowledgeRoot 覆盖）~15min —— 完成于 2026-08-01：
  `mastra-agent/src/experience/config.ts` + `config.test.ts`（5 项，含
  隔离性/共享基础设施配置/env 覆盖/overrides 参数），`.env.example`
  已补充 `EXPERIENCE_QDRANT_COLLECTION`/`EXPERIENCE_KNOWLEDGE_SET`/
  `EXPERIENCE_KNOWLEDGE_ROOT` 三个新环境变量。`npm run experience:test`
  107/107 通过。
- [x] T-002: `ExperienceStore` 类（对齐 `KnowledgeStore` 接口，独立 Mastra
  vector id），含 `createIndex`/`upsert`/`describe` 实现，`query()` 支持
  传入 `ExperienceQueryFilter` 并下推为 **MongoDB 风格扁平 filter 对象**
  （同 `rag/store.ts` 现有 `query()` 的 `filter: { knowledge_set: ... }`
  写法一致，由 `QdrantVector`/`QdrantFilterTranslator` 翻译为 Qdrant 原生
  REST 条件；`projectScopeIn` 用 `{ project_scope: { $in: [...] } }`
  表达 OR/any-of 语义——**⛔ 不要手写 Qdrant 原生 REST 的 `must`/`match`
  数组直接传给 filter 参数**，那是翻译器的输出形状不是输入形状，
  已通过检查本机已安装的 `@mastra/qdrant` 源码确认，见 design.md 第十轮
  Codex Review 修正记录），下推到向量检索这一次请求里完成（不是查询后
  再筛） ~30min —— 完成于 2026-08-01：`mastra-agent/src/experience/
  store.ts`，过滤条件构造独立成纯函数 `buildExperienceFilter()`（不
  依赖真实 Qdrant 即可单元测试，`store.test.ts` 6 项）；其余 CRUD 方法
  是对 `QdrantVector`/REST 的常规转发，与 `QdrantKnowledgeStore` 允许
  一定程度重复（design.md 明确的设计决策），留给 T-008 集成测试覆盖。
  `@mastra/qdrant` 的 `QdrantVectorFilter` 类型只接受内联字面量做正确
  的条件类型收窄，动态构造的 filter 在 `query()` 调用处做了一次
  类型断言（已在代码注释里说明运行期形状与 `rag/store.ts` 现有用法
  完全一致，只是 TS 类型层面的已知限制）。`npm run experience:test`
  113/113 通过。

### 功能 2: 摄取管线

- [x] T-003: 经验文档按 9 个固定二级标题分块（`ExperienceChunk`），
  `ingestExperience()` 串联 embedding → upsert ~30min —— 完成于
  2026-08-01：`mastra-agent/src/experience/ingest-pipeline.ts`。
  `chunkExperienceDocument()` 独立导出成纯函数（不依赖真实服务即可
  测试切块逻辑），chunk id 用 `documentId#section` 的哈希（不含
  `document_version`，保证同一文档新版本摄取时自然覆盖旧版本向量，
  不需要额外清理），拼成 UUID 形状（`rag/markdown.ts` 的
  `stableChunkId()` 同一惯例，Qdrant 点 ID 要求）。
  `ingest-pipeline.test.ts` 9 项。
- [x] T-004: Feature 1 `upsertExperience()` 成功后接入摄取调用点（写入
  成功但摄取失败时不回滚 Markdown，只记录告警） ~15min —— 完成于
  2026-08-01：`mastra-agent/src/experience/write-and-ingest.ts` 的
  `writeExperienceAndIngest()`，串联"调用 `upsertExperience()` → 读回
  刚写入的文件 → 解析成 `ParsedExperienceDocument` → 调用
  `ingestExperience()`"，摄取失败时返回 `ingested: false` +
  `ingestWarning` 字符串，不影响 Markdown 写入结果本身（**不修改
  Feature 1 的 `write.ts`**，`ParsedExperienceDocument` 由读回解析
  构造，不要求 `upsertExperience()` 直接返回它）。
  `write-and-ingest.test.ts` 4 项（含"摄取失败时文件仍完整存在"、
  "写入本身失败时不调用 embedder"、"source_file 不含绝对路径"三条
  关键断言）。`npm run experience:test` 126/126 通过，`npm run test`
  82/82 + 126/126 全部通过。

### 功能 3: 检索管线

- [x] T-005/T-005b/T-006/T-006b（合并实现，逻辑上不可分割，见
  `retrieve.ts` 单文件）：`retrieveExperience()` 主流程 —— 脱敏
  （`blocked` 时在调用 `embedder.embed()` 之前直接返回
  `degradedReason: "input_blocked"`）→ embedding（失败 →
  `embedding_unavailable`）→ 按 `scopeMode` 计算 `projectScopeIn`
  → `store.query(vector, 20, filter)` 一次性下推
  status=verified/stage/taskType/projectScopeIn/riskLevel（失败 →
  `qdrant_unavailable`）→ 按 `document_id` 去重聚合（每组保留分数
  最高的代表 hit）→ 读取每个候选源文件的完整分节内容（一次读取，
  同时供 Rerank 输入文本与后续文档组装复用，读取/解析失败的候选
  直接跳过不让整次检索失败）→ Rerank 可用用真实交叉编码分数排序，
  不可用/禁用则按向量分数排序取 Top5 且标注
  `degradedReason: "reranker_unavailable"` → 组装
  `RetrievedLesson`（`summary`="问题表现"+"根因"，
  `correctAction`="正确处理"，`verificationMethod`="验证方法"，
  任一必需节缺失则跳过该候选）。完成于 2026-08-01：
  `mastra-agent/src/experience/retrieve.ts`，`retrieve.test.ts`
  11 项（覆盖 AC-003/004/006/006b/007/008 及去重聚合/文档组装/
  读取失败容错场景）。
- [x] T-007: `formatForInjection()`（长度上限裁剪，按整条经验丢弃，非
  内部截断） ~15min —— 完成于 2026-08-01：
  `mastra-agent/src/experience/format.ts`；相关度最高的第一条经验
  即使单独超过预算也完整保留（不返回空结果），第二条起按分数从低到
  高整条丢弃，不截断单条内部文本（AC-005）。`format.test.ts` 5 项。

### 集成与测试

- [x] T-008: 隔离性 + 降级路径 + 过滤正确性测试，覆盖 AC-001~AC-008
  ~30min —— 完成于 2026-08-01：
  1. 单元/逻辑级覆盖（不需要真实服务）已随 T-001~T-007 各自的测试
     文件完成：`config.test.ts`/`store.test.ts`/
     `ingest-pipeline.test.ts`/`write-and-ingest.test.ts`/
     `retrieve.test.ts`/`format.test.ts`，合计随 `experience:test`
     跑（AC-002~AC-008 均已覆盖，含 AC-006b 的 `project-only` 排除
     global 场景与 AC-008 的同文档多小节去重聚合+跨小节字段组装
     场景，用真实写入的临时 Markdown 文件验证，不是伪造断言）。
  2. **真实服务端到端冒烟**（AC-001 隔离性 + 完整闭环）：新建
     `mastra-agent/src/experience/live/store-retrieval.live.test.ts`
     + `npm run experience:test:live`（不在 `experience:test` 的
     glob 范围内，不会被默认 `npm test` 拉起，与 `rag/rerank.test.ts`
     "需要真实服务在线"的既有惯例一致）——用独立临时 Collection
     名称（测试结束 `deleteIndex()` 清理，不污染生产
     `claude_workflow_experience`）跑通"写入 Markdown → 摄取向量 →
     检索召回"完整闭环，并验证 `customer_service_knowledge` 点数量
     全程不变。**已针对本机在线的真实 Qdrant/Ollama(bge-m3)/Reranker
     服务实际运行通过**（2/2，含召回内容正确性与隔离性两项断言），
     不是理论上"应该能跑"。

  `npm run experience:test` **142/142 通过**、`npm run test`
  （typecheck + agent:test:unit + experience:test）**82/82 +
  142/142 全部通过**、`npm run experience:test:live` **2/2 通过**
  （针对真实服务）。

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
