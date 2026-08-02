# Feature 1: data-model — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |
| 2026-08-01 | v1.17 | 第十七轮 Codex Review 修复（stale lock 超时问题），见底部记录 |
| 2026-08-01 | v1.18 | 第十八轮 Codex Review 修复（归档文件级符号链接逃逸），见底部记录 |
| 2026-08-01 | v1.19 | 第十九轮 Codex Review 修复（内容级围栏检查漏检相同内容并发写入），见底部记录 |
| 2026-08-01 | v1.20 | 第二十轮 Codex Review 修复（低熵标注凭据漏检），见底部记录 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 新增子模块
- specs 路径: workflow-experience/specs/1.data-model/

## 任务列表

### 功能 1: frontmatter schema 与校验

- [x] T-001: 定义 `ExperienceFrontmatter` 类型 + `REQUIRED_SECTIONS` 常量 +
  `document_id` 生成函数（`mastra-agent/src/experience/schema.ts`）~30min
- [x] T-002: `validateExperience()` 校验函数（14 字段类型/枚举 + 9 个
  必需二级标题），返回结构化错误列表，不抛异常；内部的正文分节逻辑
  单独导出为 `parseExperienceSections(body): Map<string,string>`
  （供 Feature 2 检索侧文档级组装复用，见 design.md 模块 1 第十一轮
  Codex Review 修正记录，⛔ 不要让 Feature 2 重新实现一套分节解析）
  ~30min

### 功能 2: 脱敏

- [x] T-003: `redact()` 实现（8 类规则：①绝对用户路径 ②Token/Key/Cookie
  （Cookie 子规则含 `Cookie:`/`Set-Cookie:` 头部 + 不带头部前缀的
  已知会话 cookie 名称赋值，第十六轮 Codex Review 追加：普通 Cookie
  值往往低熵，不满足通用高熵启发式，需要单独规则，不能指望"碰巧命中
  高熵"）③邮箱 ④内网/私有 IP ⑤当前用户名 ⑥账号/组织信息（Git remote
  org/repo 片段 + `@handle`）⑦远程主机（FQDN 白名单排除已知合法公共/
  文档域名）⑧原始聊天内容片段（含 `User:`/`Assistant:` 等角色前缀的
  连续 3 行以上）+ `blocked` 判定——②⑧命中直接 `blocked: true` 拒绝
  写入，其余类别替换为占位符），`mastra-agent/src/experience/redact.ts`
  ~50min（design.md 模块 2 第三轮 Codex Review 已把类别从最初 5 类
  补全到 8 类，本任务描述同步更新，避免按旧清单实现漏掉后 3 类）

### 功能 3: 原子写入与并发锁

- [x] T-004: `atomicWriteExperience()`（tmp 文件 + rename）+
  `acquireLock()`/`lockPathFor()`，返回 `LockHandle`（所有权 token +
  `wx` 排他创建 + 超时 + 基于 mtime 判定陈旧后**内容重新校验一致才
  unlink**（第十四轮 Codex Review 收紧：单纯"stat 一次就直接 unlink"
  会无差别删除当前实际存在的文件，不管是不是最初判定陈旧的那份；紧贴
  unlink 之前重新读一次内容+mtime，两次一致才回收）——**不追求抢占
  动作本身无竞态**，见 design.md 第三、四轮 Codex Review 记录的结论：
  纯文件 API 做不到完美 CAS，改为 `assertStillHeld()` 提交前校验兜底 +
  `release()` 校验 token 归属；持锁期间按 `HEARTBEAT_INTERVAL_MS` 心跳
  刷新 mtime（第五轮 Codex Review 引入，防止长时间正常处理被误判
  陈旧）；`STALE_LOCK_MS`/`HEARTBEAT_INTERVAL_MS` 做成可选参数/环境
  变量覆盖，供 AC-007d 用更短阈值加速测试，不必真的等 5 分钟；均导出
  供 Feature 3 finalize 复用；**陈旧锁回收分支的 `continue` 必须以
  `unlink` 是否真的成功（`reclaimed`）为条件，不能无条件 continue**——
  第十七轮 Codex Review 指出：`unlink` 持续失败时无条件 continue 会
  跳过超时检查，退化成忽略 `timeoutMs` 的忙等待）~35min
- [x] T-005: `upsertExperience()` 主流程（**先校验 `project_scope` 是
  安全单层路径片段 + 对应目录不是符号链接**（后者是第十四轮 Codex
  Review 追加：纯词法路径比较不会跟随符号链接，需要 `lstat` 显式检查；
  第十六轮 Codex Review 追加：同一个符号链接检查还必须在归档步骤里
  对 `.superseded` 目录本身再做一次，不能只检查 `projectDir` 这一层）
  → **对 `title`/`source`/`project_scope`/正文分别脱敏，任一 `blocked`
  都拒绝写入**（不能只脱敏正文，见第十三轮 Codex Review 修正记录）→
  计算 id/hash→加锁→比对已有文件、记录 `baselineHash`→去重累加/版本
  递增→落盘前 `assertStillHeld()`→**第一次内容级围栏检查**（必须在
  归档之前，第十五轮 Codex Review 修正：放在归档之后会先留下归档文件
  才报告冲突）→**对 `.superseded` 目录做符号链接检查**后先复制归档
  旧内容到 `.superseded/`→**再次 `assertStillHeld()`**（第十二轮
  Codex Review 引入，紧贴在真正的原子写入之前）→**第二次内容级围栏
  检查**（捕获归档期间新出现的冲突）→`atomicWriteExperience()` 覆盖
  规范路径（顺序不能反——见 design.md 的 Codex Review 修正记录，反过来
  会在归档后、新版本写入前崩溃时导致规范文件消失）→**写入后读回校验**
  （第十五轮 Codex Review 引入：确认磁盘上确实是自己刚写入的版本，
  不一致则事后报告 conflict 而不是谎称成功）→释放锁）；
  `LockLostError`/围栏冲突/读回校验失败/符号链接检测失败时均返回失败，
  且冲突分支不产生除既有归档以外的额外文件 ~60min

### 功能 4: 生命周期状态机

- [x] T-006: `transition()` + `canVerify()`（`lifecycle.ts`），非法状态
  转换必须抛出明确错误 ~15min

### 集成与测试

- [x] T-007: `node:test` 单元测试覆盖 AC-001~AC-008 及 AC-007b/AC-007c/
  AC-007d 全部验收标准（含并发写入模拟、进程 kill 模拟用临时目录 +
  手动截断文件模拟半截写入场景、手工构造陈旧锁文件验证单进程自动
  回收、**真并发**发起两个请求同时判定同一把锁陈旧的竞态测试——用
  `Promise.all` 真实并发触发，不是 mock 出并发，断言"恰好一次真正
  落盘"而不是断言"抢占阶段互斥"，覆盖 `assertStillHeld()` 在被取代
  场景下确实抛出 `LockLostError` 且不产生文件写入；以及用调小的
  `STALE_LOCK_MS`/`HEARTBEAT_INTERVAL_MS` 验证心跳期间长时间处理不被
  误判陈旧） ~30min

## 依赖关系

- T-002 依赖 T-001（校验函数需要先有类型定义）
- T-005 依赖 T-001、T-002、T-003、T-004
- T-006 可与 T-003/T-004 并行（无共享文件）
- T-007 依赖 T-001~T-006 全部完成

## 风险点

- `document_id` 的场景哈希算法如果归一化不充分（如标题措辞略有不同但
  本质是同一场景），可能导致本该合并的经验被当成不同文件——本 feature
  先用简单归一化（大小写、空白折叠），后续如证明不够用再引入更复杂的
  相似度比较（属于 Feature 2 检索侧的语义去重范畴，不在本 feature 内
  过度设计）。
- 并发锁的超时时间（5s）需要在真实并发测试中验证是否合理，过短可能在
  慢速文件系统上误报超时。

## 完成记录（2026-08-01）

- 实现文件：`mastra-agent/src/experience/{schema,redact,atomic-write,write,lifecycle,index}.ts`
  （`atomicWriteExperience` 独立成 `atomic-write.ts` 单文件，供
  `write.crash-ordering.test.ts` 用 `mock.module()` 拦截，`write.ts` 从
  这里 re-export，对外接口不变——design.md 模块 3 已同步记录）。
- 测试文件：`schema.test.ts`/`redact.test.ts`/`lifecycle.test.ts`/
  `write.test.ts`/`write.crash-ordering.test.ts`，`npm run experience:test`
  一次性跑全部（新增到 `mastra-agent/package.json`，带
  `--experimental-test-module-mocks`）：**47 个测试全部通过**。
