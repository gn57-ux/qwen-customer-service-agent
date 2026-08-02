# Feature 5: workflow-integration — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |
| 2026-08-01 | v1.1 | T-001~T-005 全部完成，195/195 测试通过 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: 文档 + 只读分析脚本
- specs 路径: workflow-experience/specs/5.workflow-integration/

## 任务列表

### 功能 1: 文档

- [x] T-001: `mastra-agent/README-EXPERIENCE.md` 架构章节 + Collection
  对照表 + 命令一览 ~30min — 完成。~200 行，含 READ/WRITE 文字架构图、
  Collection 对照表、全部 `experience:*` 命令一览 + `FinalizeInput`
  JSON 示例。
- [x] T-002: N1-N8 逐节点建议接入点示例（同一文件章节）+ 边界声明
  ~15min — 完成。逐节点标注建议接入方式（N1 可选、N2/N3 执行态检索、
  N4 评审态检索、N5 只生成候选不自动写入、N6 QA 证据时机说明、N8
  finalize 门禁在 ALLOW 后触发）；边界声明明确不修改 `AGENTS.md`/
  `~/.claude/**`，并引用 Feature 4 的离线可运行实证结论。
- [x] T-003: `.claude/CLAUDE.md` 追加一行引用（只增不改） ~5min — 完成。
  `git diff` 确认为纯新增 3 行，插入在冻结范围说明与"## 技术栈"之间，
  未改动任何既有行。

### 功能 2: 候选规则生成器

- [x] T-004: `experience-suggest-rules.ts`（复用 audit 的文件扫描 +
  Feature 1 的 redact/原子写入），输出到 `workflow-experience/
  suggested-rules/`（**不在** `knowledge/experience/` 摄取根目录下，
  避免被 `experience:ingest`/`rebuild`/`audit` 误扫描，见 design.md
  的 Codex Review 修正记录） ~30min — 完成。`buildSuggestions()` 过滤
  `status=verified && occurrence_count>=阈值`（默认 3，可用
  `EXPERIENCE_RULE_THRESHOLD` 覆盖）；候选内容再跑一次防御性
  `redact()`，命中 `blocked` 时整条跳过、只留 `document_id`+原因，不
  回显原文；报告经 `atomicWriteExperience()` 原子写入
  `workflow-experience/suggested-rules/YYYY-MM-DD.md`。CLI 包装
  `scripts/experience-suggest-rules.ts` 已跑通真实闭环（对当前仓库
  空知识库运行，输出"候选规则：0 条，跳过：0 条"，未抛异常，报告文件
  正常生成）。
- [x] T-005: AGENTS.md 不变性测试（同 4.T-004 模式，独立断言本 feature
  的生成器不触碰它）+ 阈值过滤正确性测试（AC-003）+ `blocked` 内容
  排除测试（AC-005：含 Token 样式字符串的候选被跳过、不回显原文）
  ~30min — 完成。`suggest-rules.test.ts` 新增 7 个测试：阈值过滤 3 个
  （含边界值 `>=` 而非 `>`）、blocked 内容排除 1 个（断言报告文本不含
  原始 Token 片段）、端到端 3 个（报告内容正确性 + AGENTS.md
  内容哈希前后不变 + 报告目录不污染 `scanExperienceFiles()` 扫描结果 +
  候选数为 0 时不抛异常）。`experience:test` 全量 195/195 通过（较
  Feature 4 完成时的 188 增加 7），`npm run test`（typecheck +
  agent:test:unit + experience:test）全链路通过。

## Codex Review 第一轮修复（2026-08-01）

