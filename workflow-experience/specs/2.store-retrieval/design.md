# Feature 2: store-retrieval — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |

## 项目架构

- 架构类型: monorepo 新增子模块，直接依赖 `mastra-agent/src/rag/` 的
  `embedding.ts`/`rerank.ts`（原样复用）与 Feature 1 的 `experience/` 模块
- 涉及层: 后端数据/检索层，无前端

## 功能模块设计

### 模块 1: 独立配置（`mastra-agent/src/experience/config.ts`）

```ts
import { loadConfig as loadRagConfig, type RagConfig } from "../rag/config.ts";

export function loadExperienceConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return loadRagConfig({
    collection: process.env.EXPERIENCE_QDRANT_COLLECTION || "claude_workflow_experience",
    knowledgeSet: process.env.EXPERIENCE_KNOWLEDGE_SET || "claude-workflow-experience",
    knowledgeRoot: process.env.EXPERIENCE_KNOWLEDGE_ROOT || "knowledge/experience",
    globs: ["**/*.md"],
    ...overrides,
  });
}
```

复用 `rag/config.ts` 的 `loadConfig()`（不修改它），只是传入不同的
`overrides`——`qdrantUrl`/`embeddingBaseUrl`/`embeddingModel` 等基础设施
地址天然共享同一套环境变量，两个 domain 指向同一批服务实例。

### 模块 2: `ExperienceStore`（`mastra-agent/src/experience/store.ts`）

接口对齐 `rag/store.ts` 的 `KnowledgeStore`（同名方法签名，未来如果要
写"两个 Store 通用的测试工具函数"更方便），但是**独立的类**，不 extends
也不 import `QdrantKnowledgeStore`（避免任何隐式耦合），关键差异有两点：
构造函数的 Mastra vector id，以及 `query()` 支持传入额外的 metadata 过滤
条件（**必须在向量检索阶段下推到 Qdrant filter，不能等 Top20 出来后再
在应用层过滤**——Codex Review 指出：如果向量相似度最高的 20 条恰好来自
其他项目/其他 stage/非 verified 状态，应用层再过滤会导致明明有匹配记录
却被"挤出前 20"而漏检，这是真实的正确性 bug，不是性能优化取舍）：

```ts
export interface ExperienceQueryFilter {
  stage?: string;
  taskType?: string;
  /** OR 语义：命中其一即可，用于"当前项目 + global"这类多值匹配 */
  projectScopeIn?: string[];
  riskLevel?: string;
  status?: string;
}

export class ExperienceStore implements KnowledgeStore {
  private readonly vector: QdrantVector;
  constructor(cfg: RagConfig) {
    this.indexName = cfg.collection;      // "claude_workflow_experience"
    this.knowledgeSet = cfg.knowledgeSet; // "claude-workflow-experience"
    this.vector = new QdrantVector({ id: "claude-workflow-experience", url: baseUrl });
    // 与 QdrantKnowledgeStore 的 id="customer-service-knowledge" 完全不同，
    // 避免 Mastra 内部按 id 索引 vector store 实例时互相覆盖。
  }

  /**
   * 与 KnowledgeStore.query() 签名兼容（第三参数可选），knowledge_set
   * 过滤始终生效（与客服知识库同款隔离保险）；传入 extraFilter 时，
   * 在同一次 Qdrant query 请求里把 stage/taskType/projectScopeIn/
   * riskLevel/status 一并作为 must/should 条件下推，保证返回的 Top20
   * 本身就是"满足全部过滤条件的前 20 条"，而不是"全库前 20 条里凑巧
   * 满足条件的子集"。
   */
  async query(vector: number[], topK: number, extraFilter?: ExperienceQueryFilter): Promise<StoreHit[]> {
    // filter 必须是 QdrantVector.query() 期望的 MongoDB 风格扁平对象
    // （同 rag/store.ts 现有 query() 的 `filter: { knowledge_set: this.knowledgeSet }`
    // 用法一致），由 QdrantFilterTranslator 翻译为 Qdrant 原生 REST 的
    // `{ must: [{ key, match: { value } }] }`——不能在这里手写 must 数组
    // 直接传原生 REST 形状，否则会被翻译器当成字段名 "must" 去匹配，
    // 静默匹配不到任何结果（Codex Review 第十轮指出：这个错误同时会
    // 破坏 knowledge_set 隔离保险，是安全相关的回归，已通过实际检查
    // 已安装的 @mastra/qdrant/dist/index.js 中 QdrantFilterTranslator
    // 源码确认——同一对象内的多个字段自动 AND；`$in` 数组操作符被
    // BaseFilterTranslator/QdrantFilterTranslator 支持，翻译为
    // `match: { any: [...] }`，用于 projectScopeIn 的 OR/any-of 语义）。
    const filter: Record<string, unknown> = { knowledge_set: this.knowledgeSet };
    if (extraFilter?.stage) filter.stage = extraFilter.stage;
    if (extraFilter?.taskType) filter.task_type = extraFilter.taskType;
    if (extraFilter?.riskLevel) filter.risk_level = extraFilter.riskLevel;
    if (extraFilter?.status) filter.status = extraFilter.status;
    if (extraFilter?.projectScopeIn?.length) {
      filter.project_scope = { $in: extraFilter.projectScopeIn };
    }
    const results = await this.vector.query({
      indexName: this.indexName,
      queryVector: vector,
      topK,
      filter,
    });
    return results.map((r) => ({ id: r.id, score: r.score, payload: r.metadata ?? {} }));
  }
  // health/describe/createIndex/upsert/deletePoints/listPoints/countPoints
  // 实现逻辑与 QdrantKnowledgeStore 几乎一样（同样的 REST 补充 + QdrantVector
  // 常规操作分工），允许代码有一定重复——两边独立演进比强行抽象共享基类更
  // 安全（客服知识库的行为不该因为经验库的需求变化而被动调整）。
}
```