- `npm run test`（typecheck + 既有 `agent:test:unit`）验证无回归：
  **82 个既有测试全部通过**，未修改冻结路径。
- 与 design.md 的实现期偏差（已同步回写 design.md，非代码单方面偏离）：
  1. `atomicWriteExperience` 拆到独立文件（见上）。
  2. `acquireLock()` 新增第三个可选参数 `opts: { staleLockMs?,
     heartbeatIntervalMs? }` + 环境变量 `EXPERIENCE_LOCK_STALE_MS`/
     `EXPERIENCE_LOCK_HEARTBEAT_MS` 兜底默认值——tasks.md T-004 早已
     要求这个能力，design.md 原代码片段之前遗漏，本轮补齐。
  3. `redact()` 的远程主机规则收紧：只有"三段以上子域名"或"末段是
     已知 TLD 白名单"才判定为主机，常见源码/文档文件扩展名（`.ts`/
     `.json`/`.md` 等）直接放行——design.md 原始正则会把几乎所有提到
     文件名的技术经验整篇误判成"远程主机"，实现阶段验证后收紧，方向
     仍是"宁可漏放明显是文件名的 case，不放宽到误拦所有技术文档"。

## Codex Review 第十二轮修复（2026-08-01，实现阶段）

针对已提交实现的 3 项 findings，均已修复并补充回归测试，`npm run
experience:test` **52/52 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 落盘前重新校验锁所有权**（`write.ts` 的 `upsertExperience()`）
   ——归档步骤（`.superseded/` 复制）有真实 I/O 耗时，第一次
   `assertStillHeld()` 到真正 `atomicWriteExperience()` 之间如果所有权
   丢失，原持有者会静默覆盖抢占者已提交的新内容。修复：在
   `atomicWriteExperience()` 调用前**再次** `await
   lock.assertStillHeld()`，把"落盘前重新校验"紧贴到真正的 rename
   之前。design.md 模块 4 步骤 6 已同步记录。
2. **[P2] 排除纯数字点分版本号**（`redact.ts` 的 `isLikelyRemoteHost()`）
   ——"三段及以上→强 FQDN 信号"这条分支完全没检查标签内容，会把
   "Node 22.1.0"这类版本号整体误判成远程主机。修复：标签全部是纯数字
   时直接判定不是主机。design.md 模块 2 已同步记录。新增回归测试
   `redact.test.ts`「纯数字点分版本号不被误判为远程主机」。
3. **[P2] frontmatter 字符串字段加 YAML 转义/引用**（`schema.ts` 的
   `serializeExperienceFile()`）——`title`/`source` 等 candidate 可控
   字段含冒号/`#`/前导特殊字符/换行时原样拼接会产出无效或被误解析的
   YAML。修复：新增 `serializeYamlScalar()`/`escapeDoubleQuoted()`/
   `unescapeDoubleQuoted()`，命中"需要引用"的判定条件时用双引号转义
   包裹，`parseExperienceFile()` 同步支持反向解析；数值字段不受影响。
   design.md 模块 1 已同步记录。新增回归测试 `schema.test.ts` 四条
   （含冒号/含井号引号反斜杠/特殊起始字符与字面量/普通标题不加引号）。

## Codex Review 第十三轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项安全相关 findings，均已修复并补充回归测试，
`npm run experience:test` **58/58 通过**、`npm run test`（既有套件）
**82/82 无回归**：

1. **[P1] 强制脱敏覆盖全部 candidate 可控字段**（`write.ts` 的
   `upsertExperience()`）——初版实现只对 `candidate.body` 调用
   `redact()`，`title`/`source`/`project_scope` 是同样由 candidate
   控制的自由文本，却原样写入 frontmatter，等于绕过了"写入前强制脱敏"
   这条安全要求（例如 `source` 里的邮箱/Token 会原样落盘）。修复：对
   `title`/`source`/`project_scope` 分别调用 `redact()`，任一
   `blocked` 都直接拒绝写入；后续 `document_id` 计算、frontmatter
   构造、路径拼接全部使用脱敏后的文本，不再引用 candidate 原始值。
   design.md 模块 4 步骤 1 已同步记录。新增回归测试：`write.test.ts`
   「source 含邮箱时被脱敏」「title 命中 Token 类内容时同样 blocked」。
