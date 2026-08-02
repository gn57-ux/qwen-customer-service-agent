# Feature 3: cli-commands — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |

## 项目架构

- 架构类型: monorepo 新增 CLI 层，`mastra-agent/scripts/experience-*.ts`
- 涉及层: 后端 CLI（复用 `mastra-agent/src/experience/` 的全部导出）

## 命令实现与 `package.json` 接线

参考现有 `mastra-agent/package.json` 的脚本命名风格
（`rag:ingest`/`rag:search`/`rag:test` 等），新增：

**⛔ 路径不带 `mastra-agent/` 前缀**——这些脚本要加进
`mastra-agent/package.json`（不是仓库根 `package.json`），npm 执行时的
工作目录本来就是 `mastra-agent/`，现有 `rag:ingest` 等脚本用的是
`src/rag/ingest.ts` 这种相对路径，不是 `mastra-agent/src/rag/ingest.ts`
（Codex Review 指出：若写成后者会解析成
`mastra-agent/mastra-agent/scripts/...`，路径不存在，命令全部会以
module-not-found 失败）：

```json
{
  "scripts": {
    "experience:ingest": "node --env-file-if-exists=../.env --import tsx scripts/experience-ingest.ts",
    "experience:rebuild": "npm run experience:ingest -- --rebuild",
    "experience:search": "node --env-file-if-exists=../.env --import tsx scripts/experience-search.ts",
    "experience:test": "node --env-file-if-exists=../.env --import tsx --test src/experience/*.test.ts",
    "experience:status": "node --env-file-if-exists=../.env --import tsx scripts/experience-status.ts",
    "experience:audit": "node --env-file-if-exists=../.env --import tsx scripts/experience-audit.ts",
    "experience:finalize": "node --env-file-if-exists=../.env --import tsx scripts/experience-finalize.ts"
  }
}
```

**"全局工作流只能调用这些稳定入口，不得复制业务逻辑"**——即：将来若要在
`~/.claude/commands/yd-ai-nodes/N8-finish.md` 里接线，正确写法是"运行
`npm run experience:finalize -- --input result.json`"这类对本仓库命令的
调用，而不是把 `write.ts`/`lifecycle.ts` 的逻辑抄一份到全局 md 文件里描述
成 AI 该怎么做。本 feature 只负责让这些命令**存在且稳定**，不涉及是否
真的接线全局文件（PLAN.md 已记录：本轮不改全局文件）。

## 功能模块设计

### 模块 1: `experience-ingest.ts`

```ts
const rebuild = process.argv.includes("--rebuild");
const cfg = loadExperienceConfig();
const embedder = await createEmbeddingClient(cfg); // 复用 rag/embedding.ts
const store = new ExperienceStore(cfg);
if (rebuild) await store.deleteIndex().catch(() => {}); // collection 不存在时忽略
await store.createIndex(embedder.dimension, "cosine");
// 扫描 knowledge/experience/**/*.md → parse → ingestExperience() 逐个调用
```

### 模块 2: `experience-search.ts`

解析 `--query`/`--stage`/`--task-type`/`--project-scope` 命令行参数，
调用 `retrieveExperience()`，打印 `formatForInjection()` 的结果 +
`degraded` 标记，供人工调试。

### 模块 3: `experience-status.ts`

```text
=== Claude Workflow Experience 状态 ===
Qdrant:      在线（claude_workflow_experience，123 points）
Embedding:   在线（bge-m3，1024 维）
Reranker:    在线
经验统计：candidate=5  verified=12  deprecated=2
```

三项连通性检测直接调用 `ExperienceStore.health()`/`createEmbeddingClient()`
的探测逻辑/`createReranker().health()`（`rag/rerank.ts` 已有
`RerankerHealth` 接口，直接复用）。任一服务不可用时该行显示"离线：{原因}"，
命令本身**不因单项服务不可用而以非零退出码失败**（这是巡检命令，报告
现状，不是健康检查门禁）。

### 模块 4: `experience-audit.ts`

```ts
// 1. 扫描 knowledge/experience/**/*.md
// 2. 逐个 validateExperience() 校验，收集失败项
// 3. 逐个 redact() 扫描原始文件内容（未脱敏的原文，因为 audit 的目的
//    就是发现"已落盘但脱敏规则本不该放行"的历史问题），只报告命中
//    行号+规则类型，不回显原文（需求 AC-006）
// 4. 对比文件系统的 document_id 集合 与 Qdrant 的 document_id 集合：
//    - 文件有但 Qdrant 无 → "孤儿文件，建议 experience:ingest 补齐"
//    - Qdrant 有但文件无 → "悬空向量点，建议 experience:rebuild 清理"
// 5. 输出报告，只读，不修改任何文件或向量点
```

### 模块 5: `experience-finalize.ts`（N8 专用）

```ts
interface FinalizeInput {
  codexVerdict: "ALLOW" | "BLOCK" | "ERROR";
  testsPassed: boolean;
  candidateDocumentIds: string[]; // 本轮 N5 阶段产出的候选经验
  evidence: { before: string; after: string }; // 修复前后证据摘要
}
```

命令读取一份 JSON 输入（文件路径或 stdin，避免命令行参数过长）。逐个
`candidateDocumentIds` 处理，**每个候选的"读取现状→校验→转换→持久化
写回"必须在同一次持锁区间内完成，不能锁只包在最后的写入那一步**
（Codex Review 指出：如果只在写入时才加锁，`finalize` 读到的
`currentStatus` 是"加锁之前的旧快照"，此时若有另一个并发操作——例如
一次内容更新走 Feature 1 的 `upsertExperience()`，或者一次把该经验
标记 `deprecated` 的操作——在 `finalize` 读完之后、写回之前完成，
`finalize` 会基于过期状态做出判断，可能把一条已经被标记 `deprecated`
的记录错误"复活"成 `verified`）：

