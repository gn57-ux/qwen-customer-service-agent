# Feature 1: data-model — 需求规格

## 概述

定义"工作流经验"的 Markdown 数据模型、生命周期状态机、脱敏规则与原子写入
机制——这是整个经验 RAG 学习闭环的地基，Feature 2（检索/存储）与 Feature 3
（CLI）都依赖本 feature 产出的 schema 与写入函数。本 feature 不涉及 Qdrant/
Embedding，纯粹是"如何生成、校验、写入一份合规的经验 Markdown 文件"。

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 内的新增子模块（`mastra-agent/src/experience/`）

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始需求 |

## 用户故事

- 作为使用 `/yd:ai` 的开发者，我想要任务完成后自动把有价值的踩坑/决策
  沉淀成结构化经验，以便未来同类任务能自动复用，而不是每次都重新踩坑。
- 作为经验库的维护者，我想要重复经验只增加计数而不产生重复文件，以便
  经验库保持精简、可信。
- 作为隐私敏感的用户，我想要写入前强制脱敏，以便经验库不会泄露用户名、
  密钥、内部路径等信息。

## 功能需求

1. [F-001] 定义经验 Markdown 的 frontmatter schema：`document_id`、
   `document_version`、`title`、`domain`（固定值 `workflow-experience`）、
   `stage`（execute/review/qa/finish）、`task_type`（frontend/backend/rag/
   model/data/git/docs/workflow）、`project_scope`（当前项目名或 `global`）、
   `source`、`created_at`、`updated_at`、`risk_level`、`status`（candidate/
   verified/deprecated）、`occurrence_count`、`content_hash`、`supersedes`
   （可选，格式 `{document_id}@v{N}`——**不能是裸 `document_id`**：同一
   经验的所有版本共享同一个 `document_id`（这是 occurrence_count 累加
   机制的前提），裸 `document_id` 会构成自引用，无法定位到被取代的
   具体历史版本，见 design.md 的 Codex Review 修正记录）。
2. [F-002] 定义正文固定结构：`# 标题` + 9 个二级标题（触发场景/问题表现/
   错误做法/根因/正确处理/验证方法/适用范围/不适用范围/可提升为稳定规则的
   条件），缺任一节判校验失败。
3. [F-003] `document_id` 生成规则：稳定、确定性（同一场景+同一 stage/
   task_type 重复提交应得到相同或可判定为"同一经验"的 ID），不依赖时间戳
   等易变因子。
4. [F-004] 脱敏模块：写入前扫描并拦截/替换用户名、绝对用户目录（如
   `/Users/xxx`）、Token/Key/Cookie、邮箱、账号/组织信息、远程主机/私有 IP、
   原始聊天内容片段。命中即替换为占位符或拒绝写入（不允许"忽略继续"）。
5. [F-005] 内容去重：新提交内容与已有经验（按 `content_hash` 或语义近似）
   判定为同一经验时，**只增加 `occurrence_count`，不创建新文件**；内容有
   实质变化（不是简单重复）时递增 `document_version`，不覆盖旧版本历史
   （通过 `supersedes` 链接，而不是原地改写丢失过往内容）。
6. [F-006] 原子写入：写入过程中进程崩溃/异常退出不得留下半截 Markdown
   文件（临时文件 + rename 的标准原子写入模式）。
7. [F-007] 并发写入锁：同一经验文件被两个并发进程/命令同时写入时，必须
   互斥，不产生数据竞争或文件损坏。
8. [F-008] 生命周期状态机：`candidate → verified → deprecated`。
   `candidate → verified` 仅在满足全部条件时允许（Stop Hook/Codex Review
   最终 ALLOW、自动测试通过、修复前后证据完整、未命中隐私扫描、内容非
   单次偶发/无依据猜测）——本 feature 只实现状态转换函数与前置条件校验，
   实际触发时机由 Feature 5（N8 集成文档）描述。`deprecated` 状态的经验
   默认不参与检索（检索侧过滤逻辑属于 Feature 2，本 feature 只需要状态
   字段本身可被正确读取）。

## 非功能需求

- 性能: 单次写入（含脱敏扫描+校验+锁获取）应在 500ms 内完成（不含
  Embedding，Embedding 属于 Feature 2）。
- 安全: 脱敏规则必须是白名单式拦截（宁可误拦不可漏放），不得允许绕过。
- 兼容性: 纯 Node.js（与 `mastra-agent` 现有技术栈一致），不引入需要编译
  的原生依赖；路径处理必须支持中文路径与非固定用户名（不硬编码
  `/Users/ruolan`）。

## 验收标准

- [ ] [AC-001] 提交一份合法经验草稿，生成的 Markdown 文件 frontmatter
  包含全部 14 个必需字段且类型正确。
- [ ] [AC-002] 正文缺少任一必需二级标题时，写入函数返回明确的校验失败
  原因，不写入任何文件。
- [ ] [AC-003] 提交内容与已有经验完全相同的第二次请求，`occurrence_count`
  从 1 变为 2，文件数量不变。