2. **[P1] `project_scope` 路径穿越防护**（`write.ts` 的
   `upsertExperience()`）——`path.join(experienceRoot, projectScope)`
   对 `"../../etc"` 这类值不做任何限制，能在 `experienceRoot` 之外
   创建锁/归档/Markdown 文件。修复：新增 `isSafeProjectScope()`（拒绝
   含 `/`、`\`、空字符或裸 `.`/`..` 的值）作为第一道校验，**外加**
   `assertWithinRoot()`（`path.resolve` + `path.relative` 二次校验
   实际解析路径确实落在 `experienceRoot` 内）作为纵深防御兜底，双重
   都通过才继续。design.md 模块 4 新增步骤 0 已同步记录，requirements.md
   新增 AC-009/AC-010。新增回归测试：`write.test.ts` 四条（`..` 路径
   穿越/裸 `..`/路径分隔符/绝对路径，均断言 `reason:
   "invalid_project_scope"` 且不产生越界文件）。

## Codex Review 第十四轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项安全相关 findings，均已修复并补充回归测试，
`npm run experience:test` **61/61 通过**、`npm run test`（既有套件）
**82/82 无回归**：

1. **[P1] 陈旧锁回收收紧 + 内容级围栏检查兜底**（`write.ts` 的
   `acquireLock()` 与 `upsertExperience()`）——纯"stat 一次就直接
   unlink"的陈旧锁回收会无差别删除当前实际存在的文件，两个进程都判定
   同一把锁陈旧时，一个进程回收并重新持有后，另一个进程可能盲目 unlink
   掉这把刚创建的合法新锁，且当时的"落盘前 assertStillHeld() 校验"
   仍留有极窄窗口（校验通过到真正 rename 之间）。修复分两层：(a)
   `acquireLock()` 的陈旧回收改为"紧贴 unlink 之前重新读一次内容+
   mtime，两次结果完全一致才真正回收"，缩小（不能消灭）TOCTOU 窗口；
   (b) `upsertExperience()` 新增**内容级乐观并发围栏检查**——落盘前
   重新读取目标文件当前 `content_hash`，与本次更新决策所依据的
   `baselineHash` 比对，不一致则返回 `{ reason: "conflict" }` 并中止，
   不写入任何文件。(b) 是真正独立于锁机制的第二道防线，不管锁本身
   经历怎样的竞态，只要磁盘内容变了就会被挡住。`readCurrentContentHash`
   独立成 `read-content-hash.ts` 单文件（供 `mock.module()` 拦截测试）。
   design.md 模块 3/模块 4 已同步记录，requirements.md 新增 AC-012。
   新增回归测试：`write.conflict.test.ts`（mock 掉围栏检查强制触发
   冲突，断言 `atomicWriteExperience` 从未被调用）。
2. **[P1] `project_scope` 符号链接逃逸防护**（`write.ts` 的
   `upsertExperience()`）——`assertWithinRoot()` 只做词法路径比较，
   不跟随符号链接；如果 `experienceRoot` 下已存在一个名为
   `project_scope` 的符号链接指向根目录之外，词法检查会误判为"在根目录
   内"，但后续锁/归档/Markdown 写入会跟随符号链接真正逃逸。修复：新增
   `assertProjectDirNotSymlink()`，用 `lstat`（不跟随符号链接）显式
   检查该目录条目，存在且是符号链接则直接拒绝，不做任何后续文件系统
   操作。design.md 模块 4 步骤 0 已同步记录，requirements.md 新增
   AC-011。新增回归测试：`write.test.ts`「project_scope 对应目录已
   存在且是指向根目录之外的符号链接时被拒绝」（断言符号链接指向的外部
   目录里不产生任何新文件）。

## Codex Review 第十五轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项 P1 findings，均已修复并补充回归测试，`npm run
experience:test` **62/62 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 围栏检查必须在归档之前执行**（`write.ts` 的
   `upsertExperience()`）——上一版把内容级围栏检查放在归档
   `.superseded/` 之后，若冲突恰好在此时被发现，函数已经在
   `.superseded/` 下留了一份文件才返回 `conflict`，违反"冲突时不写入
   任何文件"的承诺，还可能把竞争对手的内容错误归档到我们计算出的旧
   版本号下。修复：把围栏检查拆成两次——**第一次紧跟在第一次
   `assertStillHeld()` 之后、归档之前**（正常路径下这一次就能拦住
   绝大多数冲突，不产生任何文件）；**第二次紧跟在第二次
   `assertStillHeld()` 之后、`atomicWriteExperience()` 之前**（捕获
   归档这段 I/O 耗时期间新出现的冲突，此时归档文件已经产生属于可接受
   代价，见 design.md 归档顺序说明）。design.md 模块 4 步骤 5.5/6.3
   已同步记录，requirements.md AC-012 补充第 1 点。新增回归测试：
   `write.conflict.test.ts`「更新场景下围栏检查在归档之前就中止，不
   产生 `.superseded/` 文件」（预先写入真实 v1 文件，mock 围栏检查
   强制冲突，断言 `.superseded/` 目录未被创建）。
2. **[P1] 写入后读回校验，堵住围栏检查到真正 rename 之间的最后窗口**
   （`write.ts` 的 `upsertExperience()`）——即使围栏检查通过，纯 POSIX
   文件 API 仍无法让"检查→rename"两步做到完全无竞态：理论上另一个
   进程可能恰好在我们围栏检查通过之后、`atomicWriteExperience()` 完成
   之前也完成了自己的写入，我们的 rename 会紧接着覆盖掉它，而我们仍会
   报告 `ok: true`——这正是"锁/围栏检查本该防止的场景"却因为检查与
   提交不是单一原子操作而失守。修复：`atomicWriteExperience()` 成功
   后立即读回目标文件，校验 `document_version`/`occurrence_count`/
   `content_hash` 确实是本次写入的那份，不一致则返回
   `{ reason: "conflict" }` 而不是谎称成功。**如实说明理论边界**（与
   design.md 模块 3 锁获取阶段的边界同类）：这不能撤销已经发生的写入，
   只能保证"不会有调用方在更新被覆盖后仍收到成功假象"，不是"物理上
   不可能发生竞争写入"——没有外部协调服务（数据库事务/分布式锁）无法
   从数学上完全消除这最后一道窗口，本项目场景下这个残余风险可以接受。
   design.md 模块 4 步骤 6.5 已同步记录，requirements.md AC-012
   补充第 2 点。既有并发测试（AC-007/AC-007c）验证正常串行路径下这一
   新增校验不会误判（`npm run experience:test` 全部通过）。

## Codex Review 第十六轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项 P1 findings，均已修复并补充回归测试，`npm run
experience:test` **66/66 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] Cookie 类凭据补充检测规则**（`redact.ts` 的
   `TOKEN_PATTERNS`）——普通 Cookie（如 `Cookie: session_id=abc123`）
   的值往往是短小写字母数字串，不满足现有"32~80 位大小写数字混合"的
   高熵启发式，之前会被漏放并原样落盘，违反 F-004/AC-005 明确要求
   Token/Key/Cookie 三类都必须 `blocked` 的规定。修复：新增两条正则
   ——① `Cookie:`/`Set-Cookie:` 请求/响应头（大小写不敏感，命中即整行
   `blocked`）；② 不带头部前缀但值本身是已知会话 cookie 名称
   （`session_id`/`sessionid`/`PHPSESSID`/`JSESSIONID`/`connect.sid`/
   `auth_token`/`csrf_token`/`xsrf_token`）的赋值形式。design.md 模块 2
   已同步记录。新增回归测试：`redact.test.ts` 三条（Cookie 头/
   Set-Cookie 头/不带前缀的已知会话 cookie 名称）。
2. **[P1] `.superseded` 目录符号链接逃逸防护**（`write.ts` 的
   `upsertExperience()`）——第十四轮引入的 `assertProjectDirNotSymlink()`
   只检查了 `projectDir` 本身，没检查其下固定名为 `.superseded` 的
   归档子目录；如果它已经被预先替换成指向 `experienceRoot` 之外的
   符号链接，归档写入（更新已有文档时触发）会跟随符号链接逃逸。
   修复：把检查函数泛化为 `assertNotSymlink(targetDir)`，在归档步骤
   写入 `.superseded` 之前也调用一次（`fs.mkdir` 之前）。design.md
   模块 4 步骤 0/6.1 已同步记录，requirements.md AC-011 补充第二点。
   新增回归测试：`write.test.ts`「.superseded 目录被替换为指向根目录
   之外的符号链接时，归档写入被拒绝」（先正常创建 v1，再把
   `.superseded` 替换成符号链接，触发更新请求，断言符号链接指向的
   外部目录里不产生任何归档文件、不残留锁文件）。

## Codex Review 第十七轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **67/67 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 陈旧锁 unlink 持续失败时必须遵守 timeout，不得无限等待**
   （`write.ts` 的 `acquireLock()`）——陈旧锁回收分支原先是"判定为陈旧
   就无条件 `continue`"，完全不检查 `unlink` 是否真的成功。一旦
   `unlink` 持续失败（EACCES、只读文件系统等真实场景），循环会跳过
   下面的超时检查（`if (Date.now() > deadline)`）和 50ms 退避 sleep，
   退化成完全忽略 `timeoutMs` 的忙等待——既不会超时报错，也会占满 CPU
   空转，`acquireLock()` 事实上变成无限等待。修复：新增 `reclaimed`
   布尔量记录 `unlink` 是否真的成功，只有 `reclaimed === true` 才
   `continue` 立即重试；未能回收（含 `unlink` 失败、或 recheck 发现
   已不再陈旧/token 已变化）时落到下面统一的超时检查/退避分支，保证
   `acquireLock()` 在任何情况下都会在 `timeoutMs` 内返回（成功或抛出
   "获取经验写入锁超时"）。design.md 模块 3 已同步记录，requirements.md
   新增 AC-013。新增回归测试：`write.test.ts`「陈旧锁无法安全 unlink
   （持续失败）时必须遵守 timeoutMs，不无限忙等」——直接对
   `node:fs/promises` 共享的默认导出对象打补丁（同一模块实例，写入端
   与测试端 import 的是同一个单例，无需 `mock.module()`）让 `unlink`
   恒定拒绝，真实构造一把陈旧锁后调用 `acquireLock(lockPath, 300,
   { staleLockMs: 10 })`，断言：(a) 确实抛出"获取经验写入锁超时"；
   (b) 实际耗时 `elapsed >= 300ms`（证明真的等到了 timeout 边界，不是
   立即返回）且 `elapsed < 300ms + 3000ms`（证明没有远超 timeout，不是
   仍在忙等待）。**已做反向验证**：临时把修复改回"无条件 continue"，
   同一测试在 `--test-timeout=5000` 下被 node:test 判定
   `testTimeoutFailure`（进程真实挂起超过 5 秒），证明测试确实覆盖了
   这个具体 bug，不是形式主义的伪测试；验证后立即恢复修复版代码并重新
   跑通全部 67 项。

## Codex Review 第十八轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **68/68 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 归档文件路径本身的符号链接逃逸防护**（`write.ts` 的
   `upsertExperience()`）——第十六轮引入的 `assertNotSymlink()` 只
   检查了归档**目录**（`.superseded/`）本身不是符号链接，但归档目标是
   目录*里*的一个具体文件（`{document_id}@v{N}.md`），目录本身干净
   不代表这个文件路径也干净：攻击者可以预先在这个确切路径放一个指向
   `experienceRoot` 之外的符号链接，`fs.writeFile()` 默认会跟随文件级
   符号链接写入，绕过了目录层的检查。修复：新增 `writeArchiveFile()`，
   用 `fs.open(path, O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW)` 代替
   `fs.writeFile()`——`O_NOFOLLOW` 让 open 阶段本身在目标是符号链接时
   以 `ELOOP` 失败，不是"先 `lstat` 检查、再 `writeFile`"这种存在
   TOCTOU 窗口的两步做法；不加 `O_EXCL`，因为合法的崩溃后重试场景下
   同一路径可能已经是上一次尝试遗留的普通文件，此时应该允许覆盖。
   design.md 模块 4 步骤 6.1 已同步记录，requirements.md 新增 AC-014。
   新增回归测试：`write.test.ts`「归档文件路径本身（而非其父目录）是
   符号链接时，归档写入被拒绝，不覆盖外部文件」——预先在归档文件的
   确切路径放一个指向仓库外真实文件的符号链接，触发更新请求，断言：
   (a) `upsertExperience()` 拒绝（reject）；(b) 外部文件内容原封不动；
   (c) 符号链接本身未被移除/替换；(d) 不残留锁文件。**已做反向验证**：
   临时把 `writeArchiveFile()` 改回 `fs.writeFile()`，同一测试真实
   失败（"Missing expected rejection"——写入成功且跟随了符号链接），
   证明测试确实覆盖这个具体漏洞，不是形式主义的伪测试；验证后立即
   恢复修复版代码并重新跑通全部 68 项。

## Codex Review 第十九轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **77/77 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 内容级围栏检查必须同时比对 occurrence_count，不能只比
   content_hash**（`read-content-hash.ts`/`write.ts` 的
   `upsertExperience()`）——两次并发的**相同内容**提交都会走去重路径
   （`existing.content_hash === contentHash`），都只把
   `occurrence_count` 从同一个基线值各自独立 +1，`content_hash` 本身
   从头到尾不变；第十四轮引入的内容级围栏检查只比对 `content_hash`，
   如果锁机制的残余竞态窗口（见 design.md 模块 3）恰好让两者都通过了
   获取锁阶段，围栏检查会对这种"内容相同、仅计数字段变化"的并发写入
   完全失明，其中一次的 `occurrence_count` 增量会被另一次无声覆盖
   丢失，而两次都报告 `ok: true`——用户能看到的"这份经验被验证过 N 次"
   计数会失真，且没有任何错误提示。修复：
   - `read-content-hash.ts` 把 `readCurrentContentHash(): Promise<string
     | null>` 改造为 `readCurrentFenceState(): Promise<FenceState |
     null>`（`FenceState = { contentHash, occurrenceCount }`），新增
     `fenceStatesEqual()` 同时比对两个字段（任一侧为 `null` 时按引用
     相等处理，两侧都非 `null` 时两个字段都相同才算相等）。
   - `write.ts` 的 `baselineHash`（`string | null`）改为
     `baselineFence`（`FenceState | null`），两处围栏检查（步骤
     5.5/6.3）改用 `readCurrentFenceState()` + `fenceStatesEqual()`，
     错误信息同时报告基线与当前的 `content_hash`/`occurrence_count`
     便于排查。
   - 未额外纳入 `document_version`/`updated_at`：`document_version`
     只在 `content_hash` 变化的版本递增路径才会变化，已被
     `content_hash` 覆盖；`updated_at` 在两条写入路径下都会刷新，
     不独立提供额外的"发生过并发写入"信号，纳入只会增加时间戳字符串
     比较的噪音，不提升检测覆盖率。
   design.md 模块 4 步骤 4.5/5.5 已同步记录，requirements.md 新增
   AC-015。新增回归测试分两层，缺一不可：
   - `write.test.ts` 新增两个 `describe` 块，**不经过 `mock.module()`
     替换、直接测试真实的** `fenceStatesEqual()`/`readCurrentFenceState()`
     （5+2 项，含核心断言"content_hash 相同、occurrence_count 不同
     必须判定为不相等"）——这是本次 bug 真正被修复的地方，必须验证
     真实实现本身，不能只验证调用方的控制流。
   - 新建 `write.duplicate-content-conflict.test.ts`，用
     `mock.module()` 让 `readCurrentFenceState` 返回"`content_hash`
     与预先写入的 v1 完全相同、但 `occurrence_count` 已经被推进"的
     具体状态，验证 `upsertExperience()` 在提交相同内容时正确识别
     冲突并拒绝、不调用 `atomicWriteExperience`（2 项）——这一层验证
     `write.ts` 是否正确使用了这个依赖，与上一层互补，不能相互替代。
   **两层都做了反向验证**：临时把真实的 `fenceStatesEqual()` 改回只
   比 `content_hash`，`write.test.ts` 里的核心断言用例真实失败
   （断言 `true !== false`）；`write.duplicate-content-conflict.test.ts`
   最初的实现（把比较逻辑内联复刻进 `mock.module()` 的替换导出里）
   在同样的反向操作下**没有**失败——这个"伪阴性"本身被记录下来是为了
   提醒后续修改：`mock.module()` 会整体替换掉包括 `fenceStatesEqual`
   在内的所有导出，测试如果把"正确答案"内联写进 mock 里，反向验证会
   对真实实现的改动完全免疫，必须像上面第一层那样对真实、未替换的
   模块直接断言才能验证到位。

## Codex Review 第二十轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **84/84 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 带标注名称的低熵密钥/密码赋值补充检测规则**（`redact.ts` 的
   `TOKEN_PATTERNS`）——`API_KEY=abc123`/`client_secret=secret`/
   `password=hunter2` 这类值本身很短、很像普通单词的凭据赋值，既不
   匹配已知前缀模式（`sk-`/`Bearer`/`AKIA`），也不满足通用高熵启发式
   （32~80 位大小写数字混合），会被原样写入，违反 F-004/AC-005 明确
   要求 Token/Key/Cookie 三类都必须 `blocked` 的规定——与第十六轮
   Cookie 漏洞是同一类问题的不同具体表现。修复：新增一条正则，命中
   已知凭据标签（`api_key`/`api_secret`/`secret_key`/`client_secret`/
   `access_key`/`access_token`/`private_key`/`auth_key`/`signing_key`/
   `encryption_key`/`password`/`passwd`/`pwd`）+ `:`/`=` 赋值语法即
   `blocked: true`，不依赖值本身内容；标签后允许一个可选收尾引号
   （兼容 `{"api_key": "..."}` 这种 JSON 写法里字段名本身也带引号的
   情况）；值支持双引号/单引号/裸字符串三种写法。只收录明确是凭据
   语义的复合标签，不收录裸 "key"/"secret"/"token" 这类会在正常技术
   散文里大量出现、容易产生误伤的通用词。design.md 模块 2 已同步
   记录，requirements.md 新增 AC-016。新增回归测试：`redact.test.ts`
   7 条（`API_KEY=`/`client_secret=`/双引号 JSON 风格/`:` 分隔的 YAML
   风格/`password`|`passwd`|`pwd`/`access_token`|`private_key`|
   `access_key`/正常散文提及 password·key·secret 等词但无赋值语法时
   不应误判 blocked 的负向用例）。**已做反向验证**：临时移除新增规则，
   6 项正向用例真实失败，证明测试确实覆盖了这个具体漏洞；验证后立即
   恢复修复版代码并重新跑通全部 84 项。实现期发现的一处小偏差：第一版
   正则未处理"标签后紧跟一个收尾引号"的情况（JSON 字段名本身带引号，
   如 `{"api_key": "abc123"}`），导致这个真实存在的常见格式漏检——
   已在实现阶段发现并补上可选引号 `"?`，design.md 已同步记录为最终
   版本，不是先写错误版本再单独修一轮。