### 模块 3: 摄取（`mastra-agent/src/experience/ingest-pipeline.ts`）

经验文档结构固定（9 个二级标题），分块策略比客服知识库简单：**按二级
标题整节切块**，每节一个 chunk（不需要 `rag/markdown.ts` 的"合并过短
相邻片段"逻辑，因为经验文档的每节长度本来就可控）。

```ts
export interface ExperienceChunk {
  id: string;              // documentId + "#" + 节名 的稳定哈希
  text: string;             // 节标题 + 节内容
  documentId: string;
  documentVersion: number;
  title: string;
  section: string;          // 9 个固定节名之一
  stage: string;
  taskType: string;
  projectScope: string;
  riskLevel: string;
  status: string;           // candidate/verified/deprecated，供检索过滤
  occurrenceCount: number;
  sourceFile: string;
  knowledgeSet: string;
}

export async function ingestExperience(
  cfg: RagConfig,
  embedder: EmbeddingClient,
  store: ExperienceStore,
  doc: ParsedExperienceDocument, // 来自 Feature 1 write.ts 成功写入后的产物
): Promise<void>;
```

`upsertExperience()`（Feature 1）成功后**同步调用**本函数（不做异步
队列——经验写入频率低，同步调用足够简单可靠；Embedding/Qdrant 不可用时
本函数失败不应该回滚已经落盘的 Markdown 文件，只是"暂时没有向量索引"，
下次 `experience:rebuild`（Feature 3）会补齐——这是 graceful degrade 在
写路径的体现，与 F-008 的读路径 degrade 对称）。

### 模块 4: 检索（`mastra-agent/src/experience/retrieve.ts`）

```ts
export interface RetrieveQuery {
  taskDescription: string;
  stage: "execute" | "review" | "qa" | "finish";
  taskType?: string;
  projectScope: string;
  /**
   * "project-and-global"（默认）——当前项目 + global 都召回；
   * "project-only"——只召回当前项目，不含 global。
   * F-005 明确要求两种模式都要能被调用方表达（⛔ 不支持
   * "global-only"：当前项目内检索天然应该包含全局通用经验，没有
   * "只要 global 不要当前项目"这种场景）——Codex Review 第十一轮指出：
   * 若 `RetrieveQuery` 没有这个字段，管线内部永远硬编码
   * `[projectScope, "global"]`，调用方就没有任何办法表达"仅当前项目"，
   * F-005 的第一种模式在契约层面根本不可实现。
   */
  scopeMode?: "project-and-global" | "project-only"; // 默认 "project-and-global"
  riskLevel?: string;
}

export interface RetrievedLesson {
  title: string;
  summary: string;        // 从"问题表现"+"根因"节提炼
  correctAction: string;  // "正确处理"节
  verificationMethod: string; // "验证方法"节
  sourceFile: string;
  documentVersion: number;
  relevanceScore: number;
}

export interface RetrieveResult {
  lessons: RetrievedLesson[];
  degraded: boolean;
  degradedReason?: string; // "reranker_unavailable" | "qdrant_unavailable" | ...
}

export async function retrieveExperience(query: RetrieveQuery): Promise<RetrieveResult>;
```