- [P1] `config.ts` 的 `knowledgeRoot` 默认值 `"knowledge/experience"`
  是相对路径，按文档化的 `npm run experience:*` 用法（cwd=
  `mastra-agent/`）会解析成 `mastra-agent/knowledge/experience`，不是
  仓库根 `knowledge/experience`——ingest/audit/status/finalize 在未
  显式设置 `EXPERIENCE_KNOWLEDGE_ROOT` 时全部看到空目录。修复：仿照
  `rag/ingest.ts` 用 `import.meta.url` 锚定仓库根的既有模式，新增
  `REPO_ROOT` 常量，`knowledgeRoot` 一律 `path.resolve(REPO_ROOT, ...)`
  解析成绝对路径（`env` 覆盖值若本身是绝对路径，`path.resolve` 会
  正确忽略前面的 `REPO_ROOT`）。`config.test.ts` 两处断言默认值/env
  覆盖值的测试同步改为对比 `path.resolve(REPO_ROOT, ...)` 而不是裸
  相对字符串，并新增一条 `path.isAbsolute()` 断言。已用真实 CLI
  重跑 `experience:suggest-rules`/`experience:status` 验证：解析到
  仓库根 `knowledge/experience/`（当前为空目录，符合预期），不是
  `mastra-agent/` 下的同名路径。
- [P2] `finalize.ts` 的 `already_verified` 幂等分支（`targetStatus ===
  fm.status`）直接返回，从不重新调用 `store.updatePayload()`——如果
  上一次 finalize 是"Markdown 写入成功、`updatePayload()` 因 Qdrant
  瞬时不可用而失败"这种中途失败，向量 payload 会永久停留在旧
  `status`，被检索的 status 过滤条件排除，重试也无法自愈（重试会
  立即命中这个分支直接返回，从未重新尝试 payload 更新）。修复：把
  `chunkIds` 计算提到两个分支之前复用，`already_verified` 分支在
  返回前也执行一次幂等的 `store.updatePayload(chunkIds, { status:
  targetStatus })`；该调用失败时和"晋升"分支一样直接抛出，不吞错误、
  不谎报 `already_verified`。`finalize.test.ts` 原有"已经是 verified
  时不重复写入"测试的断言从"`updatedPayloads.length === 0`"改为
  "长度为 1 且 ids/payload 与晋升分支一致"，準确反映新行为（Markdown
  不重复写，但向量 payload 每次都幂等协调）。
- 均已运行 `npm run typecheck` + `npm run experience:test`
  （195/195，测试数量不变，只是修改已有断言）+ `npm run test`
  （82/82 + 195/195）确认无回归。

## T-006: 真实接入 ~/.claude 全局 yd 工作流（用户明确授权后新增范围，2026-08-01）

在 T-001~T-005（文档 + 只读生成器，不碰 `~/.claude`）之上，用户明确指示扩大范围：
真实接入 `~/.claude` 的 yd 工作流，使任意项目跑 `/yd:ai`/`/yd:prd` 时能检索/沉淀
跨项目经验。严格边界：改前先建时间戳备份、只改 yd-workflow 相关 command/node
文件、不碰认证/账号/聊天记录、子系统不可用时原工作流必须与接入前表现一致、
全局改动只生成脱敏可移植模板不提交真实本机配置、不 git add/commit/push。

- **备份**：`~/.claude/backups/experience-integration-20260801-1507/`（复制
  `commands/yd-ai-nodes/{N2,N5,N8}.md` + `commands/yd:prd.md` 改动前版本，
  `diff` 逐字节确认与原文件一致后才开始编辑）。
- **新增 CLI**：`mastra-agent/scripts/experience-write.ts`（N5 写候选专用，
  Feature 3 之前只有 ingest/rebuild/search/status/audit/finalize 六个命令，
  缺一个"写入新候选"的入口）。核心逻辑落在
  `src/experience/write-and-ingest.ts` 的 `writeExperienceWithFallback()`：
  先完成 Feature 1 的纯 Markdown 写入（本地、无网络依赖），**只有写入成功
  才**尝试创建 Embedding 客户端——顺序不能反过来，候选内容本身不合法时
  不该先付一次网络探测成本；探测失败退化为只完成 Markdown 写入，跳过向量
  摄取，`writeExperienceAndIngest()` 内部拆出共用的 `ingestAfterWrite()`
  辅助函数，避免重复"读回→解析→摄取"逻辑。