## Codex Review 第二十一轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **86/86 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 原子写入 tmp 路径可预测、且用 `fs.writeFile()` 跟随符号
   链接**（`atomic-write.ts:11`）——修复前 `atomicWriteExperience()`
   的临时文件路径是 `${targetPath}.tmp-${process.pid}-${Date.now()}`，
   在真正创建之前完全可预测；如果 experience 目录对本机其他进程可写，
   攻击者可以预先在这个确切路径放一个指向 `experienceRoot` 之外某
   文件的符号链接，`fs.writeFile()` 默认会跟随符号链接写入并截断
   链接指向的外部文件，绕开了 project/archive 路径已有的符号链接
   防护（AC-011/AC-014，分别是第十二、十八轮修的）——同一类攻击面
   在"原子写入"这最后一步被遗漏。修复：改用 `fs.open(tmpPath,
   O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW)` 排他创建 + 写入 + `close()`，
   替代 `fs.writeFile()`；`O_NOFOLLOW` 让 `open()` 在目标是符号链接
   时以 `ELOOP` 失败，`O_EXCL` 确保该路径此刻确实不存在任何东西
   （符号链接或普通文件）。同时给文件名追加一段 `randomUUID()`
   （不只是 pid+时间戳）作为纵深防御第二层，降低被提前猜中的概率——
   但真正的安全边界是 `O_NOFOLLOW`/`O_EXCL` 这两个标志本身，不依赖
   路径不可预测这一假设。`fs.rename(tmpPath, targetPath)` 保持不变，
   未做额外加固：POSIX `rename()` 语义是替换目标路径的目录项本身
   （即便目标已是符号链接，链接本身被替换掉），不会跟随目标符号
   链接写穿到它指向的位置，这与 `open`/`writeFile` 跟随符号链接的
   行为不同，属于本轮修复有意收窄的范围，不是遗漏。design.md 模块 3
   的代码样例与新增说明段落已同步记录，requirements.md 新增 AC-017。
   新增回归测试：新建 `atomic-write.test.ts`，用 `mock.module()` 固定
   `node:crypto` 的 `randomUUID()`、用 `node:test` 的 `mock.timers`
   固定 `Date.now()`，让 `atomic-write.ts` 内部拼出的 tmp 路径完全
   可预测（`process.pid` 本身即为已知真实值），从而能在测试里预先
   在这个确切路径放置一个指向仓库外部文件的符号链接：断言写入被拒绝
   （`ELOOP`/`EEXIST`）、外部文件内容未被覆盖、预置符号链接本身未被
   静默删除或替换、正式目标文件未被创建；另加一条"无预置符号链接时
   正常写入仍然成功"的用例防止过度收紧误伤正常路径（2 项）。**已做
   反向验证**：临时把 `atomic-write.ts` 还原为修复前的
   `fs.writeFile(tmpPath, ...)` 版本重跑该测试文件，符号链接逃逸用例
   真实失败（`Missing expected rejection`），证明测试确实覆盖了这个
   具体漏洞；随后用 `cp`+`diff` 校验逐字节还原修复版代码，重新跑通
   `experience:test` 全部 86 项。