- [ ] [AC-004] 提交内容有实质差异的更新请求，`document_version` 递增，
  旧内容可通过 `supersedes` 追溯。
- [ ] [AC-005] 内容含 F-004 所列 8 类任一项（用户名/绝对路径/Token-Key-
  Cookie/邮箱/内网 IP/账号组织信息/远程主机/原始聊天内容片段）时，写入
  被拦截（Token/Key/Cookie、原始聊天内容片段两类 `blocked: true`，无法
  安全脱敏、直接拒绝写入）或对应片段被替换为占位符（其余类别），两者
  必居其一，不允许原样写入——tasks.md T-003 曾遗漏后 3 类，已按本 AC
  与 design.md 模块 2 同步更正（Codex Review 第十轮）。
- [ ] [AC-006] 模拟写入过程中进程被 kill，目标目录不残留半截/损坏文件；
  **对已存在经验发起版本更新时**，模拟"归档旧内容完成后、新版本尚未
  原子写入前"这个具体时间点被 kill，规范路径 `{document_id}.md` 必须
  仍然存在且是完整的旧版本内容（不能消失），这是 Codex Review 指出的
  归档顺序 bug 对应的验收标准——先归档、后覆盖，不能反过来。
- [ ] [AC-007] 两个并发写入请求同时提交同一 `document_id`，最终文件内容
  一致（`occurrence_count` 正确累加为 2，不是被其中一个覆盖丢失）。
- [ ] [AC-007b] 手工构造一把"陈旧锁"（预先创建锁文件并把其 mtime 改到
  超过陈旧阈值之前），随后发起一次正常写入，该写入必须在合理时间内
  成功完成（自动回收陈旧锁），不得永久报"获取锁超时"——验证崩溃后
  不会造成对该 `document_id` 的永久死锁。
- [ ] [AC-007c] 手工构造同一把陈旧锁后，**并发**发起两个内容不同的
  写入请求（模拟两次各自独立、合法的经验更新，不是同一份重复内容——
  与 AC-007 的"完全相同内容"场景区分开）。**验收口径不是"只允许一次
  真正写入"**（Codex Review 第六轮指出：若第二个请求是在锁被正确释放
  后才重新排队执行，那本来就是一次合法的、独立的第二次写入，按 AC-007
  的既有语义就应该真正落盘、`occurrence_count`/`document_version`
  正确体现出两次更新都生效了；"只允许一次写入"这个表述和 AC-007 自相
  矛盾）。真正要验证的不变式是**"不会发生更新丢失/静默覆盖"**：
  - 若两次请求确实先后**正常串行**执行（各自拿到锁、写入、释放），
    两次都必须真正生效，最终状态体现两次更新依次叠加（不是"第二次
    读到第一次写入前的旧状态、算出来的结果覆盖掉了第一次的成果"）。
  - 若某一方在处理过程中因竞态被判定"锁已丢失"（`assertStillHeld()`
    抛出 `LockLostError`），该方必须完全不写入任何数据、安全中止，
    不允许"明知锁已失效仍然把计算结果写下去"这种覆盖行为。
  不允许出现的唯一情况是：两次请求都基于同一份旧状态独立计算并都
  成功落盘，其中一次的结果被另一次无声覆盖、任何一方都不知道自己的
  更新丢失了。这是 Codex Review 历经多轮才收敛到的并发正确性验收
  标准，`AC-007b` 只覆盖单进程场景，必须补一条真并发场景才能证明
  修复生效。
- [ ] [AC-007d] 持有锁期间人为 `await` 一段超过陈旧阈值一半时长（用
  测试专用的更短阈值，如把 `STALE_LOCK_MS` 通过依赖注入/环境变量调到
  1s 量级来加速测试，不必真的等 5 分钟）的延迟模拟"正常但耗时较长的
  处理"，验证心跳持续刷新期间该锁**不会**被另一个并发请求判定陈旧、
  不会被误抢占——这是 Codex Review 第五轮指出"单次 `assertStillHeld()`
  不足以防止长时间处理被误抢占"后引入心跳机制对应的验收标准，与
  AC-007c（验证"万一真被抢占"时不产生数据损坏）互补，缺一不能证明
  锁机制完整。
- [ ] [AC-008] `status` 字段只能按 candidate→verified→deprecated 单向流转
  （或 candidate/verified→deprecated），非法转换（如 deprecated→verified）
  被拒绝；`current === target` 的原地转换（如已是 verified 再次请求转
  verified）通过 `transitionIdempotent()` 直接返回当前状态视为成功，
  不算非法转换、不抛错——这是支持并发 `finalize` 幂等收敛（见
  Feature 4 F-001）的前提。

## 依赖

- Node.js 内置 `fs`/`crypto` 模块（原子写入、content_hash）。
- 无外部服务依赖（Qdrant/Embedding 属于 Feature 2）。

## 开放问题

- 无（架构边界问题已在 PLAN.md 记录并按推荐方案确定）。
