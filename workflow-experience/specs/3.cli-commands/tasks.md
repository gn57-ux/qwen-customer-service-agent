# Feature 3: cli-commands — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 新增 CLI 层
- specs 路径: workflow-experience/specs/3.cli-commands/

## 任务列表

### 功能 1: 摄取与检索命令

- [x] T-001: `experience-ingest.ts`（含 `--rebuild` 分支）+
  `package.json` 接线 `experience:ingest`/`experience:rebuild` ~30min
  —— 完成于 2026-08-01：核心逻辑 `src/experience/bulk-ingest.ts` 的
  `runBulkIngest()`（扫描→逐个校验→`ingestExperience()`，
  collection 不存在时才 `createIndex`，`--rebuild` 先 `deleteIndex`），
  CLI 薄封装 `scripts/experience-ingest.ts`。`bulk-ingest.test.ts`
  6 项。**真实服务冒烟通过**：对独立临时 collection/knowledgeRoot
  跑通摄取，产出 9 个向量点/文档，事后清理无残留。
- [x] T-002: `experience-search.ts` + `package.json` 接线
  `experience:search` ~15min —— 完成于 2026-08-01：直接调用
  Feature 2 `retrieveExperience()` + `formatForInjection()`，打印
  `degraded` 标记。**真实服务冒烟通过**：candidate 状态经验被正确
  排除在默认（status=verified）检索之外，finalize 晋升后能被检索到。

### 功能 2: 巡检命令

- [x] T-003: `experience-status.ts`（三项服务连通性 + 经验数量统计）+
  接线 `experience:status` ~30min —— 完成于 2026-08-01：核心逻辑
  `src/experience/status.ts` 的 `getExperienceStatus()`，三项探测
  `Promise.all` 并发、任一失败只标注"离线"不影响其余字段；按
  status 分组统计的是**文档数（Markdown 文件数）不是向量点数**（每
  文档 9 个 chunk，直接数点会放大 9 倍）；`createEmbeddingClient` 通过
  可注入的 `CreateEmbeddingClientFn` 参数解耦，单测不依赖真实
  Embedding 服务。`status.test.ts` 5 项。**真实服务冒烟通过**。
- [x] T-004: `experience-audit.ts`（frontmatter 校验/脱敏扫描/孤儿文件/
  悬空向量点，只读不改）+ 接线 `experience:audit` ~30min —— 完成于
  2026-08-01：核心逻辑 `src/experience/audit.ts` 的
  `auditExperience()`，脱敏扫描先对整份文件跑一次 `redact()` 判定
  "是否命中"，命中后再逐行跑 `redact()` 定位行号（跨行专属规则命中
  但逐行定位不到时标注 `fileLevel: true`，不编造不准确的行号），报告
  只含行号不含匹配到的原文。孤儿/悬空向量点通过对比文件系统
  document_id 集合与 `store.listPoints()` 得到的 document_id 集合
  完成。`audit.test.ts` 7 项（含 AC-006 的"报告文本不包含敏感原文"
  显式断言）。**真实服务冒烟通过**。
- [x] T-003b（design.md 未列编号，Feature 2 `ExperienceStore` 的
  必要补充）：`store.ts` 新增 `updatePayload()`（Qdrant 原生 REST
  的 `points/payload` 局部更新）与 `ingest-pipeline.ts` 导出
  `stableChunkId()`（供 finalize 免查询直接算出目标点 ID）——这两处
  改动都在 Feature 2 的文件里，Feature 2 本身已完成/不算重开，是
  T-005 finalize 的直接前置依赖，随 T-005 一并完成。

### 功能 3: finalize 与自检