## Codex Review 第二十二轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项 finding，已修复并补充回归测试，`npm run
experience:test` **88/88 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 经验文件规范路径本身是符号链接时读取会跟随**
   （`write.ts:345`）——`upsertExperience()` 每次更新前都会先读一次
   `{document_id}.md`（判断"是否已存在、要不要走去重/版本递增路径"），
   以及归档步骤里再读一次同一路径来复制旧内容进 `.superseded/`；两处
   都直接用 `fs.readFile(targetPath, "utf-8")`，如果这个规范路径已经
   被预先替换成指向 `experienceRoot` 之外的符号链接，读取会跟随写入
   读到外部文件内容，可能把它当作"现存版本"参与决策，甚至归档进
   `.superseded/`——project 目录（AC-011）、`.superseded` 目录（第
   十六轮）、`.superseded` 归档文件本身（第十八轮）、原子写入 tmp
   路径（第二十一轮）都已经有符号链接防护，唯独遗漏了这个每次更新都
   必然会先读一次的入口。修复：在 `read-content-hash.ts` 新增
   `readActiveFileNoFollow(targetPath): Promise<string | null>`，用
   `fs.open(path, O_RDONLY|O_NOFOLLOW)` 在 open 阶段本身拒绝跟随符号
   链接（`ELOOP` → 抛出描述性错误），不用"先 `lstat` 检查、再
   `readFile`"以避免 TOCTOU 窗口；路径不存在返回 `null`。`write.ts`
   的两处直接读取都换成这个函数，`readCurrentFenceState()` 内部也
   改为调用它（原本同样直接 `fs.readFile()`，是同一类攻击面）。
   design.md 步骤 4 与步骤 6.1 已同步记录，requirements.md 新增
   AC-018。新增回归测试：`write.test.ts` 新增一条用例，预先在
   `{document_id}.md` 这个确切路径放置指向仓库外部文件的符号链接
   （新建文档场景，命中步骤 4 的初次读取），断言 `upsertExperience()`
   拒绝、外部文件内容未被读取或覆盖、符号链接本身未被移除、未产生
   `.superseded/` 归档、未残留锁文件。**已做反向验证**：临时把
   `write.ts` 的这处读取还原为 `fs.readFile()`，新测试真实失败（错误
   变为"经验文件缺少 frontmatter 块"，证明确实跟随符号链接读到了
   外部文件内容），随后用 `cp`+`diff` 校验逐字节还原修复版代码。归档
   源读取（`write.ts` 第二处调用点）复用同一个已验证的安全函数，未
   单独构造"归档期间符号链接替换"这一更窄的竞态场景来重复验证——
   构造这种双重竞态需要在初次读取与归档读取之间人为插入符号链接替换
   动作，会是一个高度人工构造、脱离真实攻击路径的测试，用同一个已经
   过反向验证的底层函数替换两处调用点，比单独伪造这个极窄窗口更可靠。
   **实现期修复 mock.module() 副作用**：`write.conflict.test.ts` 与
   `write.duplicate-content-conflict.test.ts` 用 `mock.module()`
   整体替换了 `./read-content-hash.ts` 的导出，`write.ts` 新增的
   `readActiveFileNoFollow` 导入在这两个测试文件里变成 `undefined`，
   触发 `SyntaxError`（与第十九轮踩过的同一个坑：mock.module() 替换
   而非合并导出）——修复：在两个 mock 文件里各自补上
   `readActiveFileNoFollow` 的真实实现（而非打桩），原因与
   `fenceStatesEqual` 相同：这两个测试依赖它读取预先在磁盘上写好的
   真实 v1 文件，打桩会让 `existing` 判断读到假数据，测试就不再验证
   围栏检查本身。
2. **[P2] 原子写入失败时遗留孤儿 tmp 文件**（`atomic-write.ts:38`）——
   `handle.writeFile()`/`handle.close()`/`fs.rename()` 任一步失败时，
   已经用 `O_EXCL|O_NOFOLLOW` 创建成功的 tmp 文件从未被清理；磁盘
   耗尽、权限问题等瞬时故障会在每次失败重试后积累一份包含完整经验
   内容的孤儿 `.tmp-*` 文件，文档里一直把这些路径描述为"transient"，
   实际上从未被回收。修复：用外层 `try/catch` 包住"写入+关闭+rename"
   整个序列，失败时 `fs.unlink(tmpPath).catch(() => {})` 清理（清理
   本身的失败静默吞掉，不掩盖需要抛给调用方的原始错误），再重新抛出
   原始异常。design.md 模块 3 代码样例已同步记录，requirements.md
   新增 AC-019。新增回归测试：`atomic-write.test.ts` 新增一条用例，
   直接对 `node:fs/promises` 共享单例对象的 `fs.rename` 打补丁使其
   抛出一个已知的 `Error` 实例，断言 `atomicWriteExperience()` 原样
   抛出同一个错误对象（证明清理逻辑没有掩盖原始错误）、tmp 文件被
   清理、目标文件未被创建。**已做反向验证**：临时移除清理逻辑（还原
   为无 `try/catch` 的版本）重跑该测试文件，新测试真实失败（断言
   "rename 失败后不应残留 tmp 文件"，`expected: true, actual: false`），
   证明测试确实覆盖了这个具体问题；随后用 `cp`+`diff` 校验逐字节还原
   修复版代码，重新跑通 `experience:test` 全部 88 项。

## Codex Review 第二十三轮修复（2026-08-01，实现阶段）

针对已提交实现的 2 项 finding，已修复并补充回归测试，`npm run
experience:test` **91/91 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P1] 晚期围栏检查通过后、rename 之前所有权被窃取会导致更新静默
   丢失**（`write.ts:491`）——陈旧锁回收允许极小概率的"获取阶段短暂
   多方持有"（模块顶部注释一直如实说明的理论边界）。旧实现的最后一次
   `assertStillHeld()` 在晚期围栏检查*之前*调用，与真正的 rename 之间
   还隔着一次围栏检查的真实 I/O——如果所有权恰好在这段窗口内被另一
   进程回收并重新持有，而围栏状态本身没有变化（只是锁的归属变了，
   内容级围栏检查天生看不出这一点），旧实现会直接 rename：两个进程
   可能各自对着自己刚写入的内容做写入后读回校验并都验证成功、都报告
   `ok: true`，其中一次的更新被静默覆盖丢失——这是读回校验本身无法
   覆盖的镜像情形（它只能发现"自己写完之后又被别人覆盖"，无法发现
   "自己的 rename 覆盖了别人已经报告成功的写入"），"最终只有一个
   进程完成写入"这条模块顶部明确写下的保证因此被打破。修复：新增
   第三次 `await lock.assertStillHeld()`，紧贴在 `atomicWriteExperience()`
   之前、晚期围栏检查之后，中间不再夹任何其他 I/O，把"最后一次所有权
   校验"和"真正落盘"之间的窗口从"一次围栏检查的 I/O 耗时"压缩到
   "一次 Promise resolve 到下一次 await 之间"这个量级——纯 POSIX
   文件 API 无法把这个窗口彻底消灭到零（与模块顶部锁获取阶段、读回
   校验说明的是同一类"没有外部协调服务就无法从数学上完全消除"的理论
   边界），但这是目前能做到的最强保证。design.md 模块 4 步骤 3.5 已
   同步记录，requirements.md 新增 AC-020。新增回归测试：新建
   `write.split-brain-rename.test.ts`，用 `mock.module()` 让
   `readCurrentFenceState` 在第二次被调用（对应晚期围栏检查）时，作为
   副作用把真实锁文件内容替换成另一个 token（模拟"另一进程已经完成了
   完整的陈旧回收流程"这一既成事实），围栏状态本身照常返回"未变化"——
   专门用来证明"必须靠新增的所有权校验、而不是围栏检查本身"才能堵住
   这个窗口。断言 `upsertExperience()` 返回 `{ok:false, reason:
   "lock_lost"}`、`atomicWriteExperience` 从未被调用、接班者的锁内容
   未被误删（2 项）。**已做反向验证**：临时移除新增的第三次
   `assertStillHeld()` 重跑该测试文件，新测试真实失败
   （`atomicWriteExperience` 被实际调用，报错信息正是测试里预置的
   "不应该走到这里"），证明测试确实覆盖了这个具体窗口；随后用
   `cp`+`diff` 校验逐字节还原修复版代码。
2. **[P2] 心跳按路径操作会误刷新接班者新锁的 mtime**（`write.ts:109`）
   ——旧实现的心跳定时器用 `fs.utimes(lockPath, ...)` 按路径操作：如果
   本进程停顿过久导致自己的锁被判定陈旧并回收（另一进程 `unlink` 后在
   同一路径创建了自己的新锁），本进程恢复后若心跳仍按路径操作，会不加
   区分地刷新"此刻这个路径上无论是谁的锁"的 mtime——把接班者的新锁
   误刷新成"看起来很新鲜"，即使接班者随后真的崩溃，陈旧检测也会被这个
   僵尸心跳永久蒙蔽，探测不到，锁可能一直卡到原进程自己退出为止，
   违背了"陈旧锁能被自动回收"这条基本设计前提。修复：`tryCreateFresh()`
   改为返回打开的 `FileHandle`（而不是布尔值），心跳定时器改用
   `handle.utimes()` 基于这个已打开的 fd 操作——`unlink` 只是移除目录
   项，持有的 fd 仍然引用着原来那个（此刻已从目录中摘除的）inode，
   `handle.utimes()` 只会作用在这个"幽灵" inode 上，天然不会影响同一
   路径上新创建的文件，不需要额外的"心跳前先校验归属"这类本身仍有
   TOCTOU 窗口的补丁。`release()` 相应地在 `finally` 里补上
   `handle.close()`。design.md 模块 3 的 `tryCreateFresh`/`acquireLock`
   代码样例已同步记录，requirements.md 新增 AC-021。新增回归测试：
   `write.test.ts` 的 `acquireLock/release` describe 块新增一条用例，
   用短 `heartbeatIntervalMs` 获取一把锁后，直接操作文件系统模拟"另一
   进程已完成完整的陈旧回收流程"（`unlink` 原锁、以新 token 重新创建、
   把 mtime 设成陈旧值），等待数个心跳间隔后断言新锁的 mtime 未被刷新、
   内容未被破坏（1 项）。**已做反向验证**：临时把心跳改回按路径操作
   重跑该测试文件，新测试真实失败（`实际 mtime 距设定值偏移
   600147ms`，证明僵尸心跳确实刷新了接班者的锁），随后用 `cp`+`diff`
   校验逐字节还原修复版代码，重新跑通 `experience:test` 全部 91 项。

## Codex Review 第二十四轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 finding，已修复并补充回归测试，`npm run
experience:test` **92/92 通过**、`npm run test`（既有套件）**82/82 无
回归**：

1. **[P2] 排他创建成功但写入 token 失败时遗留孤儿锁文件与已泄漏句柄**
   （`write.ts:68`）——`tryCreateFresh()` 用 `fs.open(..., O_EXCL)`
   排他创建锁文件成功之后，紧接着 `handle.writeFile(token, ...)` 这
   一步如果失败（磁盘耗尽/瞬时 I/O 错误等），旧实现既不关闭这个已经
   打开的句柄，也不清理磁盘上已经留下的这份空 `.lock` 文件——后续任何
   进程调用 `acquireLock()` 都会把这份空文件当作"别人持有的活跃锁"，
   需要等满一整个 `staleLockMs`（默认 5 分钟）才能判定陈旧并回收，把
   一次瞬时故障放大成一次长时间阻塞，还掩盖了真正的失败原因（调用方
   只会看到"获取经验写入锁超时"，看不到背后真正的磁盘/IO 错误）。
   修复：给 `handle.writeFile(token, ...)` 包一层 `try/catch`，失败时
   依次 `handle.close()`（吞掉关闭本身的失败）、`fs.unlink(lockPath)`
   （吞掉删除本身的失败，此刻这份文件必然是我们自己刚创建的空文件，
   不会误删别人的锁），再把原始错误原样抛出——两个清理动作都不能
   掩盖需要抛给调用方的真实错误。design.md `tryCreateFresh()` 代码
   样例已同步记录，requirements.md 新增 AC-022。新增回归测试：
   `write.test.ts` 的 `acquireLock/release` describe 块新增一条用例，
   直接对共享的 `fs/promises` 单例的 `fs.open` 打补丁，返回一个包了
   一层 `Proxy` 的真实 handle——`writeFile` 恒定抛出已知错误，其余
   方法（尤其 `close`）显式 `.bind(target)` 委托给真实 handle（不能
   让 Proxy 本身作为 `this` 被调用，Node 的 `FileHandle` 内部用私有
   字段做 brand check，否则会在 `close()` 里直接抛错）。断言
   `acquireLock()` 原样抛出这个已知错误对象、锁路径上不残留任何文件
   （1 项）。**已做反向验证**：临时移除清理逻辑重跑该测试文件，新
   测试真实失败（`Missing expected rejection`，且进程输出里出现了
   Node 自带的"Closing file descriptor ... on garbage collection"
   警告，独立佐证了句柄确实被泄漏），证明测试确实覆盖了这个具体
   问题；随后用 `cp`+`diff` 校验逐字节还原修复版代码，重新跑通
   `experience:test` 全部 92 项。

## Codex Review 第二十五轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 + 1 项 P2 finding，已修复并补充回归测试，
`npm run experience:test` **93/93 通过**、`npm run test`（现已链入
`experience:test`）**82/82 + 93/93 全部通过、无回归**：

1. **[P1] 内容实质变化的新版本沿用旧版本的 verified/deprecated 状态，
   绕过生命周期审核约束**（`write.ts:430`）——`content_hash` 不同的
   更新走版本递增分支时，`frontmatter = { ...existing, ... }` 展开
   了旧 frontmatter 的全部字段，其中包括 `status`：如果旧版本已经被
   标记为 `verified`（走过 `lifecycle.ts` 的 `canVerify()` 校验）或
   `deprecated`，新内容会原样继承这个状态——一份从未被审核过的全新
   内容可以直接以 `verified` 姿态出现，绕开了文档明确记录的
   candidate→verified→deprecated 单向生命周期约束；已经 deprecated
   的文档 ID 下提交全新内容，也会让这份本该重新审核的内容永久卡在
   deprecated，再也无法被正常验证。修复：在版本递增分支的
   frontmatter 对象里显式补上 `status: "candidate"`，覆盖掉 spread
   带过来的旧值。design.md 步骤 4 已同步记录，requirements.md 新增
   AC-023。新增回归测试：`write.test.ts` 的 AC-004 describe 块新增
   一条用例——先正常创建 v1，直接在磁盘上把它的 `status` 改写为
   `verified`（不经过 `lifecycle.ts` 的 `transition()`，因为这里只
   关心 write.ts 版本递增分支对已有 status 字段的处理，与 lifecycle
   状态机本身的迁移规则是两回事），再提交内容不同的更新，断言新版本
   的 `status` 是 `candidate` 而不是延续的 `verified`（1 项）。**已做
   反向验证**：临时移除新增的 `status: "candidate"` 重跑该测试文件，
   新测试真实失败（`actual: 'verified', expected: 'candidate'`），
   证明测试确实覆盖了这个具体问题；随后用 `cp`+`diff` 校验逐字节还原
   修复版代码，重新跑通 `experience:test` 全部 93 项。
2. **[P2] 新增的 experience 测试套件未接入默认 test 命令**
   （`mastra-agent/package.json:22`）——`experience:test` 一直只能通过
   单独调用 `npm run experience:test` 执行，仓库默认的 `npm test`
   入口（`typecheck && agent:test:unit`）从未包含它；任何依赖这个
   默认入口的 CI 或开发流程（比如只跑 `npm test` 就认为"测试通过"）
   都会对这个新 Feature 引入的回归视而不见。修复：`package.json` 的
   `test` 脚本改为 `npm run typecheck && npm run agent:test:unit &&
   npm run experience:test`。design.md 版本表已同步记录，
   requirements.md 新增 AC-024。验证方式即是本轮验证本身：直接运行
   `npm run test` 并确认输出里同时出现 `agent:test:unit`（82 项）和
   `experience:test`（93 项）两组结果、均全部通过——这个命令本身就是
   对这条 finding 最直接的回归测试，不需要额外新建测试文件。

## Codex Review 第二十六轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **94/94 通过**、`npm run test`（链式 typecheck +
agent:test:unit + experience:test）**82/82 + 94/94 全部通过、无
回归**：

1. **[P1] 归档源读取前未核实内容仍是基线版本，可能把错误版本的内容
   永久写进历史归档**（`write.ts:476`）——早期围栏检查（步骤 5.5）
   通过之后、归档源读取（步骤 6.1）真正执行之前，若另一个写入者恰好
   完成了自己完整的一轮更新（读到旧内容→写入新内容→rename），本进程
   这里读到的 `oldRaw` 已经是对方刚写入的新版本；旧实现不加核实就
   直接把它写进按本进程自己（此刻已陈旧）的 `archiveOldVersion` 算出
   的归档路径——即使下面步骤 6.3 的第二次围栏检查随后发现冲突并让
   整个 `upsertExperience()` 报告 `conflict`，归档文件此刻已经被
   污染，无法撤销，违反"报告冲突就等于没有产生副作用"这一隐含承诺，
   也违反历史版本必须完整保留的保证。修复：读到 `oldRaw` 之后、调用
   `writeArchiveFile()` 之前，用 `oldRaw` 自己解析出一份围栏状态
   （不需要额外一次磁盘读取——直接 `coerceFrontmatter(parseExperienceFile
   (oldRaw).frontmatter)` 取 `content_hash`/`occurrence_count`），与
   步骤 4.5 记录的 `baselineFence` 用 `fenceStatesEqual()` 比较，不
   一致就直接返回 `{ ok: false, reason: "conflict" }`，不写入归档
   文件。design.md 步骤 6.1 已同步记录，requirements.md 新增 AC-025。
   新增回归测试：新建 `write.archive-source-conflict.test.ts`，用
   `mock.module()` 让 `readActiveFileNoFollow` 第一次调用（步骤 4 初次
   读取）返回真实 v1 内容，第二次调用（步骤 6.1 归档源读取）返回一份
   "已被另一进程替换"的合法 v2 内容（围栏状态与 v1 基线不同）；同时
   让 `readCurrentFenceState`（早期围栏检查用到的另一个函数）恒定
   返回与基线一致的状态，精确把问题留给归档源读取这一步暴露。断言：
   `upsertExperience()` 返回 `conflict`、归档文件从未被创建（不是
   "创建了但内容错"，而是"根本没走到创建这一步"）、`atomicWriteExperience`
   从未被调用（1 项）。**已做反向验证**：临时移除新增的围栏核实重跑
   该测试文件，新测试真实失败（`atomicWriteExperience` 被实际调用，
   报错信息正是测试里预置的"不应该走到这里"），证明测试确实覆盖了
   这个具体窗口；随后用 `cp`+`diff` 校验逐字节还原修复版代码，重新
   跑通 `experience:test` 全部 94 项。

## Codex Review 第二十七轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P2 finding，已修复并补充回归测试，`npm run
experience:test` **98/98 通过**、`npm run test`（链式 typecheck +
agent:test:unit + experience:test）**82/82 + 98/98 全部通过、无
回归**：

1. **[P2] `validateExperience()` 未校验 F-002 要求的一级标题**
   （`schema.ts:141`）——F-002 明确要求正文结构是 `# 标题` 在前、9 个
   二级标题在后，旧实现只调用 `parseExperienceSections()` 检查了 9
   个二级标题是否齐全，完全没有校验一级标题本身是否存在：没有一级
   标题的正文、或一级标题前有任意无关文字（比如一段开场白）的正文，
   都能通过校验并被持久化，写入结构不合法的经验文档，违反文档化的
   schema。修复：新增私有函数 `hasTopLevelTitle(body): boolean`，
   在 `validateExperience()` 里紧邻二级标题检查之前调用，只检查正文
   的第一条非空行是否匹配 `/^#\s+\S/`（单个 `#` 后至少一个空白、再跟
   非空白标题文字）——`\s+` 紧跟在唯一的 `#` 之后天然排除了 `##` 这类
   更深层标题（第二个 `#` 会让 `\s+` 匹配失败），不需要额外判断层级；
   校验的是"是否存在合法的一级标题"，不要求标题文字是字面的"标题"
   二字（测试夹具里的 `"# 标题"` 只是示例文本）。design.md 模块 1
   已同步记录，requirements.md 新增 AC-026。新增回归测试：
   `schema.test.ts` 新增 4 条用例——缺少一级标题时失败、一级标题前有
   无关文字时失败、一级标题误写成 `##`（二级标题）时失败、一级标题
   文字换成非字面"标题"的自定义文本时仍然通过（负向用例，防止过度
   收紧误伤正常标题）。**已做反向验证**：临时移除新增的
   `hasTopLevelTitle()` 调用重跑该测试文件，前三条用例真实失败
   （`expected: false, actual: true`），第四条（正向用例）保持通过，
   证明测试确实精确覆盖了这个具体校验缺口而非误报；随后用 `cp`+
   `diff` 校验逐字节还原修复版代码，重新跑通 `experience:test` 全部
   98 项。