- **测试**：`write-and-ingest.test.ts` 新增 3 项（探测成功/探测失败降级/
  写入失败不触发探测）——`experience:test` 195→**198/198 通过**，`npm run
  test` 82/82 + 198/198，无回归。
- **全局 `~/.claude` 改动**（均为纯新增小节，未删除/改写任何既有内容，可
  对照备份逐字核对）：
  - `commands/yd-ai-nodes/N2-enter-feature.md` — 新增"工作流经验 RAG —
    跨项目检索（读端）"，与既有"Learning Loop 检索 Memory（读端）"并列、
    互不替代。
  - `commands/yd-ai-nodes/N5-mark-done.md` — 新增"工作流经验 RAG —
    跨项目沉淀（写端）"，从既有 memory/{slug}.md 内容扩写成 9 节经验正文，
    调用 `experience:write`，只产出 `candidate`，document_id 追加进
    `{SPECS_DIR}/.experience-pending.jsonl`（本次运行的临时候选清单）。
  - `commands/yd-ai-nodes/N8-finish.md` — 新增"工作流经验 RAG — 候选晋升
    （finalize）"，读取 `.experience-pending.jsonl` 批量调用
    `experience:finalize`（`codexVerdict=ALLOW`/`testsPassed=true` 固定值，
    理由：能走到 N8 说明每个候选对应的 task 都已在 N4 拿到
    `CODEX_REVIEW_ALLOW`），执行完删除该临时文件。
  - `commands/yd:prd.md` — Step 8（design.md 生成）新增可选检索，复用同一套
    `experience:search`，`stage` 统一用 `execute`（未新增 `init`/`prd`
    专属 stage，避免改动 Feature 1 已冻结的枚举）。
  - 四处改动统一的降级规则：`YD_EXPERIENCE_REPO` 环境变量未设置 →
    静默跳过；已设置但命令报错/非零退出 → 同样静默跳过，不重试、不暂停、
    不向用户报告底层原因——原 yd 工作流在子系统完全不可用时表现应与接入前
    完全一致。全局文件里不出现任何机器相关的绝对路径，一律通过
    `YD_EXPERIENCE_REPO` 环境变量间接引用（该变量本身在用户 shell profile
    里配置，不写进 `~/.claude` 任何文件）。
  - 未接入：`/yd:init`（项目脚手架生成，没有自然的检索用 taskDescription，
    价值存疑）、N4/N6（既有 PII 过滤/Codex 仲裁/QA 机制已足够严谨，判断
    不需要额外接入点）——记录在 `workflow-experience/yd-integration/
    README.md`"已知边界"一节，非阻塞。
- **可移植模板**：改动后的 4 个文件复制进本仓库
  `workflow-experience/yd-integration/commands/`（`grep` 确认不含任何
  `/Users/xxx` 类机器相关路径），供未来审查/版本管理/分发；`README.md`
  记录安装步骤（复制到 `~/.claude/commands/` + 设置 `YD_EXPERIENCE_REPO`）
  与设计要点。
