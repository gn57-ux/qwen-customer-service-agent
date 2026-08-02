# Feature 4: quality-gates — 需求规格

## 概述

把用户要求的 22 项质量/安全测试逐一落地为自动化 `node:test` 用例。
Feature 1-3 各自的 tasks.md 已经覆盖了与其直接相关的单元测试，本
feature 补齐**跨模块的端到端/边界测试**——尤其是"客服知识库隔离性"
"Hook 边界"这类必须真实起停服务、真实对比前后状态才能验证的场景，
不能靠 Feature 1-3 内部的单元测试自然覆盖。

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo，测试聚合层

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始需求 |

## 用户故事

- 作为经验系统的维护者，我想要一份可重复运行的端到端质量门禁，以便
  任何后续改动都能快速确认没有破坏隔离性、幂等性、生命周期等核心保证。

## 功能需求（对应用户要求的 22 项测试，按已在 Feature 1-3 覆盖 vs 需
本 feature 补齐 分类）

**已在 Feature 1-3 的 tasks.md 内落地（本 feature 只需引用，不重复写）**：
1. 客服 Collection 与经验 Collection 完全隔离 → 2.AC-001
2. experience 摄取不会删除或修改 customer_service_knowledge → 2.AC-001
3. 相同经验重复写入幂等 → 1.AC-003
4. 相似经验去重 → 1.AC-003/AC-004（"完全相同"与"版本递增"两档；语义
   相似但非完全相同的去重属于设计上明确排除的范围，见 1.design.md
   模块 1 说明——本 feature 需要补一条**明确的"不适用范围"测试**：验证
   系统对"语义相似但 document_id 不同"的两条经验确实会各自成文而不是
   错误合并，避免有人误以为这属于 bug）
5. occurrence_count 正确增加 → 1.AC-003
6. Markdown 原子写入 → 1.AC-006
7. 并发锁 → 1.AC-007
8. candidate 不参与默认检索 → 2.AC-002
9. deprecated 不参与默认检索 → 2.AC-002（补充：需要一条针对
   `deprecated` 单独状态的用例，`AC-002` 原文主要覆盖 candidate，本
   feature 补 deprecated 分支）
10. verified 正常召回 → 2.AC-005
11. metadata 过滤 → 2.AC-006
12. Reranker 可用与降级分支 → 2.AC-003
13. Embedding/Qdrant 不可用时工作流继续 → 2.AC-004
14. 敏感信息扫描 → 1.AC-005
15. 绝对路径脱敏 → 1.AC-005（同一测试覆盖）
18. N8 ALLOW 才能 finalize → 3.AC-005
19. BLOCK 不得写 verified → 3.AC-004
21. 不触碰客服训练数据与维修文档 → 2.AC-001（同一验证覆盖 datasets/
    training/configs/knowledge/repair 均不受影响）

**本 feature 需要新增的测试（Feature 1-3 未直接覆盖）**：

1. [F-001] Hook 重入保护验证：模拟两个进程同时调用
   `experience:finalize` 处理**不同**候选 ID，验证互不干扰（这验证的是
   Feature 1 并发锁在 finalize 场景下的实际效果，不是重新设计一套锁）；
   并验证同时处理**相同**候选 ID 时按锁机制正确串行、且第二个请求通过
   `transitionIdempotent()` 幂等收敛——**明确定义"幂等"的验收口径**
   （Codex Review 指出：状态机里 `verified→verified` 是被拒绝的非法
   转换，"两次调用都成功且最终状态一致"不能理解成"两次都执行了真正的
   状态转换"，而是"第一次真正转换 candidate→verified，第二次识别已达
   目标状态直接返回成功、不重复转换、不报错"）：两次调用都不抛错、
   `status` 最终确定为 `verified`、`occurrence_count`/`document_version`
   不因第二次调用而重复变化。
2. [F-002] Hook 超时验证：模拟 `redact()`/`retrieveExperience()` 在
   服务响应极慢时不会无限阻塞——验证现有超时配置（复用 `rag/
   embedding.ts` 的 `REQUEST_TIMEOUT_MS`、`rag/rerank.ts` 的等价配置）
   确实生效，不是新增超时逻辑。
3. [F-003] 不修改 AGENTS.md：运行完整摄取+finalize 流程前后，对比
   仓库内是否存在 `AGENTS.md` 文件、若存在其内容哈希是否变化——必须
   完全不变（Feature 5 的"建议生成器"只输出到别的位置，不写这个文件）。
4. [F-004] 新项目无 experience 配置时原工作流仍可运行：在一个全新的
   临时目录（无 `knowledge/experience/`、无相关环境变量）里验证
   `experience:status` 优雅报告"未配置"而不是抛出未捕获异常，且不
   影响该临时目录里其他假设存在的 `yd` 工作流命令（用最小 mock 验证
   "找不到配置 = 优雅跳过"这条路径，而不是要求真的搭一个完整宿主项目）。

## 非功能需求

- 所有测试必须可在无网络、Qdrant/Ollama 未启动的降级路径下至少跑通
  "降级分支"部分（不能要求测试环境必须有完整服务链路才能执行任何
  测试——但涉及"真实服务健康"的用例仍需要真实服务，按现有
  `rag.test.ts`/`rerank.test.ts` 的分层测试策略处理：纯逻辑测试用
  `node:test` 无服务依赖跑，需要真实服务的测试单独归入
  `experience:test:live`（对齐现有 `agent:test:live` 命名习惯）。

## 验收标准

- [ ] [AC-001] `experience:test`（纯逻辑部分）在完全断网、Qdrant/Ollama
  均未启动的环境下全部通过。
- [ ] [AC-002] 并发 finalize 不同候选 ID 的测试，两者都成功完成，互不
  阻塞、互不覆盖对方结果。
- [ ] [AC-003] 并发 finalize 相同候选 ID 的测试：两次调用均不抛错（第
  二次通过 `transitionIdempotent()` 识别已达目标状态直接返回，不是
  重复执行真正的状态转换），最终 `status="verified"`、
  `occurrence_count`/`document_version` 不因第二次调用被重复递增或
  覆盖丢失。
- [ ] [AC-004] AGENTS.md 存在性/内容哈希在完整流程前后测试断言中确认
  未变化。
- [ ] [AC-005] 空配置临时目录场景下 `experience:status` 正常退出（非
  崩溃），输出明确的"未配置"提示。

## 依赖

- Feature 1、2、3 全部完成。

## 开放问题

- 无。