## Codex Review 第二十八轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P1 finding，已修复并补充回归测试，`npm run
experience:test` **99/99 通过**、`npm run test`（链式 typecheck +
agent:test:unit + experience:test）**82/82 + 99/99 全部通过、无
回归**：

1. **[P1] 归档写入用 O_TRUNC 原地截断，不是原子操作，崩溃/失败可能
   销毁唯一旧版本归档**（`write.ts:315`）——活跃文档路径的写入
   （`atomicWriteExperience()`）一直是 tmp+rename 的原子模式，但归档
   文件的写入（`writeArchiveFile()`）用的是 `fs.open(path,
   O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW)` 直接原地写——如果进程在
   `handle.writeFile()` 执行到一半时崩溃，或该调用本身因磁盘耗尽等
   瞬时故障失败，`O_TRUNC` 已经在 open 阶段截断了目标文件，归档文件
   会残留为空文件或半截内容；这份归档正是 F-005/F-006 明确要求"不
   覆盖旧版本历史"要保留的唯一副本，一旦损坏无法恢复，违反 F-006
   "崩溃不得留下半截 Markdown"的要求。修复：`writeArchiveFile()`
   改为 tmp+rename 原子写入模式——但**不能直接复用
   `atomicWriteExperience()`**：`fs.rename()` 替换目标目录项本身
   （不跟随符号链接）虽然不会写穿到符号链接指向的外部文件，但会把
   符号链接*本身*静默替换成归档文件，违反 AC-014"符号链接本身不得
   被移除或替换"这条已经用回归测试固化的明确要求。具体实现：新增
   `assertArchiveTargetNotSymlink()`（`lstat` 检查，不是符号链接的
   `ENOENT`/普通文件都放行，是符号链接就抛出与旧实现文案一致的错误），
   在写入 tmp 文件*之前*调用一次（拒绝已知的符号链接），紧贴在最终
   `rename` *之前*再调用一次（缩小检查到写入之间的窗口，与本文件
   一贯的"能用一次系统调用堵住就不留检查-写入两步窗口"原则一致，
   POSIX 无法把窗口彻底消灭到零，是已被多次记录的理论边界）；tmp 文件
   本身用 `O_EXCL|O_NOFOLLOW` 排他创建（与 `atomic-write.ts` 同构，
   同样需要防护 tmp 路径本身被预置符号链接）；写入/rename 任一步失败
   都 `unlink` 清理 tmp 文件、不掩盖原始错误。design.md 步骤 6.1 已
   同步记录，requirements.md 新增 AC-027。新增回归测试：`write.test.ts`
   新增一条用例——先手工在 `.superseded/` 下预置一份"上一次尝试遗留"
   的合法归档内容（模拟崩溃后重试场景，这正是旧实现坚持"不加 O_EXCL"
   要兼容的场景），再对共享的 `fs/promises` 单例的 `fs.rename` 打
   补丁使其抛出已知错误，触发一次会归档 v1 的更新，断言：升级请求
   原样抛出这个已知错误、**预置的旧归档内容完全未被触碰**（不是被
   截断成空文件，不是被替换成半截内容）、`.superseded/` 下不残留
   任何 tmp 文件（1 项）。已确认既有的"归档文件路径本身是符号链接
   时拒绝写入、符号链接不被移除"回归测试（第十七轮/AC-014）在新
   实现下依然通过，behavior 完全保留。**已做反向验证**：临时把
   `writeArchiveFile()` 还原为 `O_TRUNC` 原地写版本重跑该测试文件，
   新测试真实失败（预置的旧归档内容被替换成了本次更新计算出的 v1
   内容——旧实现在真正触发本次注入的 rename 失败之前，已经无条件
   完成了对归档文件的原地覆盖，恰好印证了它压根不具备任何原子性/
   失败容错），证明测试确实覆盖了这个具体问题；随后用 `cp`+`diff`
   校验逐字节还原修复版代码，重新跑通 `experience:test` 全部 99 项。

## Codex Review 第二十九轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P2 finding，已修复并补充回归测试，`npm run
experience:test` **100/100 通过**、`npm run test`（链式 typecheck +
agent:test:unit + experience:test）**82/82 + 100/100 全部通过、无
回归**：

1. **[P2] 写入后读回校验仍用会跟随符号链接的 fs.readFile()，是本
   模块唯一遗漏这道防护的活跃文件读取**（`write.ts:625`）——步骤 4
   的初次存在性判断（AC-018）、步骤 6.1 的归档源读取（同样是
   AC-018 覆盖范围）、`readCurrentFenceState()` 内部读取都已经在
   第二十二/二十六轮统一改用 `readActiveFileNoFollow()`，唯独
   `atomicWriteExperience()` 完成之后的最终读回校验还是原样
   `fs.readFile(targetPath, "utf-8").catch(() => null)`：如果
   rename 完成、函数返回之后到这里真正读取之前，另一个本机进程恰好
   把规范路径替换成指向一份"`document_version`/`occurrence_count`/
   `content_hash` 都精心构造成与本次写入完全匹配"的外部伪造文件的
   符号链接，`fs.readFile()` 会跟随写入并读到这份伪造内容，字段比对
   全部通过，`upsertExperience()` 因此谎报 `ok: true`——调用方以为
   自己的更新已经安全生效，实际上规范路径此刻已经是别人放置的符号
   链接，读到的还是 `experienceRoot` 之外的数据。旧实现用
   `.catch(() => null)` 把包括符号链接触发的 `ELOOP` 在内的所有错误
   都吞成"未生效"→`conflict`，看似安全降级，实际上掩盖了这个本该
   向调用方明确报警的异常情形。修复：把这次读取换成
   `readActiveFileNoFollow(targetPath)`（去掉 `.catch()`，让符号
   链接对应的错误直接抛出——`readActiveFileNoFollow()` 内部只把
   "文件不存在"这一个确定状态映射为 `null`）。design.md 步骤 6.5 已
   同步记录，requirements.md 新增 AC-028。新增回归测试：新建
   `write.verify-symlink.test.ts`，用 `mock.module()` 让
   `atomicWriteExperience` 先真实完成写入，再作为副作用立即把刚写好
   的规范文件替换成指向一份"围栏字段精确匹配本次写入"的外部伪造文件
   的符号链接，精确复现"rename 完成、函数返回"到"读回校验真正执行"
   之间的这个具体窗口。断言 `upsertExperience()` 必须直接抛出（不是
   返回 `ok: true`，也不是返回一个掩盖真相的 `conflict`）、符号链接
   本身未被移除、外部伪造文件内容未被覆盖（1 项）。**已做反向验证**：
   临时把这次读取还原为 `fs.readFile().catch(() => null)`，新测试
   真实失败（`Missing expected rejection`——`upsertExperience()`
   跟随符号链接读到了伪造内容，字段全部匹配，静默返回了
   `ok: true`），证明测试确实覆盖了这个具体窗口；随后用 `cp`+`diff`
   校验逐字节还原修复版代码，重新跑通 `experience:test` 全部 100
   项。

## Codex Review 第三十轮修复（2026-08-01，实现阶段）

针对已提交实现的 1 项 P2 finding，已修复并补充回归测试，`npm run
experience:test` **101/101 通过**、`npm run test`（链式 typecheck +
agent:test:unit + experience:test）**82/82 + 101/101 全部通过、无
回归**：

1. **[P2] content_hash 基于归一化前的文本计算，与实际落盘内容的
   归一化规则不一致**（`write.ts:402`）——`serializeExperienceFile()`
   落盘正文时执行的是 `body.trim() + "\n"`，但 `content_hash` 一直是
   直接对 `redactedBody.text`（脱敏后、未经归一化）求哈希：如果
   candidate 的正文带前导空白，或结尾有多个换行（比如用户把之前持久化
   文件读回来的正文原样再提交一次——持久化文件本身就以单个 `\n`
   结尾，加上编辑器/复制粘贴习惯性追加的空行），两次语义完全相同、
   序列化后字节完全一致的提交会因为归一化前的原始文本不同而算出不同
   的 `content_hash`，被误判成"内容变化"，触发不必要的
   `document_version` 递增和一次不必要的归档，本该走 F-005 去重路径
   （只 `occurrence_count += 1`）的重复提交被错误处理。修复：计算
   `redactedBody.text` 之后立即算出 `normalizedBody =
   redactedBody.text.trim()`，后续 `content_hash` 计算、
   `validateExperience()` 调用、`serializeExperienceFile()` 调用三处
   全部改用这同一个 `normalizedBody`，不再各自独立引用
   `redactedBody.text`（`serializeExperienceFile()` 内部对已经 trim
   过的字符串再 `.trim()` 是幂等操作，行为不变）。design.md 步骤 2
   已同步记录，requirements.md 新增 AC-029。新增回归测试：
   `write.test.ts` 的 AC-004 describe 块新增一条用例——先正常提交一次
   `VALID_BODY`，再提交语义相同、只是前面多了空行/后面多了几个换行的
   `\n\n${VALID_BODY}\n\n\n`，断言第二次提交 `document_version` 保持
   为 1（不递增）、`occurrence_count` 从 1 累加到 2（走去重路径）、
   `.superseded/` 目录从未被创建（1 项）。**已做反向验证**：临时把
   `contentHash` 的计算还原为对未归一化的 `redactedBody.text` 求哈希
   （`normalizedBody` 也相应还原为未 trim 的原始文本），新测试真实
   失败（`document_version` 变成了 2，`2 !== 1`），证明测试确实覆盖了
   这个具体问题；随后用 `cp`+`diff` 校验逐字节还原修复版代码，重新
   跑通 `experience:test` 全部 101 项。

## Codex Review 第三十一轮修复（2026-08-01，实现阶段）——Feature 1 最后一轮

[P1] `experienceRoot` 本身是符号链接时未被拦截，写入实际落到配置根
之外（`write.ts:412`）——`assertWithinRoot()` 词法比较、
`assertNotSymlink(projectDir)` 的 lstat 只护路径最后一段，均拦不住
`experienceRoot` 自身是符号链接的情况。修复：计算 `projectDir` 之前
新增 `await assertNotSymlink(candidate.experienceRoot)`（复用既有
函数，只护配置根这一层，不递归查更上层祖先——记录为已知边界，见
requirements.md AC-030）。新增回归测试 `write.test.ts`：把
`experienceRoot` 指向一个符号链接、指向真实的外部临时目录，断言拒绝、
外部目录内无任何文件被创建、符号链接本身未被移除（1 项）。已反向
验证：移除新增检查后测试真实失败（`Missing expected rejection`），
`cp`+`diff` 确认逐字节还原修复版代码。`experience:test` 101→102。

**Feature 1 收敛，冻结功能/安全范围**：`npm run experience:test`
102/102 通过，`npm run test`（链式 typecheck + agent:test:unit +
experience:test）82/82 + 102/102 全部通过。经 31 轮 Codex Review
（12~31 轮均为实现阶段发现），未发现新的可由 AC-001~AC-030 证明的
问题。按用户指示，Feature 1 到此收敛，不再主动扩展审查范围；后续如
在 Feature 2~5 或真实使用中发现与 Feature 1 相关、可复现、影响当前
功能的缺陷，仍按 P0/P1 must-fix 规则处理，但不再对"理论竞态/极端
文件系统攻击/规格外增强"做预防性加固。

## Future Hardening（记录但不阻塞——非验收标准内的推测性加固点）

以下是审查过程中曾被考虑但判定为"超出当前验收标准/威胁模型"、故未
实现的加固方向，留档供未来按需评估，不代表已确认的缺陷：

- `experienceRoot` 更上层祖先目录（不只是 `experienceRoot` 自身）被
  替换为符号链接的情况，未做递归检查（见 AC-030 说明）。
- 锁获取阶段"极小概率短暂多方持有"的残留 TOCTOU 窗口（模块顶部注释
  多次提及，POSIX 文件 API 无法在没有外部协调服务/分布式锁的情况下
  从数学上完全消除，已通过 assertStillHeld() + 内容级围栏检查压缩到
  最小实际可行窗口）。
- 写入后读回校验/围栏检查之间的窗口同理，已压缩但未彻底消灭到零。
