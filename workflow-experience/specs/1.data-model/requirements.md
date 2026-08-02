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
| 2026-08-01 | v1.17 | 第十七轮 Codex Review 新增 AC-013（陈旧锁无法安全清理时必须遵守 timeout，不得无限等待） |
| 2026-08-01 | v1.18 | 第十八轮 Codex Review 新增 AC-014（归档文件路径本身是符号链接时必须拒绝，不得跟随写入 experienceRoot 之外——AC-011 只覆盖了目录层面，遗漏了目录里具体文件路径这一层） |
| 2026-08-01 | v1.19 | 第十九轮 Codex Review 新增 AC-015（内容级围栏检查必须能识别"相同内容、仅计数字段变化"的并发写入，不能只比对 content_hash） |
| 2026-08-01 | v1.20 | 第二十轮 Codex Review 新增 AC-016（带标注名称的低熵密钥/密码赋值必须 blocked，不能只靠高熵启发式） |
| 2026-08-01 | v1.21 | 第二十一轮 Codex Review 新增 AC-017（原子写入的临时文件路径预先被放置符号链接时必须拒绝跟随，不得覆盖 experienceRoot 之外的文件） |
| 2026-08-01 | v1.22 | 第二十二轮 Codex Review 新增 AC-018（经验文件规范路径本身是符号链接时读取必须拒绝跟随）、AC-019（原子写入失败时必须清理已创建的 tmp 文件，不留孤儿） |
| 2026-08-01 | v1.23 | 第二十三轮 Codex Review 新增 AC-020（晚期围栏检查通过后、rename 之前所有权被窃取必须能重新发现）、AC-021（心跳必须基于原始 inode，不得误刷新接班者的新锁） |
| 2026-08-01 | v1.24 | 第二十四轮 Codex Review 新增 AC-022（排他创建成功后写入 token 失败必须清理句柄与孤儿锁文件，不得掩盖原始错误） |
| 2026-08-01 | v1.25 | 第二十五轮 Codex Review 新增 AC-023（内容实质变化的新版本必须重置为 candidate，不得沿用旧版本 verified/deprecated 状态）、AC-024（默认 test 命令必须包含 experience:test） |
| 2026-08-01 | v1.26 | 第二十六轮 Codex Review 新增 AC-025（归档源读取写入归档文件之前必须核实内容仍与基线一致，避免污染历史归档） |
| 2026-08-01 | v1.27 | 第二十七轮 Codex Review 新增 AC-026（validateExperience() 必须校验正文包含 F-002 要求的一级标题，且必须出现在所有二级标题之前） |
| 2026-08-01 | v1.28 | 第二十八轮 Codex Review 新增 AC-027（归档写入必须原子化为 tmp+rename，不得用 O_TRUNC 原地截断写入，同时继续满足 AC-014 的符号链接拒绝约束） |
| 2026-08-01 | v1.29 | 第二十九轮 Codex Review 新增 AC-028（写入后读回校验必须用 readActiveFileNoFollow()，不得用会跟随符号链接的 fs.readFile()） |
| 2026-08-01 | v1.30 | 第三十轮 Codex Review 新增 AC-029（content_hash 必须基于最终落盘的同一份归一化正文计算，不得用归一化前的原始文本，避免空白差异导致误判为内容变化） |
| 2026-08-01 | v1.31 | 第三十一轮 Codex Review 新增 AC-030（experienceRoot 本身是符号链接时必须拒绝写入）；Feature 1 功能/安全范围自本轮起冻结 |

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
- [ ] [AC-009] `title`/`source` 含邮箱/Token 等敏感信息时，写入函数的
  行为与 AC-005 对正文的要求完全一致（占位符替换或 `blocked` 拒绝，
  不允许原样落盘到 frontmatter）——第十三轮 Codex Review 指出的真实
  漏洞：初版实现只对正文调用 `redact()`，`title`/`source` 是
  candidate 可控的自由文本却完全绕过了强制脱敏这条安全要求。
