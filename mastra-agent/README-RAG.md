# RAG 检索层说明（向量入库 + 独立 Reranker）

检索链路：**Markdown → bge-m3 向量入库 → 向量召回 Top20 → 独立 Cross-Encoder Rerank → Top5。**

**不包含**：接 Agent、前端。Rerank 验收通过后才进入下一阶段。

---

## 1. 组件与版本

| 组件 | 版本 / 取值 | 说明 |
|---|---|---|
| Qdrant | `qdrant/qdrant:v1.18.1` | Docker 容器，仅监听 `127.0.0.1`；与 `@qdrant/js-client-rest` 1.18.0 版本对齐 |
| Collection | `customer_service_knowledge` | 1024 维 / Cosine |
| Embedding | `bge-m3`（Ollama，1.16GB） | 本地 OpenAI 兼容端点，**不使用云端 Embedding** |
| 向量维度 | **1024（实测确认）** | 每次运行都会实测校验，不一致直接失败 |
| `@mastra/core` | 1.52.1 | 未升级，保持原版本 |
| `@mastra/rag` | 2.4.2 | 提供 `MDocument` Markdown-aware 分块 |
| `@mastra/qdrant` | 1.1.2 | **提供 `QdrantVector`，承担全部常规向量操作**（见第 4 节分工） |
| `tsx` / `@types/node` | 4.23.1 / devDep | 直接运行 `.ts` 脚本与类型检查所需 |

## 2. 命令

```bash
cd mastra-agent

npm run rag:qdrant:up        # 拉起 Qdrant（命名卷持久化 + 健康等待）
npm run rag:qdrant:down      # 停容器，**保留数据卷**
npm run rag:ingest           # 摄取：Markdown → bge-m3 → Qdrant（幂等）
npm run rag:ingest -- --recreate   # 显式重建 Collection（会丢数据，会打警告）
npm run rag:search           # 跑 5 个固定验证查询（回归门禁，失败退出非零）
npm run rag:search -- "自定义问题"  # 单条查询
npm run rag:test             # 最小自动验证（写库用例全部用临时 Collection）
npm run typecheck            # tsc --noEmit
```

> 本机没有 `docker compose` 插件也没有 `docker-compose` v1，
> 所以 `rag:qdrant:up` 会自动退回到与 `docker-compose.rag.yml` 语义等价的 `docker run`
> （同镜像、同端口、同命名卷 `customer_service_qdrant_storage`）。
> 装了 compose 插件的机器会优先走 compose。

## 3. 配置

全部来自环境变量，缺省值见仓库根 `.env.example`。`.env` 不提交。