- **端到端 dry-run**（`YD_EXPERIENCE_REPO` 指向本仓库，针对真实在线的
  Qdrant/Ollama/Reranker 服务）：`experience:search`（空库，`degraded=true
  (qdrant_unavailable)`，实际是 collection 未创建，验证了降级路径）→
  `experience:write`（候选落盘成功，`ingested=false (Not Found)`——
  collection 尚不存在时的预期首次写入表现，Markdown 不受影响）→
  `experience:rebuild`（创建 collection，验证首次使用的恢复路径）→
  `experience:search`（`召回 0 条`，正确排除未晋升的 candidate）→
  `experience:finalize`（`新增 verified: 1`）→ `experience:search`（
  `召回 1 条`，找到刚晋升的经验，closes the loop）。**dry-run 过程中
  发现并修复了 N5/N8 节点文件里的两处真实 bug**（若不修，未来真实运行会
  在这两步失败）：
  1. 经验正文缺少 Feature 1 强制要求的一级标题 `# {标题}`（AC-027 校验），
     N5 的正文模板补上首行 `# {标题}`。
  2. `--input <(cat <<EOF ... EOF)` 进程替换在 `npm run` 转发子进程时
     `Unexpected end of JSON input`（fd 未能存活到 node 读取的时刻），
     N5/N8 均改为"先用 Write 工具写临时文件，再 `--input {路径}`"。
  dry-run 产生的测试数据（`dry-run-project` 经验文档 + 对应向量点）已在
  验证后清理干净：删除 `knowledge/experience/dry-run-project/`，
  `experience:rebuild` 重建 collection，`experience:status` 确认
  `candidate=0 verified=0 deprecated=0`，恢复到测试前的空状态。
- **未 git add/commit/push**：`git status --short` 确认冻结路径
  （`services/**`/`datasets/**`/`training/**`/`configs/**`/`knowledge/**`/
  `models/**`）无改动，`git diff --cached` 为空。

## T-007: Codex Review 第一轮修复 + /yd:init 接入 + 降级提示统一（2026-08-01）

T-006 提交后 Codex Review 报告 3 项 finding（均已修复），随后用户进一步明确
两项范围补充：`/yd:init` 增加检索入口；四个接入点的"静默跳过"统一改为单次
简洁降级提示。

**Codex Review 修复**：

1. [P1] N8 finalize 失败时仍无条件删除 `.experience-pending.jsonl`，导致
   候选 document_id 引用永久丢失（下次 N8 运行无法重试）。修复：改为只在
   `experience:finalize` 退出码为 0（本批候选全部拿到已解决终态）时才删除；
   非 0 退出保留文件。
2. [P1] `finalize.ts` 对不存在的向量点调用 `updatePayload()` 会被 Qdrant
   静默忽略、不报错，导致"晋升成功"但实际检索不到——发生在
   `experience:write` 曾因 Embedding/Qdrant 不可用而降级为"只写 Markdown、
   跳过摄取"的候选上。修复：`store.ts` 新增 `pointsExist(ids)`（Qdrant
   原生 REST"按 id 批量获取点"，只返回真实存在的点）；`finalize.ts` 在
   写 Markdown/更新 payload 前先核实，缺失时返回新增的 `vectors_missing`
   结果，不写 Markdown、不调用 `updatePayload`，Markdown 状态原样保留可
   安全重试。
3. [P2] `experience-finalize.ts` CLI 只在"全部候选都是 not_found"时才
   非零退出，一批里混了一个有效候选和一个 `not_found` 时仍返回 0，
   N8 因此会误删还需要重试的候选清单。修复：改为只要批次里有任意
   `not_found`/`lock_lost`/`vectors_missing`（均为可重试的未决态）就
   非零退出；只有全部候选都拿到已解决终态（`promoted`/
   `already_verified`/`not_promoted`）才算成功。
   - `finalize.test.ts` 新增 2 项（向量缺失时不谎报 promoted/
     already_verified），`fakeStore()` 新增可配置的 `pointsExist` 行为；
     `quality-gates.agents-md.test.ts`/`quality-gates.hook-concurrency.test.ts`
     的 fake store 夹具补上 `pointsExist` 默认返回 `true`（否则会因缺少
     该方法直接抛错，与本次修复无关但受影响）。
   - `experience:test` 195→**200/200**，`npm run test` 82/82 + 200/200，
     无回归。

**新增范围（用户明确指示）**：

1. `/yd:init` 新增"1.5 检索相关经验"——分析项目技术栈后、生成文件结构前，
   检索一次"项目初始化/技术栈/常见风险"相关 verified 经验，`stage=execute`
   `project-scope=global`（新项目没有既有 project_scope，直接查全局）；
   降级/空结果处理与 N2 一致。改前先备份
   `~/.claude/commands/yd:init.md`（复用本轮 `experience-integration-
   20260801-1507` 备份目录）。