**重要契约澄清（Codex Review 第十一轮）**：`store.query()` 返回的每条
`StoreHit` 只对应经验文档的**一个小节**（模块 3 摄取时"按二级标题整节
切块"，一个 chunk = 一节），而 `RetrievedLesson` 需要同时取"问题表现/
根因/正确处理/验证方法"四个不同小节的内容——不能像客服 RAG 那样直接把
命中的 chunk 文本当结果返回，必须在格式化前补一步"按 documentId 聚合、
读取完整文档、重新抽取所需小节"，否则 `summary`/`correctAction`/
`verificationMethod` 会缺失或读到错误小节的内容（这就是 F-006 无法被
满足的根因）。管线如下：

1. `redact(query.taskDescription)`——检索输入同样脱敏（需求 NFR）。
   **必须检查 `blocked`，不能只取 `.text` 就送去 embedding**（Codex
   Review 指出：与 Feature 5 建议报告生成器同一类问题——若
   `taskDescription` 里混入了密钥或疑似聊天原文，`redact()` 按
   Feature 1 design.md 的定义会返回 `blocked: true` 且不保证 `.text`
   是安全替换后的文本；若直接把 `.text` 发给可配置地址的 Embedding
   服务，等于把未处理的敏感输入发到了外部服务及其日志里）。
   `blocked === true` → 直接返回 `{ lessons: [], degraded: true,
   degradedReason: "input_blocked" }`，不进入第 2 步，不调用
   `embedder.embed()`。
2. `embedder.embed([redacted.text])` → 失败 → 返回 `{ lessons: [],
   degraded: true, degradedReason: "embedding_unavailable" }`
   （try/catch 包裹，不上抛）。
3. 按 `scopeMode` 计算 `projectScopeIn`：
   ```ts
   const projectScopeIn = query.scopeMode === "project-only"
     ? [query.projectScope]
     : [query.projectScope, "global"];
   ```
   `store.query(vector, 20, { stage: query.stage, taskType: query.taskType,
   riskLevel: query.riskLevel, status: "verified", projectScopeIn })` ——
   **过滤条件与 Top20 限制在同一次 Qdrant 请求里生效**（模块 2 已改为
   下推式 filter），保证返回的最多 20 条都已经满足全部 metadata 条件，
   不会出现"合格记录排第 21 名被漏检"的问题。返回的是**小节级别**
   `StoreHit[]`（每条 payload 含 `document_id`/`section`/`source_file`/
   `document_version`）。失败（Qdrant 不可达）→ 同上返回
   `qdrant_unavailable`。
4. **按 `document_id` 去重，取每篇文档的代表命中**：对 Top20 小节级
   hits 分组，同一 `document_id` 可能因为多个小节都语义相关而出现
   多条（例如"错误做法"和"根因"两节都命中），每组只保留**向量分数
   最高**的一条作为该文档的代表 hit（`representativeScore`）。得到
   "文档级候选列表"（数量 ≤ 20，通常明显小于 20）。
5. Reranker 可用 → 对文档级候选列表的代表 chunk 文本跑
   `createReranker().rerank(query, candidates, 5)`，取 Top 5 documentId；
   不可用（复用 `rag/rerank.ts` 的 `status: "unavailable"` 语义）→
   直接按 `representativeScore` 排序取前 3-5 个 documentId，
   `degraded: true, degradedReason: "reranker_unavailable"`——**不得**
   把这种向量分数排序包装成看起来像 Rerank 完成的结果（对应需求 F-004
   的"不得把向量分数加权冒充 Rerank"）。