1. `const lock = await acquireLock(lockPath)`（**复用 Feature 1
   `write.ts` 的同一把 `document_id` 级别锁**，返回值是 `LockHandle`
   而不是裸释放函数——不是另开一把独立的 finalize 专用锁，两类操作
   必须互斥同一把锁才能真正防止竞态）。
2. 锁内重新读取该候选**当前**的真实 `status`（不信任调用方传入的
   任何"预期状态"假设）。
3. 锁内调用 `canVerify(evidence)`（Feature 1）校验。
4. 全部满足 → 在内存里算好 `transitionIdempotent(currentStatus,
   "verified")` 的目标值（**不是裸 `transition()`**——两个并发
   `finalize` 处理同一候选时，后到达的请求在获取锁后重新读到的
   `currentStatus` 可能已经是 `verified`，`transitionIdempotent` 在
   这种"已达目标状态"的场景下直接返回、不抛错，效果等价于串行执行
   两次；若用裸 `transition()`，第二次调用会因 `verified→verified`
   被状态机判为非法转换而抛错，见 Feature 1 design.md 的 Codex
   Review 修正记录）。
5. **`await lock.assertStillHeld()`**——落盘之前的最后一道校验（见
   Feature 1 design.md 模块 3 的锁设计说明，这是唯一真正防止"两个
   进程都完成 finalize 写入"的强保证点，不依赖锁获取阶段完全无
   竞态）。抛出 `LockLostError` → 该候选本次 finalize 失败、保留
   读到的原状态不变，不写入任何文件/Qdrant payload，命令输出标注
   "锁已丢失，建议重新运行 finalize"（可重试，不是数据错误）。
6. 校验通过 → 原子写回 Markdown 的 `status` 字段并调用
   `ingestExperience()` 更新 Qdrant payload（对已存在向量点做
   payload-only 更新，不重新 embedding——`QdrantVector.upsert` 本身
   是覆盖写，需要连正文一起重新提交，或者用原生 REST 的
   `points/payload` 局部更新接口，设计上优先用后者，减少不必要的
   embedding 调用）。任一条件不满足（含 `canVerify` 未通过）→ 该候选
   保留读到的原状态不变，命令输出里明确列出"未晋升原因"。
7. `finally` 块调用 `lock.release()`（无论上述步骤是否抛错，必须
   释放，否则会阻塞后续任何针对该候选的写入/finalize 操作）。

命令末尾统计输出：

```text
=== 本轮经验统计 ===
新增 verified: 2
更新 verified（document_version 递增）: 1
复用（occurrence_count 累加，无新增文件）: 3
保持 candidate（未满足晋升条件）: 1
```

## 可移植性实现要点

- 所有路径拼接使用 `path.join`/`path.resolve`，不做字符串拼接；中文
  路径本身在 Node.js 里就是合法 UTF-8 字符串，只要不做 ASCII 假设
  （不用正则 `[a-zA-Z0-9_-]+` 去校验路径合法性）即可正常工作。
- 不出现任何 `os.homedir()` 拼接的硬编码项目名假设，所有"当前项目"
  信息来自 `process.cwd()` 或显式参数。
- 环境变量读取集中在 `rag/config.ts`/`experience/config.ts`，命令脚本
  本身不直接读 `process.env`（除了 `--rebuild` 这类命令行 flag）。

## 接口契约

CLI 参数与退出码约定：

| 命令 | 退出码 0 | 退出码非 0 |
| ---- | -------- | ---------- |
| ingest/rebuild | 全部文件摄取成功 | 任一文件校验/摄取失败 |
| search | 检索完成（含 degraded） | Embedding/Qdrant 均不可用导致无法执行 |
| test | 全部测试通过 | 任一测试失败 |
| status | 始终 0（巡检不失败） | - |
| audit | 始终 0（只读巡检） | - |
| finalize | 至少一条候选完成 verified 判定（无论晋升与否，只要流程正常跑完） | 输入 JSON 格式错误/候选 ID 不存在 |

## 数据模型

`experience-finalize.ts` 的 `FinalizeInput` JSON schema 见模块 5。

## 安全考虑

- `experience:audit` 报告脱敏（不回显敏感原文）。
- `experience:finalize` 是"晋升为可被检索"的唯一入口，命令本身不接受
  "强制跳过条件检查"的参数——不提供 `--force` 这类绕过开关。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| finalize 输入方式 | 命令行参数 vs JSON 文件/stdin | JSON——候选 ID 列表、证据摘要等结构化数据不适合塞进命令行参数 |
| status 变更是否重新 embedding | 全量 upsert vs payload 局部更新 | payload 局部更新——status 变化不影响正文语义，重新 embedding 是浪费 |
| status/audit 失败即非零退出 | 是/否 | 否——这两个是巡检命令，本身失败不应该让调用方（如 CI）误判为"经验系统坏了" |
| finalize 加锁范围 | 只锁最后写入 vs 锁住"读取现状→校验→转换→持久化"全程 | 全程加锁——Codex Review 指出只锁写入会让 finalize 基于过期状态判断，可能把已 deprecated 的记录错误复活；复用 Feature 1 `acquireLock`/`lockPathFor`（同一把锁），不新开独立锁 |