2. 四个接入点（N2/N5/N8/`/yd:prd`/`/yd:init`）的"静默跳过"统一改为单次
   固定降级提示：`经验增强本次不可用，已跳过，不影响当前工作流。`（不含
   机器路径/端口/堆栈/环境变量值/原始报错文本）。**区分"降级"与"正常
   空结果"**：命令失败/未配置 → 输出提示；命令成功但召回为空、或 N8
   当次运行没有候选 → 不输出提示（这两种是正常状态，不是子系统不可用，
   逐次提示反而是噪音）。

**验证**：
- `experience:test`/`npm run test` 见上（200/200、82/82 + 200/200）。
- 端到端 dry-run（真实在线服务）：
  1. `/yd:init` 检索命令：`degraded=false`，`召回 0 条`（空库，符合预期，
     确认命令本身工作正常）。
  2. gating 逻辑（`YD_EXPERIENCE_REPO` 未设置 / 指向不存在路径）：均正确
     输出标准降级提示。
  3. **vectors_missing 回归**：用不可达 `EMBEDDING_BASE_URL` 写入候选
     （`ingested=false`）→ `experience:finalize`（真实 Qdrant）→ 输出
     "向量点缺失：1"，**真实退出码 1**（非管道遮蔽的伪造值），Markdown
     `status` 确认仍是 `candidate`，未被误判为 `verified`。
  4. **恢复路径**：`experience:rebuild` 补齐向量点后重跑 finalize →
     "新增 verified: 1"，退出码 0。
  5. **混合批次回归**：候选列表混入一个有效 id + 一个 `does-not-exist`
     → 退出码 **1**（此前的 bug 会返回 0），验证 finding 3 的修复生效。
  6. dry-run 测试数据（`dry-run-project-2` 经验文档 + 向量点）已清理，
     `experience:rebuild` 重建、`experience:status` 确认恢复
     `candidate=0 verified=0 deprecated=0`。
- 模板同步：`workflow-experience/yd-integration/commands/` 新增
  `yd:init.md`，重新同步 N2/N5/N8/`yd:prd.md`；`README.md` 更新"降级
  提示统一""finalize 向量核实""N8 待处理清单保留"三条设计要点 + 新增
  "回滚"与"Review 策略"小节；`grep` 确认全部文件仍不含机器相关绝对路径。
- 未 `git add`/`commit`/`push`，冻结路径无改动。

## T-008: bulk-ingest.ts 孤儿向量点清理 + rebuild 删除失败中止（2026-08-01，Codex Review 最后一轮定向修复）

T-007 收尾后 Codex Review 又报告 2 项 finding（同一文件 `bulk-ingest.ts`，
同一主题：摄取侧未完全清理/同步陈旧 Qdrant 状态），已达到本 task 的 Review
轮次上限（Stop Hook 4/4），用户明确指示这是最后一次定向修复，只改
`bulk-ingest.ts` 本身，不再扩大范围、不再触发自动复审。

**修复 1 [P1]：增量 `experience:ingest`（不带 `--rebuild`）不清理孤儿向量点**
（`bulk-ingest.ts:42`）——文档被删除、或编辑成无法通过校验的内容后，
旧向量点原样保留，若旧版本是 `verified`，检索会继续命中一份已经不存在/
已失效的经验。修复：扫描循环里把**结构校验通过**（不要求本次
`ingestExperience()` 一定成功——摄取失败大多是瞬时故障，不能因为一次
瞬时失败就把仍然合法的旧向量当孤儿清理掉）的 `document_id` 收集进
`validDocumentIds`；扫描完成后（仅非 `--rebuild` 路径）用
`store.listPoints({knowledgeSet: store.knowledgeSet})` 取出这个
knowledge_set 范围内全部现存点，`document_id` 不在 `validDocumentIds`
里的即为孤儿，批量 `store.deletePoints()`。`deprecated` 但内容仍合法的
文档不受影响——照常通过校验、走正常 upsert 覆盖 payload，不是孤儿。