- [ ] [AC-010] `project_scope` 含路径分隔符（`/`、`\`）、上级目录引用
  （`..`）或绝对路径时，写入函数返回
  `{ ok: false, reason: "invalid_project_scope" }`，不创建任何文件或
  目录（含不在 `experienceRoot` 之外创建锁文件）——第十三轮 Codex
  Review 指出的真实路径穿越漏洞：`path.join(experienceRoot,
  projectScope)` 对恶意 `project_scope` 值不做任何限制。
- [ ] [AC-011] `experienceRoot` 下已存在一个名为 `project_scope` 的
  符号链接、指向根目录之外的真实目录时，写入函数拒绝写入（不跟随
  符号链接），符号链接指向的外部目录里不产生任何新文件——第十四轮
  Codex Review 指出的真实漏洞：纯词法路径比较（`path.resolve`）不会
  跟随符号链接，会把"文本上在根目录内"误判为"实际也在根目录内"。
  **第十六轮 Codex Review 补充**：`project_scope` 对应目录本身是正常
  真实目录、但其下固定名为 `.superseded` 的归档子目录已被替换成指向
  根目录之外的符号链接时，触发归档的更新请求同样必须拒绝写入，符号
  链接指向的外部目录里不产生任何归档文件——之前的检查只覆盖了
  `projectDir` 这一层，遗漏了 `.superseded` 这个同样的攻击面。
- [ ] [AC-012] 两次内容不同的写入请求以某种方式（含但不限于并发/锁
  竞态）导致目标文件在"读取现存内容"之后、"真正原子写入"之前被
  另一方修改，写入函数在落盘前必须能检测到这一变化并返回
  `{ ok: false, reason: "conflict" }`——第十四轮 Codex Review 指出：
  仅靠锁 token 比对（`assertStillHeld()`）不足以保证这一点，必须有一道
  独立于锁状态、直接比对目标文件实际 `content_hash` 的内容级围栏检查。
  **第十五轮 Codex Review 补充两点**：
  1. 若冲突发生在"更新已有文档"分支（需要归档旧版本），围栏检查必须
     在归档写入 `.superseded/` **之前**执行——冲突时不允许已经产生
     任何文件（含归档文件），不能先归档再报告冲突。
  2. 围栏检查通过之后到真正 `atomicWriteExperience()` 之间仍有极窄
     窗口（纯 POSIX 文件 API 无法消除，与模块 3 锁获取阶段的理论边界
     同类），写入函数必须在原子写入**之后**立即读回校验，确认磁盘上
     的内容确实是自己刚写入的那份；不一致时同样返回
     `{ ok: false, reason: "conflict" }`（不得在这种情况下谎称
     `ok: true`）——保证的是"不会有调用方在更新被覆盖后仍收到成功
     假象"，不是"物理上不可能发生竞争写入"。

- [ ] [AC-013] 陈旧锁被判定为可回收、但物理 `unlink` 持续失败（如
  EACCES、只读文件系统）时，`acquireLock()` 不得无限等待/忙等——必须
  在调用方传入的 `timeoutMs` 内返回，成功则正常获取锁，失败则抛出明确
  的"获取经验写入锁超时"错误——第十七轮 Codex Review 指出的真实 bug：
  陈旧锁回收分支里的 `continue` 此前是无条件的，只要判定为陈旧就立即
  `continue` 重试，完全不检查 `unlink` 是否真的成功；一旦 `unlink`
  持续失败，循环会跳过下面的超时检查和退避 sleep，退化成完全忽略
  `timeoutMs` 的忙等待（既不超时报错，也占满 CPU 空转）。
- [ ] [AC-014] `.superseded/{document_id}@v{N}.md` 这个具体归档文件
  路径（不是它的父目录）已预先存在且是指向 `experienceRoot` 之外的
  符号链接时，归档写入必须拒绝（不跟随符号链接），符号链接指向的外部
  文件内容不得被覆盖、符号链接本身不得被移除或替换——第十八轮 Codex
  Review 指出的真实漏洞：AC-011 的符号链接检查只覆盖了 `projectDir`
  与 `.superseded` **目录**这两层，目录本身干净不代表目录*里*这个
  具体归档文件路径也干净；`fs.writeFile()` 默认会跟随文件级符号链接
  写入，是与 AC-011 相关但不同的攻击面，必须单独校验目标文件路径本身。
- [ ] [AC-015] 两次内容**完全相同**的写入请求（走去重路径，只有
  `occurrence_count` 各自独立 +1、`content_hash` 不变）以某种方式
  （含但不限于锁机制残余竞态窗口，见 AC-007b/c/d）导致目标文件在
  "读取现存内容"之后、"真正落盘"之前被另一方修改，内容级围栏检查
  必须能检测到这一变化并返回 `{ ok: false, reason: "conflict" }`，
  不得因为 `content_hash` 未变就误判为"没有冲突"从而覆盖丢失另一方
  已经生效的 `occurrence_count` 增量——第十九轮 Codex Review 指出的
  真实 bug：AC-012 引入的围栏检查只比对 `content_hash`，对这种"内容
  相同、仅计数字段变化"的并发写入完全失明，是与 AC-012 覆盖的"内容
  不同"场景互补但不重叠的另一种冲突形态，必须同时比对
  `content_hash` 与 `occurrence_count` 才能覆盖全部会改变 frontmatter
  的并发写入路径。
- [ ] [AC-016] 内容中出现带标注名称的密钥/密码赋值（如
  `API_KEY=abc123`、`client_secret=secret`、`password=hunter2`，值
  本身低熵、不满足通用高熵启发式）时，写入必须 `blocked`，不得因为
  值本身"看起来不够随机"就放行——第二十轮 Codex Review 指出的真实
  漏洞：F-004/AC-005 明确要求 Token/Key 类不能靠"碰巧高熵"才被拦住
  （Cookie 那次已经确认过这条原则，第二十轮发现常见标注凭据同样存在
  这个盲区），必须补充"标签名 + 赋值语法"这条不依赖值本身内容的独立
  检测规则。
- [ ] [AC-017] 原子写入的临时文件路径（`atomicWriteExperience` 内部
  `${targetPath}.tmp-...`）在真正创建之前如果已被另一本机进程预先
  放置为指向 `experienceRoot` 之外某文件的符号链接，写入必须拒绝
  跟随该符号链接、不得截断或覆盖其指向的外部文件，且不得静默删除
  该符号链接本身——第二十一轮 Codex Review 指出的真实漏洞：旧实现
  用 `fs.writeFile(tmpPath, ...)` 直接写临时路径，该调用默认跟随
  符号链接，而临时路径本身在修复前是"进程 pid + 时间戳"可预测拼接
  而成，绕开了 AC-011/AC-014 已经为 project/archive 路径加上的符号
  链接防护；与那两条同属"写入前必须验证目标路径不是符号链接"这一类
  攻击面，但落在原子写入这最后一步，此前遗漏。
- [ ] [AC-018] 经验文件的规范路径（`{document_id}.md`，即
  `upsertExperience()` 每次更新前都会先读一次的"现存内容"入口）如果
  在读取之前已经存在且是符号链接、指向 `experienceRoot` 之外的位置，
  读取必须拒绝跟随该符号链接，不得把外部文件内容当作"现存版本"读入
  （进而可能被归档进 `.superseded/`），也不得删除或替换这个符号链接
  本身——第二十二轮 Codex Review 指出的真实漏洞：project 目录
  （AC-011）、`.superseded` 目录（第十六轮）、`.superseded` 归档文件
  本身（AC-014）、原子写入 tmp 路径（AC-017）都已经有符号链接防护，
  唯独遗漏了"活跃文件路径本身"这一层，而它偏偏是每次更新都必然会先
  读一次的入口。
- [ ] [AC-019] `atomicWriteExperience()` 在成功创建 tmp 文件之后，若
  写入内容、关闭句柄或最终 `rename` 任一步失败，必须清理已创建的 tmp
  文件，不得留下孤儿文件；清理失败本身不得掩盖需要抛给调用方的原始
  错误——第二十二轮 Codex Review 指出的真实问题：磁盘耗尽、权限问题
  等瞬时故障会在每次失败重试后积累一份包含完整经验内容的孤儿
  `.tmp-*` 文件，文档里一直把这些路径描述为"transient"，但此前从未
  被实际回收。
- [ ] [AC-020] 在"晚期内容级围栏检查（AC-012/AC-015）通过之后、最终
  `atomicWriteExperience()` rename 之前"这段窗口内，若所有权恰好被
  另一进程回收并重新持有（即使围栏状态本身没有变化——只是锁的归属
  变了），必须能重新发现并中止，不得直接 rename——第二十三轮 Codex
  Review 指出的真实 bug：光靠内容级围栏检查看不出所有权已经易主，
  旧实现在"assertStillHeld() → 晚期围栏检查"这一序列通过后就直接
  rename，如果所有权恰好在围栏检查这次 I/O 期间被窃取，两个进程会
  各自对着自己刚写入的内容验证成功、都报告 `ok: true`，其中一次的
  更新被静默覆盖丢失，"最终只有一个进程完成写入"这条保证被打破。
- [ ] [AC-021] `acquireLock()` 的心跳必须只刷新自己最初创建的那把锁
  （具体 inode），不得在自己的锁已经被另一进程回收、同一路径被重新
  创建之后，继续用路径操作误刷新"接班者"新锁的 mtime——第二十三轮
  Codex Review 指出的真实 bug：旧实现心跳按路径调用 `fs.utimes()`，
  如果本进程停顿过久导致自己的锁被判定陈旧并回收，恢复后的心跳会
  不加区分地刷新"此刻这个路径上无论是谁的锁"的 mtime，把接班者的新
  锁误刷新成"看起来很新鲜"；接班者随后即使真的崩溃，陈旧检测也会被
  这个僵尸心跳永久蒙蔽，探测不到，锁可能一直卡到原进程自己退出为止。
- [ ] [AC-022] 锁的排他创建（`fs.open(..., O_EXCL)`）成功之后，若写入
  所有权凭证（token）本身失败（磁盘耗尽/瞬时 I/O 错误等），必须关闭
  已打开的句柄并删除这个刚创建、内容还是空的锁文件，再把原始错误原样
  抛出，不得留下孤儿锁文件——第二十四轮 Codex Review 指出的真实 bug：
  旧实现在这个失败路径上既不关闭句柄也不清理锁文件，磁盘上会留下一份
  空的 `.lock`，后续任何进程都会把它当作"别人持有的活跃锁"，需要等满
  一整个 `staleLockMs` 才能判定陈旧并回收，把一次瞬时故障放大成一次
  长时间阻塞，还掩盖了真正的失败原因。
- [ ] [AC-023] 更新一份已存在的经验且内容发生实质变化（`content_hash`
  不同，走版本递增路径）时，新版本的 `status` 必须重置为
  `"candidate"`，不得沿用旧版本的 `verified`/`deprecated` 状态——第
  二十五轮 Codex Review 指出的真实 bug：`frontmatter = {...existing,
  ...}` 会把上一版的 `status` 原样带到新内容上，旧版本被验证过不代表
  新内容也经过了同样的审核（绕过 candidate→verified 必须走
  `canVerify()` 的生命周期约束），旧版本被标记 `deprecated` 也不该让
  全新的内容永久带着这个标记、再也无法被正常验证；新版本必须重新从
  `candidate` 起步，独立走一遍生命周期。
- [ ] [AC-024] `mastra-agent/package.json` 的默认 `test` 命令必须包含
  `experience:test`——第二十五轮 Codex Review 指出的真实问题：新增的
  experience 测试套件只能通过单独调用 `npm run experience:test` 执行，
  仓库默认的 `npm test` 入口一直跳过它们，任何依赖这个默认入口的 CI
  或开发流程都会对这个新 Feature 的回归视而不见。
- [ ] [AC-025] 归档源读取（`upsertExperience()` 步骤 6.1，读取
  `{document_id}.md` 现存内容以复制进 `.superseded/`）在真正写入归档
  文件之前，必须核实刚读到的内容仍与开始时记录的 `baselineFence` 一致
  （`content_hash` 与 `occurrence_count` 均相同），不一致必须直接返回
  `{ ok: false, reason: "conflict" }`、不得写入归档文件——第二十六轮
  Codex Review 指出的真实 bug：早期围栏检查（步骤 5.5）通过之后、
  归档源读取真正执行之前，若另一个写入者恰好完成了自己完整的一轮
  更新（读到旧内容→写入新内容→rename），这里读到的内容已经是对方
  刚写入的新版本，若不核实就直接写进按本进程自己（此刻已陈旧）的
  `archiveOldVersion` 算出的归档路径，会把错误版本的内容永久写进
  历史归档——即使随后的第二次围栏检查发现冲突并让整个写入报告
  `conflict`，归档文件此刻已经被污染，无法撤销，违反"报告冲突就不产生
  副作用"这一隐含承诺，也违反历史版本必须完整保留的保证。
- [ ] [AC-026] `validateExperience()` 必须校验正文包含 F-002 要求的
  一级标题（`# 标题`），且该标题必须出现在所有二级标题之前——第二十七
  轮 Codex Review 指出的真实 bug：旧实现只检查了 9 个二级标题是否
  齐全，完全没有校验一级标题本身是否存在，导致没有一级标题、或一级
  标题前有任意无关文字的正文都能通过校验并被持久化，违反文档化的
  schema。校验的是"是否存在合法的一级标题"，不要求标题文字是字面的
  "标题"二字。