| 变量 | 缺省 | 作用 |
|---|---|---|
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant 地址 |
| `QDRANT_COLLECTION` | `customer_service_knowledge` | Collection 名 |
| `EMBEDDING_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama OpenAI 兼容端点 |
| `EMBEDDING_MODEL` | `bge-m3` | 入库与查询**必须同一个** |
| `EMBEDDING_DIMENSION` | `1024` | 期望维度，运行时实测比对 |
| `KNOWLEDGE_ROOT` | `knowledge` | 知识库根目录 |
| `KNOWLEDGE_GLOBS` | `repair/*.md` | 摄取范围，见第 6 节 |
| `CHUNK_MAX_CHARS` / `CHUNK_MIN_CHARS` / `CHUNK_OVERLAP_CHARS` | `800` / `400` / `100` | 分块参数 |

## 4. 组件分工：MDocument / QdrantVector / 原生 REST

| 职责 | 由谁承担 | 代码位置 |
|---|---|---|
| Markdown 分块 | **Mastra `MDocument`** | `src/rag/markdown.ts` → `MDocument.fromMarkdown(...).chunk({strategy:"markdown", headers:[...]})` |
| 创建 Collection | **Mastra `QdrantVector.createIndex`** | `src/rag/store.ts` → `QdrantKnowledgeStore.createIndex` |
| 查询 Collection 统计 | **`QdrantVector.describeIndex`** | `store.ts` → `describe()` |
| 删除 Collection（仅 `--recreate`） | **`QdrantVector.deleteIndex`** | `store.ts` → `deleteIndex()` |
| payload 字段索引 | **`QdrantVector.createPayloadIndex`** | `store.ts` → `createPayloadIndexes()` |
| **向量写入 upsert** | **`QdrantVector.upsert`** | `store.ts` → `upsert()`，被 `pipeline.ts` 逐文档调用 |
| **向量检索 query** | **`QdrantVector.query`** | `store.ts` → `query()`，被 `search.ts` 调用；**始终带 `knowledge_set` filter** |
| 按 ID 删除点 | **`QdrantVector.deleteVectors`** | `store.ts` → `deletePoints()` |

**原生 REST 仅保留 4 处**，全部是 `QdrantVector` 没有暴露对应能力的管理操作：

| REST 端点 | 用途 | 为什么不能用 QdrantVector |
|---|---|---|
| `GET /readyz` | 服务健康探活 | `QdrantVector` 没有健康检查接口，且该端点返回纯文本 |
| `POST /points/scroll` | 按 `knowledge_set` + `ingestion_scope` 翻页列出现存点 ID 及其 `document_id` | `QdrantVector` 不提供 scroll；而 stale 识别、"文档已被删除"检测、幂等判定都必须拿到库里真实的点 ID 集合 |
| `POST /points/count`（带 filter） | 统计当前 knowledge_set / scope 的精确点数 | `describeIndex` 只返回 Collection 总数，无法按 payload 过滤 |
| `GET /collections/{name}` | 判断 Collection 是否存在（404） | `describeIndex` 在 Collection 缺失时直接抛错，无法区分"不存在"与"真实故障" |

存储层通过 `KnowledgeStore` 接口注入，测试可替换实现来模拟 upsert 失败等场景。

## 5. 更新顺序（先写后删，写失败不删旧点）

```text
1. 解析 + 分块 + 全量 Embedding   ← 任一步失败则整轮中止，库里一个字节都不动
2. 快照本次涉及 scope 的现存点（id + document_id）
3. 逐文档 upsert，记录每个文档成功与否
4. 回读校验：确认本次期望的 chunk ID 全部已落库
5. 只有第 3、4 步都通过的文档，才删除它的 stale 旧点
```

任一文档 upsert 或回读校验失败时，**该文档的旧点原样保留**，知识库仍然可用；
报告里会列出 `failures` 与该 scope 的 `protectedDocuments`，退出码非零。

## 6. scope 同步策略

每个 chunk 的 payload 都带：

- `knowledge_set`：来自配置，本阶段固定 `customer-service`；
- `ingestion_scope`：由文件在 `knowledge/` 下的**第一层目录名**推导（`repair/xxx.md` → `repair`）。

清理规则：

- stale 清理**只在本次运行覆盖到的 scope 内**进行，且必须同时匹配 `knowledge_set`；
- 库里存在、但当前文件里已消失的 `document_id`（文档被删除）会被清理；
- 其他 scope（将来的 `policies`）和其他 `knowledge_set` 的点**完全不受影响**，已有自动用例覆盖；
- 将来摄取 policies 时使用 `scope=policies`，仍进入同一个 `customer_service_knowledge`；
- `experience` 使用独立 Collection `claude_workflow_experience`，不在本阶段实现。

`document_id` 全局唯一：跨文件、跨 scope 重复会立即失败，因为重复会导致 chunk 互相覆盖、
stale 清理误删。

**查询始终按 `knowledge_set` 隔离。** `QdrantKnowledgeStore.query()` 固定带上
`filter: { knowledge_set: <当前配置> }`，同一个 Collection 里其他知识集的点不会进入检索结果；
**默认不限制 `ingestion_scope`**，因为客服查询需要同时覆盖 `repair` 与将来的 `policies`。
自动用例 9 用两个内容完全相同、仅 `knowledge_set` 不同的点做了验证——
实测在不加 filter 时 `other-set` 甚至会排到第 1 位，加上 filter 后只返回本知识集。

## 7. 幂等判定

**不使用**"Collection 总点数 === 本次 chunk 数"作为依据——加入 policies 后该等式必然不成立。

报告分别输出：

| 字段 | 含义 |
|---|---|
| `collectionTotalPointCount` | 整个 Collection 的点数 |
| `currentKnowledgeSetPointCount` | 当前 `knowledge_set` 的点数 |
| `currentScopePointCount` | 本次覆盖 scope 的点数 |
| `expectedScopeChunkCount` | 本次期望的 chunk 数 |
| `stalePointsDeleted` | 清理掉的旧点数 |
| `idempotent` | **当前 scope 的点 ID 集合是否与本次期望 chunk ID 集合完全一致** |

因此加入 policies 之后，单独重复摄取 repair 仍会报告 `idempotent: true`。

## 8. 安全与幂等约束

实现里刻意保留的几条硬约束：

- **Collection 不存在** → 按实测维度 + Cosine 创建；
- **已存在但维度或距离不一致** → 明确报错并中止，不自动修复、不静默改写；
- **默认绝不删除 Collection**，只有显式 `--recreate` 才重建，并打印将丢失多少点；
- **Embedding 不静默回退**：服务不通、模型不存在、维度不符，都抛中文错误并退出；
- **入库与查询同模型**：`rag:search` 会比对 Collection 维度与查询模型维度，不一致中止；
- **幂等**：chunk ID 由 `document_id + chunk_index + content_hash` 稳定派生；
  更新顺序见第 5 节（先 upsert 并回读校验，再清理 stale），
  幂等判定见第 7 节（比对 scope 的点 ID 集合，不看 Collection 总点数）。
  文档新增、修改或删除后，**只需重跑同一条 `npm run rag:ingest`**。

## 9. 分块方式与实际尺寸

分块用 `@mastra/rag` 的 `MDocument`：

1. `strategy: "markdown"` + `headers: [["#","h1"],["##","h2"],["###","h3"]]`
   → Markdown-aware 切分，每片带所属标题层级；
2. 再把**同一 `##` 小节下**过短的相邻片合并到 `[minChars, maxChars]`；
3. 单节超过 `maxChars` 时按 `maxChars` 滑窗切，保留 `overlapChars` 重叠。

实际效果是**每个 `##` 小节恰好一个 chunk**：

| 文档 | chunk 数 | 字符范围 | 均值 |
|---|---:|---|---:|
| `knowledge/repair/monitor.md` | 16 | 97–524 | 193 |
| `knowledge/repair/refrigerator.md` | 14 | 113–537 | 223 |
| `knowledge/repair/television.md` | 16 | 74–399 | 172 |
| **合计** | **46** | 74–537 | 195 |

**与"建议 400～800 字符"的偏差，以及为什么不强行凑大：**

- 三份文档的 `##` 小节本身很短（`### 免拆排查` 通常就是 4–6 条编号步骤），
  一个小节的全部内容加起来往往只有 100–500 字符。合并逻辑已经把小节内的
  `###` 子片全部并进去了（refrigerator 原始 26 片 → 14 个小节 → 14 chunk），
  也就是说**小节边界先于 min/max 生效**，调大 `CHUNK_MIN_CHARS` / `CHUNK_MAX_CHARS`
  不会改变结果（已实测：min 400/700/800、max 800/1200/1600 输出均为 46 chunk）。
- 要凑到 400–800 就必须**跨 `##` 合并**，那会把「紧急安全分流 / 立即停止使用」
  和「信息采集清单」塞进同一个 chunk。对安全类检索是负面的：
  第 12 节查询 4（冰箱冒烟焦味）里「紧急安全分流」是靠**独立成块**才进到 Top2 的，
  一旦被合并进相邻小节，它的语义信号会被稀释。
- 因此这里选择**保持小节对齐**，并把偏差如实记录。若后续加入的政策文档小节更长，
  同一套逻辑会自动产出更接近 400–800 的 chunk，不需要改代码。

每个 chunk 的 payload 字段：
`document_id`、`document_version`、`title`、`section`、`domain`、`source`、
`updated_at`、`risk_level`、`text`、`chunk_index`、`content_hash`、`source_file`。

## 10. 扩展到政策文档（不改核心代码）

摄取逻辑不认识 "repair"，目录来源只由配置决定。将来加入 `knowledge/policies/*.md`：

```bash
# 方式一：环境变量
KNOWLEDGE_GLOBS="repair/*.md,policies/*.md" npm run rag:ingest

# 方式二：改 src/rag/config.ts 里 globs 的缺省值
```

新文档只要带齐 frontmatter 七个字段
（`document_id`、`document_version`、`title`、`domain`、`source`、`updated_at`、`risk_level`），
重跑 `npm run rag:ingest` 即可，缺字段会明确报错。

## 11. Collection 边界

| Collection | 内容 | 状态 |
|---|---|---|
| `customer_service_knowledge` | `knowledge/repair`、将来的 `knowledge/policies` | 当前使用 |
| `claude_workflow_experience` | 将来整理的 `knowledge/experience/*.md` | **尚未创建** |

`~/.claude` 下的工作流经验属于另一条线，**不进入客服 Collection**，
本阶段也不读取、不摄取 `~/.claude`。

## 12. 独立 Reranker

### 12.1 模型与运行时

| 项 | 值 |
|---|---|
| 原始模型 | `BAAI/bge-reranker-v2-m3`，Apache-2.0，0.6B，bge-m3 同族 |
| GGUF | `gpustack/bge-reranker-v2-m3-GGUF` @ `3093af03…`，Q8_0，635,676,416 字节 |
| SHA-256 | `a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3` |
| 运行时 | llama.cpp（brew 10180，`version: 10180 (11b068d06)`），Apple Metal |
| 端点 | `http://127.0.0.1:8787/v1/rerank`，只监听本机 |
| 权重位置 | `mastra-agent/.models/`（已 gitignore，**不入库**） |
| 元数据 | `mastra-agent/reranker-model.lock.json`（入库） |

启动参数**以本机 `llama-server --help` 实测为准**，未照抄文档：

```bash
llama-server --model .models/bge-reranker-v2-m3-Q8_0.gguf \
  --reranking --embedding --pooling rank \
  --host 127.0.0.1 --port 8787
```

**这是真 cross-encoder**：query 与 document 拼成一条序列走同一次前向，直接输出相关性分数。
**不是**向量分数加权，也不是把多路向量分数合并。

### 12.2 服务生命周期

```bash
npm run rerank:up       # 启动；已运行时不重复拉起；含健康等待与 /v1/rerank smoke test
npm run rerank:status   # PID、命令行校验、健康检查
npm run rerank:down     # 停止
```

- PID 写入 `mastra-agent/.runtime/rerank-server.pid`；
- `rerank:down` **只**停止 PID 文件记录、且命令行同时包含 `llama-server` 与本项目模型文件名的进程；
- **禁用 `pkill -f` / `killall`**，避免误杀用户其他进程；校验不通过时拒绝停止并提示人工处理；
- 端口上有服务但没有本脚本的 PID 文件时，`rerank:up` 不接管、不停止该进程。

### 12.3 分数口径（不可混淆）

每条结果**分别**保留四个字段，绝不合成"综合分"：

| 字段 | 来源 |
|---|---|
| `vectorScore` | Qdrant Cosine 相似度 |
| `vectorRank` | 向量召回名次（v1…v20） |
| `rerankScore` | bge-reranker-v2-m3 交叉编码分数 |
| `rerankRank` | 重排名次（r1…r5） |

`risk_level` **不参与打分**。安全规则属于后续 System Prompt / 安全路由，不混进 Rerank 分数。

### 12.4 降级语义

| `rerankStatus` | 触发条件 | 行为 |
|---|---|---|
| `ok` | 服务正常 | 输出 Rerank Top5 |
| `unavailable` | `RERANK_ENABLED=true` 但服务不可用 / 响应非法 | 明确报降级与原因，`rerankScore=null`，**不输出向量顺序冒充 Rerank**，`rag:search` 验收模式**退出码非零** |
| `disabled` | 显式 `RERANK_ENABLED=false` | 输出向量顺序 Top5 并标注"未经过 Rerank"，退出码 0 |

响应下标还会做映射校验：越界、重复、非法 score 一律判 `unavailable`，不将错就错。

### 12.5 可插拔

`src/rag/rerank.ts` 定义 `Reranker` 接口（`name` / `health()` / `rerank(query, documents, topK)`），
当前实现为 `LlamaCppReranker`（**一次批量请求**送全部候选，不逐条发 N 次）。
换模型或换托管服务只需另实现该接口，调用方不依赖 llama.cpp。

## 13. 检索验证口径

`npm run rag:search` 输出的 `score` 是 **Qdrant 的 Cosine 相似度**，属于向量召回结果。
每条结果都会打印 `knowledge_set` 与 `scope`，便于人工核验隔离是否生效。

**当前只有向量召回，尚未 Rerank。** 向量分数不构成重排，
也不会把多个向量分数加权后称作 Rerank——那不是重排，只是加权召回。
真正的 Reranker（独立的 query/chunk 相关性打分模型）在下一阶段接入。