**修复 2 [P1]：`--rebuild` 的 `deleteIndex().catch(() => {})` 吞掉所有
错误**（`bulk-ingest.ts:30`）——`@mastra/qdrant` 底层已经正确区分
"collection 不存在"（视为已删除，直接返回）和真实删除失败（抛出
`MastraError`），问题出在 `bulk-ingest.ts` 又包了一层无条件
`.catch(() => {})`，把真实删除失败也吞掉，导致真实失败时静默继续对着
未清空的旧 collection 摄取，还报告"已完成 rebuild"。修复：去掉这层
catch，直接依赖底层库已经正确的错误语义；真实失败原样抛出，中止整个
`runBulkIngest()`，不返回 report——CLI 的 `main().catch()` 会打印错误、
非零退出，不会假装同步成功。

**"无法安全确认待删点" 的落地**：`listPoints()`/`deletePoints()` 均未
包 try/catch，Qdrant 不可达等故障直接抛出、中止整个函数，不返回看似
成功的 `BulkIngestReport`。

**测试**：`bulk-ingest.test.ts` 新增 9 项——增量清理 7 项（文件删除后
清理/校验失败后清理/deprecated 但合法不清理/单次摄取瞬时失败不误清理/
清理只按 knowledgeSet 查询不误伤客服知识库/`--rebuild` 路径不做孤儿
清理/核实阶段本身失败必须抛出不返回成功 report）+ rebuild 删除失败 2
项（真实失败必须抛出且不再继续摄取/正常场景不受影响）。`fakeStore()`
夹具新增 `listPoints`/`deletePoints`/`deleteIndexShouldThrow` 配置项；
`quality-gates.agents-md.test.ts` 的 fake store 补上 `listPoints`/
`deletePoints`（否则新代码路径会因缺方法直接抛错，与本次修复无关但
受影响，`portability.test.ts` 已有 `listPoints` 无需改动）。
`experience:test` 200→**209/209**，`npm run test` 82/82 + 209/209，
`git diff --check` exit 0。

**端到端 dry-run（真实在线服务，独立临时 project_scope，测试后清理）**：
写入两份候选（doc-a/doc-b）→ 均晋升 verified → 检索确认 doc-a 可命中 →
删除 doc-a 的 Markdown 文件 → `experience:ingest`（不带 `--rebuild`）
输出"清理孤儿向量点：9 个" → 检索确认 doc-a 已不可再命中、doc-b
不受影响仍可命中 → 交叉核对 `customer_service_knowledge` collection
点数（46）在全程前后不变，确认孤儿清理严格限定在
`claude_workflow_experience` collection，未触达客服知识库。测试数据
已清理，`experience:rebuild` 重建、`experience:status` 确认恢复
`candidate=0 verified=0 deprecated=0`。

**残余已知边界**（记录，非本次范围）：孤儿清理依赖 `listPoints()` 做一次
全量 scroll 取出 knowledge_set 下所有点再在内存里比对——量级较大时
（远超当前实际使用规模）会有一次性能成本，未做分页/增量优化；判断为
可接受，留待后续按实际数据量决定是否需要优化。

**Git 状态**：未 `git add`/`commit`/`push`，`git status --short` 确认
冻结路径无改动，`git diff --cached` 为空。

## 依赖关系

- T-001、T-002 依赖 Feature 3 全部完成（文档要准确描述真实存在的命令）
- T-003 可独立执行
- T-004 依赖 Feature 1、Feature 3（复用 audit 的扫描逻辑，需其先存在）
- T-005 依赖 T-004

## 风险点

- 文档类任务容易随代码演进过时——建议在 Feature 1-3 后续如有接口签名
  变化时，同步检查本 feature 产出的文档是否需要更新（不在本 feature
  当前范围内新增自动化文档一致性检查，属于可接受的手工维护成本）。