- [ ] [AC-027] 归档写入（`.superseded/{document_id}@v{N}.md`）必须是
  原子操作（tmp + rename），不得用 `O_TRUNC` 原地截断写入——第二十八
  轮 Codex Review 指出的真实 bug：进程崩溃或写入过程中失败会让归档
  文件残留为空文件或半截内容，可能销毁这个 feature 本该保留的唯一
  旧版本，违反 F-006"崩溃不得留下半截 Markdown"的要求。同时必须继续
  满足 AC-014："目标路径已存在且是符号链接时必须拒绝写入，符号链接
  本身不得被移除或替换"——不能因为改成 tmp+rename 就放弃这条约束（
  `rename()` 本身会无条件替换目标目录项，包括符号链接，必须在写入前
  与紧贴 rename 之前分别显式核实目标不是符号链接，发现是则直接拒绝）。
- [ ] [AC-028] 写入完成后的读回校验（确认 `document_version`/
  `occurrence_count`/`content_hash` 确实是本次写入的那份）必须使用
  `readActiveFileNoFollow()` 读取规范路径，不得使用会跟随符号链接的
  `fs.readFile()`——第二十九轮 Codex Review 指出的真实 bug：如果
  `atomicWriteExperience()` 的 rename 完成、函数返回之后，到读回校验
  真正执行之前，另一个本机进程恰好把规范路径替换成指向一份"版本/
  计数/哈希都精心构造成匹配"的外部文件的符号链接，会跟随符号链接的
  读取会误判"确实生效"并向调用方谎报 `ok: true`，同时读到了
  `experienceRoot` 之外的数据——本文件其余每一处活跃文件读取（初次
  存在性判断、归档源读取、`readCurrentFenceState` 内部）都已经统一
  使用这个不跟随符号链接的安全读取，读回校验这最后一步不能是例外。
