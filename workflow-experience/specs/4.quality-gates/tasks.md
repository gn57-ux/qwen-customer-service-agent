# Feature 4: quality-gates — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: 测试聚合层
- specs 路径: workflow-experience/specs/4.quality-gates/

## 任务列表

### 功能 1: 清单对照与索引

- [x] T-001: 编写 `quality-gates.test.ts` 头部对照表（22 项清单 →
  具体测试文件+用例名的映射），作为可执行的"文档" ~15min —— 完成于
  2026-08-01：`CHECKLIST_MAPPING` 数组 + 一条自检断言（22 项齐全、
  每项都有非空覆盖来源），不是纯注释——清单本身写错/漏项会被
  `node:test` 直接跑出来，不依赖人工审阅保持同步。

### 功能 2: 跨模块新增测试

- [x] T-002: Hook 重入/并发 finalize 测试（不同 ID 互不阻塞、相同 ID
  正确串行且第二次调用通过 `transitionIdempotent` 幂等收敛，不抛错也
  不重复变更） ~30min —— 完成于 2026-08-01：
  `quality-gates.hook-concurrency.test.ts`，用 `Promise.all()` 真实
  并发触发两次独立的 `finalizeCandidates()` 调用（不是 mock 出并发），
  fake store 的 `updatePayload()` 故意加 20ms 延迟放大并发窗口。核心
  断言：相同候选 ID 并发时，两次结果集合恰好是
  `["already_verified", "promoted"]`（不是两次都 `promoted`，那意味着
  锁失效）；`occurrence_count`/`document_version` 不因第二次调用重复
  变化；不残留锁文件。**已验证跨 5 次重复运行结果稳定**，不是偶然
  凑巧通过一次。
- [x] T-003: 超时验证测试（假慢速 HTTP server + 环境变量调小超时） ~30min
  —— 完成于 2026-08-01：`quality-gates.timeout.test.ts`，用 Node 内置
  `http.createServer` 构造挂起 5s 才响应的假服务，把
  `RerankerConfig.requestTimeoutMs`/`healthTimeoutMs` 直接构造成
  200ms（不经过环境变量，`createReranker(cfg)` 本身就接受显式配置对
  象），断言真实耗时落在 [150ms, 2000ms) 区间——既确认超时机制真的
  生效（远小于 5000ms 服务实际响应时间），也确认没有被误判提前超时；
  另有一条对照组用例验证正常速度的服务不受影响。**范围收窄的记录**：
  `rag/embedding.ts` 的 `REQUEST_TIMEOUT_MS` 是模块内硬编码 120_000
  常量，不经 `RagConfig`/环境变量暴露，无法在不修改该文件、不真的等
  2 分钟的前提下验证；已实测确认 `node:test` 的 `mock.timers` 不会
  影响 `AbortSignal.timeout()`（Node 内部不经过 `setTimeout` 实现）。
  两处用的是同一个 `AbortSignal.timeout()` 机制，这里用 Reranker 一侧
  做代表性验证，Embedding 一侧按代码走查确认调用方式一致
  （`embedding.ts:44`），不重复引入一份等价但要跑 2 分钟的测试——这是
  经权衡后的合理收窄，不是遗漏。
- [x] T-004: AGENTS.md 不变性测试（前后快照哈希对比） ~15min —— 完成于
  2026-08-01：`quality-gates.agents-md.test.ts`，仓库根目录通过本
  文件路径向上解析得到（不硬编码绝对路径/用户名），运行一次真实的
  摄取+finalize 全流程（fake embedder/store，操作对象是临时
  knowledgeRoot，不写入仓库真实经验目录），前后对 `AGENTS.md` 拍
  哈希快照并断言相等——本仓库当前 `AGENTS.md` 本身不存在，两次快照
  都是 `null`，测试真实验证了"存在性与内容都不变"这一更宽的断言，不
  是巧合跳过。
- [x] T-005: 无配置降级测试（mock 环境变量指向不可达服务） ~30min
  —— 完成于 2026-08-01：`quality-gates.no-config.test.ts`，用保留
  端口 `127.0.0.1:1`（连接立即被拒绝，不需要等超时）模拟"全新项目
  未配置基础设施"，断言 `getExperienceStatus()` 三项服务探测全部
  优雅标注离线、不抛出未捕获异常，且与另一个并发的无关 Promise 互不
  拖累。

### 集成与测试

- [x] T-006: `experience:test:live` 命令接线（聚合需要真实服务的用例，
  对齐 `agent:test:live` 命名习惯），确认与 `experience:test`（纯逻辑）
  的分层边界清晰 ~15min —— **无需新增工作**：`experience:test:live`
  已在 Feature 2 建立（`src/experience/live/*.test.ts` 独立 glob）；
  本 feature 的全部新测试（T-002~T-005）按设计有意不依赖真实服务
  （并发/超时/AGENTS.md/无配置四个场景全部用 fake 或本地临时
  HTTP server 覆盖），因此没有新文件需要放进 `live/` 目录。**AC-001
  已做实测验证**（不是理论推断）：把 `QDRANT_URL`/
  `EMBEDDING_BASE_URL`/`RERANK_BASE_URL` 全部显式覆盖成不可达地址后
  重跑 `experience:test`，188/188 仍然全部通过，证明整套纯逻辑测试
  真的不依赖任何真实服务在线。

## 依赖关系

- T-001 依赖 Feature 1、2、3 全部完成（需要引用其测试文件）
- T-002~T-005 可并行（各自独立场景，无共享文件）
- T-006 依赖 T-002~T-005

## 风险点

- "语义相似但非完全相同"的去重明确定义为不适用范围（见
  requirements.md 功能需求第 4 条），如果后续用户期望更智能的语义
  去重，需要回到 Feature 2 设计阶段重新评估，不应该在本 feature 里
  临时加一个简化版语义相似度判断（会造成两处去重逻辑并存的混乱）。