- [x] T-005: `experience-finalize.ts`（JSON 输入、逐候选晋升判定、
  payload 局部更新、统计输出）+ 接线 `experience:finalize` ~30min
  —— 完成于 2026-08-01：核心逻辑 `src/experience/finalize.ts` 的
  `finalizeCandidates()`，严格按 design.md 的加锁范围实现——复用
  Feature 1 `acquireLock`/`lockPathFor`/`LockLostError`（同一把锁，
  不新开），"读取现状→`canVerify()`校验→`transitionIdempotent()`
  →`assertStillHeld()`→原子写回→payload 更新"全程在同一次持锁区间
  内完成；`document_id` 到文件路径的定位靠递归扫描
  `experienceRoot`（跳过 `.superseded`），不要求调用方传路径。
  `finalize.test.ts` 10 项（覆盖 AC-004/AC-005：ALLOW+测试通过晋升、
  非 ALLOW/测试未过/隐私命中均保持 candidate、幂等收敛、
  deprecated 不可复活、候选找不到不中断其余候选、updated_at 刷新但
  occurrence_count/document_version 不变、不残留锁文件）。**真实服务
  冒烟通过**：finalize 后 Markdown 文件 `status` 字段与 Qdrant 向量点
  payload 均正确更新为 `verified`，随后 `experience:search` 确实能
  检索到。
- [x] T-006: `experience:test` 接线（聚合 Feature 1/2/3 全部
  `*.test.ts`） ~15min —— **无需额外工作**：`experience:test` 脚本
  用的是 `src/experience/*.test.ts` glob（第二十五轮 Codex Review
  时已固化进 `npm test` 链路），Feature 3 的全部新测试文件放在
  同一目录，自动被拾取，不需要手动登记。

### 集成与测试

- [x] T-007: 中文路径 + 环境变量覆盖 + 目录缺失不影响宿主项目 的
  可移植性测试，覆盖 AC-001~AC-003 ~30min —— 完成于 2026-08-01：
  新建 `portability.test.ts` 4 项。AC-001 额外用专门构造的中文名
  临时目录验证（不只依赖"仓库路径本来就是中文"这一环境巧合，虽然
  这一巧合本身也是持续证据——本仓库路径
  `/Users/ruolan/Documents/ai客服` 全程就是中文路径）；AC-002 直接
  断言 `experience:status` 报告的 collection 名是覆盖值；AC-003
  验证 `knowledgeRoot` 不存在时核心函数优雅返回空结果，配合
  "这个仓库当前确实没有 `knowledge/experience/` 目录，
  `agent:test:unit` 全程持续通过"这一持续存在的端到端证据。
- [x] T-008: finalize 晋升/保留 candidate 的端到端测试 + audit 脱敏
  报告不回显原文的测试，覆盖 AC-004~AC-006 ~30min —— **已随 T-005/
  T-004 完成**：`finalize.test.ts`（AC-004/AC-005）、
  `audit.test.ts`（AC-006）已经覆盖，未重复建新文件；另有真实服务
  端到端手工冒烟（ingest→status→audit→search(0条,candidate被过滤)
  →finalize→search(1条,verified被召回)→status），验证了 AC-004/
  AC-005 在真实 Qdrant/Embedding 服务下的完整链路，事后清理无残留。

`npm run experience:test` **179/179 通过**，`npm run test`
（typecheck + agent:test:unit + experience:test）**82/82 + 179/179
全部通过**。`tsconfig.json` 补充 `scripts/**/*.ts` 到 `include`——
Feature 3 的 CLI 脚本放在 `mastra-agent/scripts/`（design.md 明确
要求，与 `rag:ingest` 等脚本放 `src/rag/` 的既有惯例不同），若不
加这一行，`npm run typecheck` 会完全跳过对这些脚本的类型检查。

## 依赖关系

- T-001 依赖 Feature 2 全部完成（T-001~T-008）
- T-002 依赖 T-001（需要有数据可搜）
- T-003、T-004 依赖 T-001
- T-005 依赖 T-001、Feature 1 的 `canVerify`/`transition`
- T-006 依赖 T-001~T-005（需要有测试文件可聚合）
- T-007、T-008 依赖 T-001~T-006 全部完成

## 风险点

- `experience:finalize` 的 payload 局部更新依赖 Qdrant 原生 REST
  的 `points/payload` 接口，若 `QdrantVector` 未来版本行为有变化需要
  重新核实该接口路径与请求格式（与 `store.ts` 里其他"原生 REST 补充"
  操作同类风险）。
- 中文路径测试需要在真实的 `/Users/ruolan/Documents/ai客服` 路径下跑，
  不能只在临时英文路径下测试后就假设通过——这正是本项目自身路径就是
  最佳测试环境的原因。