- [ ] [AC-029] `content_hash` 必须基于最终会被 `serializeExperienceFile()`
  实际落盘的同一份归一化正文计算，不得基于脱敏后但未归一化的原始
  文本——第三十轮 Codex Review 指出的真实 bug：`serializeExperienceFile()`
  落盘时会执行 `body.trim() + "\n"`，如果 `content_hash` 是对归一化
  之前的 `redactedBody.text` 算出来的，两次语义完全相同、只是前导/
  尾随空白不同的提交会序列化出字节完全一致的文件，却因为归一化前的
  原始文本不同而算出不同的 `content_hash`，把本该走 F-005 去重路径
  （只 `+1 occurrence_count`）的重复提交误判成"内容变化"，凭空生成
  一个不必要的新版本。正文必须先归一化一次，再用同一份归一化结果
  同时用于哈希、`validateExperience()` 校验与 `serializeExperienceFile()`
  序列化。
- [x] [AC-030] `experienceRoot` 本身是符号链接时必须在触碰文件系统之前
  拒绝写入，不得在符号链接指向的外部目录里创建任何文件——第三十一轮
  Codex Review 指出的真实 bug：`assertWithinRoot()` 只做词法路径比较，
  `assertNotSymlink(projectDir)` 的 `lstat` 只对路径最后一段不跟随
  符号链接，两者都无法拦截 `experienceRoot` 自身是符号链接的情况。
  只检查配置根这一层，不递归检查其更上层祖先目录（那属于超出本模块
  威胁模型的更强攻击面，已记录为已知边界）。

**Feature 1 冻结说明（2026-08-01）**：经 31 轮 Codex Review 收敛，
`mastra-agent/src/experience/` 已通过 102/102 单元测试
（`npm run experience:test`）+ 82/82 既有回归测试
（`npm run agent:test:unit`），功能与安全范围自本轮起冻结，仅接受
可由上述 AC-001~AC-030 证明、影响当前功能的缺陷修复；推测性的极端
文件系统攻击/理论竞态/不在规格内的增强记录到 `future-hardening`
（见 tasks.md 底部），不再阻塞后续 Feature。

## 依赖

- Node.js 内置 `fs`/`crypto` 模块（原子写入、content_hash）。
- 无外部服务依赖（Qdrant/Embedding 属于 Feature 2）。

## 开放问题

- 无（架构边界问题已在 PLAN.md 记录并按推荐方案确定）。