6. **文档级组装**：对最终入选的每个 `documentId`，取其代表 hit
   payload 里的 `source_file`（payload 里存的是相对路径，不含绝对用户
   目录——与模块 4 数据模型一致；实际读取时用
   `path.join(cfg.knowledgeRoot, source_file)` 解析成绝对路径，规范
   路径始终是 `{document_id}.md`，不会指向 `.superseded/` 归档副本），用
   Feature 1 `schema.ts` 导出的 `parseExperienceSections()`（复用
   `validateExperience()` 内部已有的分节逻辑，不在这里重新实现一套）
   取出"问题表现""根因""正确处理""验证方法"四节正文，组装成
   `RetrievedLesson`：
   - `summary` = "问题表现" 节 + "\n" + "根因" 节
   - `correctAction` = "正确处理" 节
   - `verificationMethod` = "验证方法" 节
   - `relevanceScore` = 上一步的 rerank 分数（降级时为
     `representativeScore`）
   - `documentVersion`/`sourceFile` 取自代表 hit 的 payload
   读取或解析失败（文件被并发删除等极端情况）→ 跳过该条候选、记录
   一条告警日志，不让整次检索失败（最终条数可能因此少于 5 条，这是
   可接受的 best-effort 降级，不需要额外的 `degradedReason`）。
7. 格式化为最终数组，套用长度上限裁剪（模块 5）。

### 模块 5: 注入格式化与长度限制（`mastra-agent/src/experience/format.ts`）

```ts
const MAX_INJECTION_CHARS = Number(process.env.EXPERIENCE_MAX_INJECTION_CHARS || 2000);

export function formatForInjection(lessons: RetrievedLesson[]): string {
  // 按 relevanceScore 降序排列后，逐条累加字符数，超过 MAX_INJECTION_CHARS
  // 时整条丢弃（不截断单条内部文本），返回拼接好的注入文本。
}
```

每条渲染模板：

```text
### {title}（相关度 {relevanceScore.toFixed(2)}，v{documentVersion}）
- 教训：{summary}
- 正确做法：{correctAction}
- 验证方式：{verificationMethod}
- 来源：{sourceFile}
```

## 接口契约

```ts
export { loadExperienceConfig } from "./config.ts";
export { ExperienceStore } from "./store.ts";
export { ingestExperience } from "./ingest-pipeline.ts";
export { retrieveExperience, type RetrieveQuery, type RetrieveResult } from "./retrieve.ts";
export { formatForInjection } from "./format.ts";
```

## 数据模型

Qdrant point payload（`claude_workflow_experience` collection）：

```ts
{
  knowledge_set: "claude-workflow-experience",
  document_id: string,
  document_version: number,
  title: string,
  section: string,
  stage: string,
  task_type: string,
  project_scope: string,
  risk_level: string,
  status: string,          // candidate/verified/deprecated
  occurrence_count: number,
  source_file: string,     // 相对路径，不含绝对用户目录
}
```

## 安全考虑

- 检索输入脱敏（复用 Feature 1）。
- 隔离性靠**物理隔离**（独立 collection + 独立 knowledge_set 双重保险）
  而不是单纯依赖查询时的 filter——即使查询代码有 bug 忘记加 filter，
  独立 collection 本身也不可能查到客服数据。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| metadata 过滤位置 | Qdrant filter 下推 vs 应用层过滤 | **下推到 Qdrant filter**（修正自初版设计的应用层过滤方案）——Codex Review 指出应用层过滤会让高分但不合格的记录占满 Top20 名额，导致合格记录被漏检；过滤条件与 knowledge_set 隔离用同一套 must/should 语法，维护成本可控 |
| `ExperienceStore` 与 `QdrantKnowledgeStore` 关系 | 继承/共享基类 vs 独立实现 | 独立实现——避免客服知识库因经验库需求被动修改，接受少量代码重复 |
| 摄取时机 | 写入 Markdown 后同步摄取 vs 异步队列 | 同步——经验写入频率低（每个 task 完成一次），不需要队列复杂度；失败可靠 `experience:rebuild` 补偿 |
| 长度限制裁剪粒度 | 按字符截断 vs 按整条经验裁剪 | 整条裁剪——避免注入半截经验造成误导（需求 F-006 明确要求） |
