# Claude 工作流经验 RAG 学习闭环 — 实施交接记录

**最后更新**：2026-08-01（Feature 5 全局接入 `~/.claude` 已覆盖
init/prd/ai 三个命令，Codex Review 全部轮次（含最后一次定向修复：
`bulk-ingest.ts` 孤儿向量点清理 + rebuild 删除失败中止）已收敛，
209/209 PASS，端到端 dry-run（含孤儿点清理、向量缺失两类回归场景）
验证通过，等待用户最终确认后再决定是否 commit）

## 当前状态

需求+设计阶段（5 个 Feature 的 requirements.md/design.md/tasks.md）已
全部通过 Codex Review（历经 11 轮 BLOCK→修复→复审），提交为
[c55e9d5]。用户已明确授权继续 `/yd:ai` 实现阶段。

**Feature 1 已于 2026-08-01 冻结**（经 31 轮 Codex Review 收敛，
`npm run experience:test` **102/102 通过**，`npm run test`
**82/82 + 102/102 全部通过**）。冻结范围内的功能/安全实现不再接受
非验收标准（AC-001~AC-030）内的推测性增强；曾考虑但判定超出当前
威胁模型/规格的加固点记录在 `specs/1.data-model/tasks.md` 底部
"Future Hardening" 一节。

**Feature 2 起的实现阶段约定（用户 2026-08-01 更新，覆盖此前的逐轮
详尽记录风格）**：
- 每个 Task 完成后更新 `tasks.md` 与本文件（可以简洁，不必逐轮写
  长篇修复记录）。
- 单个 Feature 的 Codex Review **最多主动进行 3 轮**；超过后把未决项
  汇总记录（同样放 Future Hardening 或对应 Feature 的 tasks.md），
  直接进入下一个 Feature，不再反复收敛同一个 Feature。
- Codex Review finding 收敛规则：P0/P1 且能由当前验收标准证明 → 必须
  修复；P2 → 只修复明确可复现、影响当前功能的问题；推测性的极端
  文件系统攻击/理论竞态/规格外增强 → 记录到 Future Hardening，不阻塞
  当前 Feature。
- **不允许 `git add`/`commit`/`push`**，除非用户后续再次明确授权。
- 额度不足时先更新本文件再停止。

## Feature 进度

| Feature | 状态 | 说明 |
| ---- | ---- | ---- |
| 1. data-model | ✅ 已冻结（102/102 PASS，31 轮 Review） | 见下方详情 |
| 2. store-retrieval | ✅ 已完成（T-001~T-008，142/142 PASS + 2/2 live） | 见下方详情 |
| 3. cli-commands | ✅ 已完成（T-001~T-008，179/179 PASS + 真实全链路冒烟） | 见下方详情 |
| 4. quality-gates | ✅ 已完成（T-001~T-006，188/188 PASS，离线可运行已实测） | 见下方详情 |
| 5. workflow-integration | ✅ 已完成（T-001~T-005，195/195 PASS） | 见下方详情 |

## Feature 1: data-model — 完成详情

- **实现文件**：`mastra-agent/src/experience/`
  - `schema.ts` — `ExperienceFrontmatter`/`REQUIRED_SECTIONS`/
    `generateDocumentId`/`parseExperienceSections`/`validateExperience`/
    `parseExperienceFile`/`coerceFrontmatter`/`serializeExperienceFile`
  - `redact.ts` — `redact()`，8 类脱敏规则
  - `atomic-write.ts` — `atomicWriteExperience()`（独立文件，供
    `mock.module()` 拦截测试崩溃场景）
  - `read-content-hash.ts` — `readCurrentFenceState()`/`fenceStatesEqual()`/
    `readActiveFileNoFollow()`（第十九轮由 `readCurrentContentHash()`
    重构而来；`readActiveFileNoFollow()` 是第二十二轮新增，供 write.ts
    安全读取 `{document_id}.md` 规范路径；独立文件，供 `mock.module()`
    拦截测试内容级围栏冲突场景）
  - `write.ts` — `acquireLock`/`lockPathFor`/`LockLostError`/
    `upsertExperience()`（re-export `atomicWriteExperience`）
  - `lifecycle.ts` — `transition`/`transitionIdempotent`/`canVerify`
  - `index.ts` — 对外导出面（对齐 design.md 接口契约）
- **测试**：`schema.test.ts`/`redact.test.ts`/`lifecycle.test.ts`/
  `write.test.ts`/`write.crash-ordering.test.ts`/
  `write.conflict.test.ts`/`write.duplicate-content-conflict.test.ts`/
  `write.split-brain-rename.test.ts`/`write.archive-source-conflict.test.ts`/
  `write.verify-symlink.test.ts`/`atomic-write.test.ts`，`npm run
  experience:test`（已加入 `mastra-agent/package.json`，带
  `--experimental-test-module-mocks`）
  ——**102/102 通过**（含第十二~三十一轮追加的回归测试；
  `experience:test` 脚本用 glob `src/experience/*.test.ts`，新增测试
  文件自动被拾取，无需手动登记）。
- **回归验证**：`npm run test`（第二十五轮起已改为 `typecheck &&
  agent:test:unit && experience:test` 三段链式，默认入口不再跳过
  experience 测试套件，见下方第二十五轮修复记录）——**82/82 +
  102/102 全部通过**，无回归，未触碰冻结路径。
- **Codex Review 第十二轮修复**（详见 `specs/1.data-model/tasks.md`
  底部记录）：
  1. [P1] `upsertExperience()` 在归档步骤后、`atomicWriteExperience()`
     前补一次 `assertStillHeld()`，堵住"归档 I/O 耗时期间所有权丢失"
     的静默覆盖窗口。
  2. [P2] `redact()` 的远程主机判定排除纯数字点分版本号（"Node
     22.1.0"不再被误判为主机）。
  3. [P2] `schema.ts` 的 frontmatter 序列化补上 YAML 标量转义/引用
     （`title`/`source` 含冒号/井号/特殊字符时不再产出无效 YAML）。
- **Codex Review 第十三轮修复（安全相关，均为 P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. `title`/`source`/`project_scope` 补上强制脱敏——之前只脱敏
     `body`，这三个字段是同样 candidate 可控的自由文本，绕过了写入前
     强制脱敏要求，任一 `blocked` 都会拒绝写入。
  2. `project_scope` 路径穿越防护——新增 `isSafeProjectScope()` 白名单
     校验 + `assertWithinRoot()` 二次兜底，拒绝 `../../etc`/绝对路径/
     含分隔符的值，防止在 `experienceRoot` 之外创建文件。
- **Codex Review 第十四轮修复（安全相关，均为 P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. 陈旧锁回收收紧（紧贴 unlink 前重新校验内容一致）+ **内容级乐观
     并发围栏检查**（落盘前重新比对目标文件当前 `content_hash` 与
     基线，不一致则 `reason: "conflict"` 中止）——后者是真正独立于锁
     机制的第二道防线，不管锁本身经历怎样的竞态都能挡住静默覆盖。
  2. `project_scope` 符号链接逃逸防护——新增 `assertProjectDirNotSymlink()`
     用 `lstat` 显式拒绝"对应目录已存在且是指向根目录之外的符号链接"
     这一逃逸手法（纯词法路径比较不会跟随符号链接）。
- **Codex Review 第十五轮修复（安全相关，均为 P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. 内容级围栏检查从"归档之后"移到"归档之前"（拆成两次：归档前一次、
     归档后再一次），修复冲突时已经产生 `.superseded/` 归档文件、违反
     "冲突不写入任何文件"承诺的 bug。
  2. 新增**写入后读回校验**——`atomicWriteExperience()` 成功后立即
     读回目标文件确认确实是本次写入的版本，不一致则事后报告
     `conflict` 而不是谎称 `ok: true`；如实说明这仍不是数学上完全
     消除竞争写入的窗口（与锁获取阶段的理论边界同类），只是保证不会
     有调用方收到成功假象。
- **Codex Review 第十六轮修复（安全相关，均为 P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. `redact()` 补上 Cookie 类凭据的专门检测规则——普通 Cookie 值
     （如 `session_id=abc123`）往往低熵，不满足既有的"高熵启发式"，
     之前会被漏放；新增 `Cookie:`/`Set-Cookie:` 头部检测 + 已知会话
     cookie 名称赋值检测，两者命中都直接 `blocked`。
  2. `.superseded` 归档目录的符号链接逃逸防护——第十四轮引入的符号
     链接检查只覆盖了 `projectDir` 本身，遗漏了其下固定名为
     `.superseded` 的归档子目录；泛化成 `assertNotSymlink()` 并在
     归档写入前也检查一次。
- **Codex Review 第十七轮修复（P1）**（详见 `specs/1.data-model/tasks.md`
  底部记录）：陈旧锁回收分支的 `continue` 从无条件改为
  `if (reclaimed) continue`——`unlink` 持续失败时（EACCES/只读文件
  系统）原实现会跳过超时检查，退化成忽略 `timeoutMs` 的忙等待。新增
  回归测试直接对 `node:fs/promises` 共享单例的 `unlink` 打补丁（无需
  `mock.module()`）强制持续失败，断言 `acquireLock()` 仍在 `timeoutMs`
  附近抛出超时错误；已用"临时改回无条件 continue → 测试在
  `--test-timeout=5000` 下真实挂起超时"的反向验证证明测试有效，非
  伪测试。
- **Codex Review 第十八轮修复（P1）**（详见 `specs/1.data-model/tasks.md`
  底部记录）：归档写入改用 `fs.open(..., O_NOFOLLOW)` 代替
  `fs.writeFile()`——第十六轮的符号链接检查只覆盖了 `.superseded`
  **目录**本身，遗漏了目录*里*具体归档文件路径（`{document_id}@v{N}.md`）
  这一层；攻击者预先在这个确切路径放符号链接，`fs.writeFile()` 会
  跟随写入 `experienceRoot` 之外。新增回归测试预先在归档文件确切路径
  放符号链接指向仓库外真实文件，断言写入被拒绝、外部文件内容不变、
  符号链接本身未被移除；已用"临时改回 `fs.writeFile()` → 测试真实
  失败（Missing expected rejection）"反向验证证明测试有效。
- **Codex Review 第十九轮修复（P1）**（详见 `specs/1.data-model/tasks.md`
  底部记录）：内容级围栏检查改为同时比对 `content_hash` **与**
  `occurrence_count`，不能只比 `content_hash`——两次并发的**相同内容**
  提交都走去重路径，只让 `occurrence_count` 各自独立 +1、`content_hash`
  不变；只比 `content_hash` 的围栏检查对这种并发写入完全失明，其中
  一次的计数增量会被无声覆盖丢失且仍报告 `ok: true`。
  `readCurrentContentHash` 重构为 `readCurrentFenceState`（返回
  `{contentHash, occurrenceCount}`），新增 `fenceStatesEqual()`。回归
  测试分两层：`write.test.ts` 直接测试真实（未经 mock.module() 替换）
  的 `fenceStatesEqual`/`readCurrentFenceState`；新建
  `write.duplicate-content-conflict.test.ts` 用 mock 验证 `write.ts`
  的调用方控制流。**踩坑记录**：第一版反向验证只改了 mock 里内联复刻
  的比较逻辑，测试"伪阴性"通过（对真实实现的改动完全免疫）——因为
  `mock.module()` 整体替换导出，测试如果把"正确答案"内联写进 mock，
  就测不到真实实现；必须像 `write.test.ts` 那样对未经替换的真实模块
  直接断言才有效，两层测试互补、缺一不可。
- **Codex Review 第二十轮修复（P1）**（详见 `specs/1.data-model/tasks.md`
  底部记录）：`redact()` 新增带标注名称的密钥/密码赋值检测规则——
  `API_KEY=abc123`/`client_secret=secret`/`password=hunter2` 这类值
  本身低熵、不满足通用高熵启发式，既不匹配已知前缀模式也拦不住，会
  被原样写入，与第十六轮 Cookie 漏洞同一类问题的不同表现。修复：命中
  已知凭据标签（api_key/client_secret/password 等 13 个复合标签）+
  `:`/`=` 赋值语法即 `blocked: true`，不依赖值本身内容；只收录明确
  凭据语义的复合标签，避免误伤"key 的类型定义在 schema.ts 里"这类
  正常散文。新增回归测试 7 条（含 JSON 双引号风格、YAML `:` 分隔风格、
  正常散文不误判的负向用例），已用"临时移除规则→6 项正向用例真实
  失败"反向验证证明测试有效。**实现期发现的小偏差**：第一版正则漏了
  "标签后紧跟一个收尾引号"的情况（`{"api_key": "..."}` 这种 JSON 字段
  名本身带引号），当场发现并补上可选引号 `"?`，design.md 直接记录为
  最终版本。
- **Codex Review 第二十一轮修复（P1）**（详见 `specs/1.data-model/tasks.md`
  底部记录）：`atomic-write.ts` 原子写入的 tmp 路径
  `${targetPath}.tmp-${pid}-${Date.now()}` 修复前可预测，且用
  `fs.writeFile()` 直写会跟随符号链接——若 experience 目录对本机其他
  进程可写，攻击者可预先在这个确切路径放一个指向 `experienceRoot` 之外
  文件的符号链接，写入会截断该外部文件，绕开了 project/archive 路径
  已有的符号链接防护（AC-011/AC-014）。修复：改用 `fs.open(tmpPath,
  O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW)` 排他创建，`O_NOFOLLOW` 让
  `open()` 遇到符号链接时以 `ELOOP` 失败，`O_EXCL` 排除复用已存在
  普通文件；文件名追加 `randomUUID()` 作为纵深防御第二层。
  `fs.rename()` 保持不变——POSIX 语义上它替换目标目录项本身，不会
  跟随符号链接写穿。新建 `atomic-write.test.ts`：用 `mock.module()`
  固定 `node:crypto` 的 `randomUUID()`、用 `mock.timers` 固定
  `Date.now()`，让 tmp 路径完全可预测，从而能预先放置符号链接并
  断言写入被拒绝、外部文件未被覆盖、符号链接未被静默删除（2 项）。
  已用"还原为 `fs.writeFile()` 版本→符号链接逃逸用例真实失败"反向
  验证证明测试有效，`cp`+`diff` 确认逐字节还原修复版代码。
- **Codex Review 第二十二轮修复（P1 + P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. [P1] `write.ts` 两处直接 `fs.readFile(targetPath, ...)` 读取
     `{document_id}.md` 规范路径（判断"是否已存在"的初次读取、以及
     归档步骤复制旧内容的读取）会跟随符号链接——若该路径预先被替换成
     指向 `experienceRoot` 之外的符号链接，会读到外部文件内容并可能
     归档进 `.superseded/`，是 project/archive/tmp 路径之外唯一遗漏
     的符号链接防护层。修复：新增 `readActiveFileNoFollow()`（用
     `O_NOFOLLOW` 在 open 阶段拒绝跟随），`write.ts` 两处读取与
     `readCurrentFenceState()` 内部读取均改用它。新增回归测试：
     `write.test.ts` 一条用例，预先在规范路径放置指向仓库外部文件的
     符号链接，断言拒绝、外部文件未被读取或覆盖、符号链接未被移除
     （1 项）。已反向验证：还原为 `fs.readFile()` 后新测试真实失败
     （读到外部文件内容导致 frontmatter 解析报错，证明确实跟随了
     符号链接）。实现期顺带修复：`write.conflict.test.ts`/
     `write.duplicate-content-conflict.test.ts` 的 `mock.module()`
     缺 `readActiveFileNoFollow` 导出触发 `SyntaxError`（第十九轮同款
     坑），已各自补上真实实现（非打桩，理由与 `fenceStatesEqual`
     一致）。
  2. [P2] `atomicWriteExperience()` 写入/关闭/rename 任一步失败时
     不清理已创建的 tmp 文件，磁盘耗尽等瞬时故障会累积孤儿 `.tmp-*`
     文件。修复：外层 `try/catch` 包住整个写入序列，失败时 `unlink`
     清理（吞掉清理自身的失败，不掩盖原始错误）再重新抛出。新增回归
     测试：`atomic-write.test.ts` 一条用例，直接对 `node:fs/promises`
     共享单例打补丁让 `fs.rename` 抛出已知错误，断言原样抛出、tmp
     文件被清理、目标文件未创建（1 项）。已反向验证：移除清理逻辑后
     新测试真实失败。
  两项修复合计新增 2 项测试，`experience:test` 86→88，`cp`+`diff`
  确认所有反向验证后均逐字节还原了修复版代码。
- **Codex Review 第二十三轮修复（P1 + P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. [P1] 晚期围栏检查通过后、`atomicWriteExperience()` rename 之前
     这段窗口内，若所有权恰好被另一进程回收并重新持有（围栏状态本身
     没变，只是锁的归属变了——内容级围栏检查天生看不出这一点），旧
     实现会直接 rename：两个进程可能各自对着自己刚写入的内容做写入后
     读回校验并都验证成功、都报告 `ok: true`，其中一次的更新被静默
     覆盖丢失，"最终只有一个进程完成写入"这条保证被打破。修复：新增
     第三次 `assertStillHeld()`，紧贴在 rename 之前、晚期围栏检查
     之后，中间不再夹任何其他 I/O，把窗口压缩到"一次 Promise resolve
     到下一次 await 之间"这个量级（纯 POSIX API 无法彻底消灭到零，
     与模块顶部锁获取阶段是同一类理论边界）。新建
     `write.split-brain-rename.test.ts`：用 `mock.module()` 让
     `readCurrentFenceState` 在第二次调用（晚期围栏检查）时作为副作用
     把真实锁文件替换成另一个 token，模拟"另一进程已完成完整陈旧回收
     流程"，断言 `upsertExperience()` 返回 `lock_lost`、
     `atomicWriteExperience` 从未被调用（2 项）。已反向验证：移除新增
     的第三次 `assertStillHeld()` 后新测试真实失败
     （`atomicWriteExperience` 被实际调用）。
  2. [P2] 心跳按路径操作 `fs.utimes(lockPath, ...)`，若本进程的锁已被
     另一进程判定陈旧并回收、同一路径重新创建了接班者的新锁，恢复后的
     心跳会不加区分地刷新"此刻这个路径上无论是谁的锁"的 mtime——误将
     接班者的新锁刷新成"看起来很新鲜"，接班者随后即使真的崩溃，陈旧
     检测也会被这个僵尸心跳永久蒙蔽。修复：`tryCreateFresh()` 改为
     返回打开的 `FileHandle`，心跳改用 `handle.utimes()` 基于这个 fd
     操作——`unlink` 只移除目录项，持有的 fd 仍引用原 inode，天然不会
     影响同一路径新创建的文件。`write.test.ts` 新增一条用例：短
     `heartbeatIntervalMs` 获取锁后，直接操作文件系统模拟接班者已完成
     完整回收流程，断言新锁的 mtime 未被刷新（1 项）。已反向验证：
     心跳改回按路径操作后新测试真实失败（mtime 偏移 600147ms）。
  两项修复合计新增 3 项测试，`experience:test` 88→91，`cp`+`diff`
  确认所有反向验证后均逐字节还原了修复版代码。
- **Codex Review 第二十四轮修复（P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：`tryCreateFresh()` 排他
  创建锁文件成功之后，若写入 token 本身失败（磁盘耗尽/瞬时 I/O 错误
  等），旧实现既不关闭已打开的句柄也不清理磁盘上留下的空 `.lock`
  文件——后续任何进程都会把这份空文件当作"别人持有的活跃锁"，需要等满
  一整个 `staleLockMs`（默认 5 分钟）才能判定陈旧并回收，把一次瞬时
  故障放大成长时间阻塞，还掩盖了真正的失败原因。修复：给
  `handle.writeFile()` 包一层 `try/catch`，失败时依次 `handle.close()`
  、`fs.unlink(lockPath)`（均吞掉清理本身的失败）再重新抛出原始错误。
  新增回归测试：`write.test.ts` 新增一条用例，对共享的 `fs/promises`
  单例的 `fs.open` 打补丁，返回一个包了 `Proxy` 的真实 handle
  （`writeFile` 恒定失败，其余方法 `.bind(target)` 委托给真实
  handle，避免 Node `FileHandle` 私有字段 brand check 报错），断言
  `acquireLock()` 原样抛出错误、锁路径不残留任何文件（1 项）。已反向
  验证：移除清理逻辑后新测试真实失败，且进程输出里出现了 Node 自带的
  "Closing file descriptor ... on garbage collection" 警告，独立佐证
  句柄确实被泄漏。`experience:test` 91→92。
- **Codex Review 第二十五轮修复（P1 + P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：
  1. [P1] `content_hash` 不同的更新走版本递增分支时，
     `{...existing, ...}` 会把旧版本的 `status`（`verified`/
     `deprecated`）原样带到全新内容上，绕开 candidate→verified→
     deprecated 的单向生命周期约束——一份从未审核过的新内容可以直接
     以 `verified` 出现，或者永久卡在 `deprecated` 再也无法被验证。
     修复：版本递增分支的 frontmatter 显式补上
     `status: "candidate"`。新增回归测试：先创建 v1，手工把它的
     status 改写为 `verified`，再提交内容不同的更新，断言新版本
     status 是 `candidate`（1 项）。已反向验证：移除这一行后新测试
     真实失败（`actual: 'verified'`）。
  2. [P2] `experience:test` 只能单独调用，仓库默认 `npm test`
     （`typecheck && agent:test:unit`）从未包含它，依赖默认入口的
     CI/开发流程会对这个新 Feature 的回归视而不见。修复：`test`
     脚本改为 `typecheck && agent:test:unit && experience:test`
     三段链式。验证方式即本轮验证本身：`npm run test` 输出确认
     82/82（agent）+ 93/93（experience）全部通过。
  `experience:test` 92→93，`cp`+`diff` 确认反向验证后逐字节还原了
  修复版代码。
- **Codex Review 第二十六轮修复（P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：早期围栏检查通过后、
  归档源读取真正执行前，若另一个写入者恰好完成了自己完整的一轮更新，
  这里读到的内容已经是对方刚写入的新版本；旧实现不加核实就直接写进
  按本进程自己（此刻已陈旧）的 `archiveOldVersion` 算出的归档路径，
  即使随后的第二次围栏检查发现冲突并报告 `conflict`，历史归档此刻
  已经被污染，无法撤销。修复：读到归档源内容之后、真正写入归档文件
  之前，用这份内容自己解析出一份围栏状态（不需要额外磁盘读取），与
  开始时记录的 `baselineFence` 比较，不一致就直接返回 `conflict`、
  不写入归档文件。新建 `write.archive-source-conflict.test.ts`：用
  `mock.module()` 让归档源读取（第二次调用）返回一份"已被替换"的
  合法内容、早期围栏检查恒定通过，精确复现这个窗口，断言归档文件
  从未被创建、`atomicWriteExperience` 从未被调用（1 项）。已反向
  验证：移除新增的围栏核实后新测试真实失败（`atomicWriteExperience`
  被实际调用）。`experience:test` 93→94。
- **Codex Review 第二十七轮修复（P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：`validateExperience()`
  只检查了 9 个二级标题是否齐全，完全没有校验 F-002 明确要求的一级
  标题（`# 标题`）本身是否存在——没有一级标题、或一级标题前有任意
  无关文字的正文都能通过校验并被持久化，写入结构不合法的经验文档。
  修复：新增私有函数 `hasTopLevelTitle(body)`，检查正文第一条非空行
  是否匹配 `/^#\s+\S/`（`\s+` 紧跟唯一的 `#` 之后天然排除 `##`，不
  需要额外判断层级），不要求标题文字是字面的"标题"二字。新增回归
  测试：`schema.test.ts` 4 条用例（缺一级标题失败、标题前有无关文字
  失败、误写成二级标题失败、自定义标题文字仍通过的负向用例）。已
  反向验证：移除新增校验后前三条真实失败，第四条保持通过，证明精确
  覆盖了这个校验缺口。`experience:test` 94→98。
- **Codex Review 第二十八轮修复（P1）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：归档文件的写入
  （`writeArchiveFile()`）一直用 `O_TRUNC` 原地截断写入，不是原子
  操作——进程崩溃或写入失败会让归档文件残留为空文件或半截内容，可能
  销毁 feature 本该保留的唯一旧版本，违反 F-006"崩溃不得留下半截
  Markdown"。修复：改为 tmp+rename 原子写入，但**不能直接复用
  `atomicWriteExperience()`**——`rename()` 会无条件替换目标目录项
  （包括符号链接本身），违反 AC-014"符号链接本身不得被移除或替换"。
  新增 `assertArchiveTargetNotSymlink()`，在写入 tmp 文件之前与紧贴
  最终 `rename` 之前各调用一次，是符号链接就显式拒绝；tmp 文件本身
  用 `O_EXCL|O_NOFOLLOW` 排他创建。新增回归测试：预置一份"上一次
  尝试遗留"的合法归档内容，对 `fs.rename` 打补丁使其失败，断言预置
  内容完全未被触碰、不残留 tmp 文件（1 项）；已确认既有的 AC-014
  符号链接拒绝测试在新实现下依然通过。已反向验证：还原为 `O_TRUNC`
  版本后新测试真实失败（预置内容被无条件覆盖，印证旧实现毫无原子性/
  失败容错）。`experience:test` 98→99。
- **Codex Review 第二十九轮修复（P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：写入后的读回校验一直用
  会跟随符号链接的 `fs.readFile(targetPath, ...).catch(() => null)`，
  是本模块唯一遗漏 `readActiveFileNoFollow()` 防护的活跃文件读取——
  如果 `atomicWriteExperience()` 的 rename 完成之后、读回校验真正
  执行之前，另一个本机进程把规范路径替换成指向"围栏字段精心构造成
  匹配"的外部伪造文件的符号链接，会跟随符号链接读到伪造内容，字段
  比对全部通过，`upsertExperience()` 因此谎报 `ok: true`，还读到了
  `experienceRoot` 之外的数据；旧的 `.catch(() => null)` 把符号链接
  触发的 `ELOOP` 也吞成"未生效"，看似安全降级，实际掩盖了本该报警的
  异常。修复：改用 `readActiveFileNoFollow()`，去掉吞错误的
  `.catch()`，让符号链接直接抛出。新建 `write.verify-symlink.test.ts`：
  用 `mock.module()` 让 `atomicWriteExperience` 先真实完成写入，再
  立即把规范文件替换成指向围栏字段精确匹配的外部伪造文件的符号链接，
  断言必须直接抛出、不能返回 `ok: true`（1 项）。已反向验证：还原为
  旧读取方式后新测试真实失败（`Missing expected rejection`——静默
  返回了 `ok: true`）。`experience:test` 99→100。
- **Codex Review 第三十轮修复（P2）**（详见
  `specs/1.data-model/tasks.md` 底部记录）：`content_hash` 一直是对
  脱敏后但未归一化的 `redactedBody.text` 求哈希，而
  `serializeExperienceFile()` 落盘时执行的是 `body.trim() + "\n"`——
  两次语义相同、只是前导/尾随空白不同的提交会序列化出字节完全一致的
  文件，却因为哈希基准不一致被误判成"内容变化"，凭空生成不必要的
  新版本和归档。修复：`normalizedBody = redactedBody.text.trim()`
  只算一次，哈希/`validateExperience()`/`serializeExperienceFile()`
  三处统一复用这同一份值。新增回归测试：提交语义相同、仅前导空行/
  多余尾随换行不同的两份正文，断言第二次提交 `document_version` 不
  递增、`occurrence_count` 正确累加、不产生归档（1 项）。已反向验证：
  还原为对未归一化文本求哈希后新测试真实失败
  （`document_version` 变成了 2）。`experience:test` 100→101。
- **Codex Review 第三十一轮修复（P1）——Feature 1 最后一轮**：
  `experienceRoot` 本身是符号链接时未被拦截（`assertWithinRoot()`
  词法比较、`assertNotSymlink(projectDir)` 的 lstat 只护路径最后
  一段，都拦不住），写入实际落到配置根之外。修复：计算 `projectDir`
  之前新增 `assertNotSymlink(candidate.experienceRoot)`，只护配置根
  这一层，不递归查更上层祖先（记录为已知边界）。新增回归测试：
  `experienceRoot` 指向符号链接、指向真实外部目录，断言拒绝、外部
  目录无文件被创建、符号链接未被移除（1 项）。已反向验证。
  `experience:test` 101→102。**Feature 1 至此冻结**——用户已明确
  指示停止对本 Feature 的推测性扩展审查，未确认但曾被考虑的加固点
  记录在 `specs/1.data-model/tasks.md` 底部 "Future Hardening"。
- **实现期对 design.md 的补充修正**（已同步回写 design.md/tasks.md，
  详见 `specs/1.data-model/tasks.md` 底部"完成记录"）：
  1. `atomicWriteExperience` 拆到独立文件（可测试性需要）。
  2. `acquireLock()` 补上 `opts.staleLockMs`/`opts.heartbeatIntervalMs`
     + 环境变量覆盖（tasks.md 早已要求，design.md 代码片段之前遗漏）。
  3. `redact()` 远程主机规则收紧（TLD 白名单/子域名 vs 常见代码文件
     扩展名），避免把"schema.ts"这类文件名整篇误判成远程主机。
- **其余未触碰**：`.gitignore` 新增两行（`knowledge/experience/**/*.lock`
  与 `*.tmp-*`），`mastra-agent/package.json` 新增 `experience:test`
  脚本。均未 commit。

## Feature 2: store-retrieval — 已完成（2026-08-01）

按 `workflow-experience/specs/2.store-retrieval/tasks.md` 的 T-001~T-008
实现：`loadExperienceConfig()` → `ExperienceStore`（含第十轮 Codex
Review 修正后的 MongoDB 风格 filter）→ 摄取管线（`ingest-pipeline.ts`）
→ 写入摄取集成点（`write-and-ingest.ts`）→ 检索管线（`retrieve.ts`，
含第十一轮 Codex Review 要求的"按 document_id 去重聚合 + 文档级组装"
两步，以及 `scopeMode` 字段）→ `formatForInjection()`。

**Codex Review 收敛规则（用户 2026-08-01 更新，适用于 Feature 2 起的
所有 Feature）**：单个 Feature 最多主动跑 3 轮 Codex Review；P0/P1 且
可由当前验收标准证明 → 必须修复；P2 → 只修复明确可复现、影响当前
功能的问题；推测性极端场景/理论竞态/规格外增强 → 记录到对应 Feature
`tasks.md` 底部 "Future Hardening"，不阻塞推进下一个 Feature。**不
`git add`/`commit`/`push`**，除非用户后续再次明确授权。

- **实现文件**：`mastra-agent/src/experience/`
  - `config.ts` — `loadExperienceConfig()`，复用 `rag/config.ts`，
    独立 `collection`/`knowledgeSet`/`knowledgeRoot`（`.env.example`
    已补充 `EXPERIENCE_QDRANT_COLLECTION`/`EXPERIENCE_KNOWLEDGE_SET`/
    `EXPERIENCE_KNOWLEDGE_ROOT` 三个环境变量），`qdrantUrl`/
    `embeddingBaseUrl`/`embeddingModel` 与客服知识库共享基础设施配置。
  - `store.ts` — `ExperienceStore`（对齐 `KnowledgeStore` 接口但独立
    实现，独立 Mastra vector id）；过滤条件构造独立成纯函数
    `buildExperienceFilter()`，不依赖真实 Qdrant 即可单元测试。
  - `ingest-pipeline.ts` — `chunkExperienceDocument()`（按 9 个固定
    二级标题整节切块，chunk id 用 `documentId#section` 哈希、不含
    `document_version`，新版本摄取自然覆盖旧版本向量）+
    `ingestExperience()`。
  - `write-and-ingest.ts` — `writeExperienceAndIngest()`：串联
    Feature 1 `upsertExperience()` → 读回解析 → `ingestExperience()`，
    摄取失败不回滚 Markdown，只返回 `ingestWarning`（**未修改
    Feature 1 的 write.ts**，`ParsedExperienceDocument` 由读回解析
    构造）。
  - `retrieve.ts` — `retrieveExperience()`：脱敏→embedding→向量召回
    （metadata 过滤下推同一次请求）→按 document_id 去重聚合→读取
    候选源文件分节内容（一次读取同时供 Rerank 输入与文档组装复用）→
    Rerank/降级分支→跨小节文档组装成 `RetrievedLesson`。
  - `format.ts` — `formatForInjection()`：按 relevanceScore 排序，
    超预算时整条丢弃低分条目（最高分那条即使单独超预算也完整保留，
    不返回空结果）。
- **测试**：`config.test.ts`（5）/`store.test.ts`（6）/
  `ingest-pipeline.test.ts`（9）/`write-and-ingest.test.ts`（4）/
  `retrieve.test.ts`（11，覆盖 AC-003/004/006/006b/007/008）/
  `format.test.ts`（5，覆盖 AC-005）——`npm run experience:test`
  **142/142 通过**，`npm run test`（typecheck + agent:test:unit +
  experience:test）**82/82 + 142/142 全部通过**。
- **真实服务端到端冒烟**：新建
  `mastra-agent/src/experience/live/store-retrieval.live.test.ts` +
  `npm run experience:test:live`（独立 glob 路径，不在默认
  `experience:test`/`npm test` 范围内，与 `rag/rerank.test.ts`
  "需要真实服务在线"的既有惯例一致，避免服务未启动的环境里默认测试链
  不可预测失败）——用独立临时 Qdrant Collection（测试后
  `deleteIndex()` 清理）跑通"写入→摄取→检索"完整闭环，并验证
  `customer_service_knowledge` 点数量全程不变（AC-001）。**已针对
  本机在线的真实 Qdrant/Ollama(bge-m3)/Reranker 服务实际运行通过
  （2/2）**，不是仅有 mock 覆盖。
- **已知的规格外事项（记录不阻塞，见 tasks.md 无 Future Hardening
  小节——Feature 2 本轮 3 轮 Review 预算内未触发需要记录的推测性
  finding）**：Qdrant filter 的类型断言（`@mastra/qdrant` 的
  `QdrantVectorFilter` 只接受内联字面量做类型收窄，动态构造的 filter
  在 `store.ts` 的 `query()` 调用处做了一次有注释说明的类型断言，
  运行期形状与 `rag/store.ts` 现有用法一致）。

## Feature 3: cli-commands — 已完成（2026-08-01）

按 `workflow-experience/specs/3.cli-commands/tasks.md` 的 T-001~T-008
实现 7 个稳定 CLI 命令（`experience:ingest`/`rebuild`/`search`/
`status`/`audit`/`finalize`/`test`），每条命令都拆成"核心逻辑
（`src/experience/*.ts`，可单测）+ 薄 CLI 封装
（`mastra-agent/scripts/experience-*.ts`，只做参数解析和打印）"两层。

- **实现文件**：
  - `src/experience/bulk-ingest.ts` — `runBulkIngest()`：扫描
    `knowledgeRoot` 下全部经验、逐个校验+摄取，`--rebuild` 先
    `deleteIndex()`，collection 已存在时不重复 `createIndex()`。
  - `src/experience/scan.ts` — `scanExperienceFiles()`：递归扫描
    共用逻辑（跳过 `.superseded` 归档目录），供 `status`/`audit`/
    `bulk-ingest` 三处复用，避免各自实现一遍目录遍历。
  - `src/experience/status.ts` — `getExperienceStatus()`：三项服务
    连通性并发探测（任一失败只标注"离线"，命令不失败）+ 按 status
    分组的**文档数**统计（不是向量点数，每文档 9 个 chunk 直接数点
    会放大 9 倍）；`createEmbeddingClient` 通过可注入参数解耦，单测
    不依赖真实 Embedding 服务。
  - `src/experience/audit.ts` — `auditExperience()`：frontmatter
    校验 + 脱敏扫描（整份文件先判定"是否命中"，命中后逐行定位行号，
    跨行专属规则命中但逐行定位不到时标注 `fileLevel: true`，报告
    只含行号不含原文，AC-006）+ 孤儿文件/悬空向量点比对，只读不改。
  - `src/experience/finalize.ts` — `finalizeCandidates()`：严格按
    design.md 的加锁范围——复用 Feature 1 `acquireLock`/
    `lockPathFor`/`LockLostError`（同一把锁），"读取现状→
    `canVerify()`→`transitionIdempotent()`→`assertStillHeld()`→
    原子写回→payload 更新"全程在同一次持锁区间内完成，不是只锁最后
    写入那一步（避免基于过期状态做出错误晋升判断）。
  - `src/experience/store.ts`（Feature 2 文件，本轮追加）新增
    `updatePayload()`（Qdrant 原生 REST 的 `points/payload` 局部
    更新，status 变化不重新 embedding）。
  - `src/experience/ingest-pipeline.ts`（Feature 2 文件，本轮追加）
    导出 `stableChunkId()`，供 finalize 免查询直接算出目标点 ID。
  - `mastra-agent/scripts/experience-{ingest,search,status,audit,
    finalize}.ts` — 薄 CLI 封装；`mastra-agent/tsconfig.json` 补充
    `scripts/**/*.ts` 到 `include`（否则 `npm run typecheck` 完全
    跳过这些脚本，是本轮发现并修复的一个真实检查盲区）。
- **测试**：`bulk-ingest.test.ts`（6）/`scan.test.ts`（5）/
  `status.test.ts`（5）/`audit.test.ts`（7，含 AC-006）/
  `finalize.test.ts`（10，含 AC-004/AC-005）/`portability.test.ts`
  （4，含 AC-001/AC-002/AC-003）——`npm run experience:test`
  **179/179 通过**，`npm run test`（typecheck + agent:test:unit +
  experience:test）**82/82 + 179/179 全部通过**。
- **真实服务端到端手工冒烟**（独立临时 collection + 临时
  knowledgeRoot，测试后清理，全程未污染任何生产数据）：
  `ingest`（1 文档→9 向量点）→`status`（candidate=1）→`audit`
  （0 异常）→`search`（0 条，正确排除 candidate）→`finalize`
  （ALLOW→晋升 verified，Markdown `status` 字段与 Qdrant payload
  均正确更新）→`search`（1 条，正确召回刚晋升的 verified 经验）→
  `status`（verified=1）。**针对本机在线的真实 Qdrant/Ollama(bge-m3)/
  Reranker 服务实际运行验证，不是仅有 mock/fake 覆盖**，事后
  `DELETE /collections/{临时collection}` + 删除临时目录，确认清理
  干净。

## Feature 4: quality-gates — 已完成（2026-08-01）

按 `workflow-experience/specs/4.quality-gates/tasks.md` 的 T-001~T-006
实现——本 feature 不新增业务代码，只新增测试文件，把用户要求的 22 项
质量/安全测试逐一落地：编号 1-15、18/19/21 已被 Feature 1/2/3 的 AC
覆盖（`quality-gates.test.ts` 的 `CHECKLIST_MAPPING` 只做对照引用，
不重复实现，避免同一逻辑两处维护漂移）；编号 16/17/20/22 是本 feature
新增的跨模块/边界测试。

- **实现文件**（全部是测试文件，`src/experience/`）：
  - `quality-gates.test.ts` — 22 项清单对照表（`CHECKLIST_MAPPING`
    数组 + 自检断言，不是纯注释）。
  - `quality-gates.hook-concurrency.test.ts` — 并发 finalize 真实用
    `Promise.all()` 触发两次独立调用（不同候选互不阻塞；相同候选
    锁串行化，结果集合恰好是 `["already_verified", "promoted"]`，
    验证 5 次重复运行结果稳定）。
  - `quality-gates.timeout.test.ts` — Node 内置 `http.createServer`
    构造挂起服务，验证 Reranker 的 `AbortSignal.timeout()` 机制真实
    生效（200ms 超时配置，真实耗时落在 [150ms, 2000ms) 区间，远小于
    服务实际 5000ms 响应时间）；`rag/embedding.ts` 的 120s 硬编码
    超时常量不可配置、无法在不等 2 分钟的前提下验证，记录为经权衡
    收窄的范围（已实测确认 `mock.timers` 不影响
    `AbortSignal.timeout()`，两处是同一机制，代码走查确认调用方式
    一致）。
  - `quality-gates.agents-md.test.ts` — 仓库根目录路径向上解析得到
    （不硬编码），跑一次真实摄取+finalize 全流程前后对 `AGENTS.md`
    拍哈希快照，断言不变（本仓库当前该文件不存在，两次快照都是
    `null`，验证的是更宽的"存在性+内容都不变"）。
  - `quality-gates.no-config.test.ts` — 保留端口
    `127.0.0.1:1`（连接立即拒绝）模拟全新项目未配置基础设施，验证
    `getExperienceStatus()` 优雅标注离线、不抛异常、不拖累无关的
    并发 Promise。
- **测试**：`npm run experience:test` **188/188 通过**，`npm run
  test`（typecheck + agent:test:unit + experience:test）**82/82 +
  188/188 全部通过**。
- **AC-001 已做实测验证（不是理论推断）**：把
  `QDRANT_URL`/`EMBEDDING_BASE_URL`/`RERANK_BASE_URL` 全部显式覆盖成
  不可达地址后重跑 `experience:test`，**188/188 仍然全部通过**，
  证明整套纯逻辑测试（不含 `experience:test:live`）真的不需要任何
  真实服务在线、完全断网也能跑通。
- **T-006 无需新增工作**：`experience:test:live` 已在 Feature 2 建立，
  本 feature 的四类新增测试按设计有意全部不依赖真实服务，没有新文件
  需要放进 `live/` 目录。

## Feature 5: workflow-integration — 已完成（2026-08-01）

按 `workflow-experience/specs/5.workflow-integration/tasks.md` 的
T-001~T-005 实现——文档 + 只读候选规则生成器，**不修改任何
`~/.claude/**` 文件**（`PLAN.md`"开放问题"一节已记录这是先前 spec
阶段就确认的架构决策："N1-N8 集成是否修改全局 `~/.claude/commands/**`？
→ 本轮按推荐方案不修改，仅本仓库提供 CLI + 文档"）。

**实现期的一次自我纠正**：开始本 Feature 前，我曾以"Feature 5 需要
修改 `~/.claude` 全局工作流文件"为前提向用户确认是否继续（用户选择了
"继续，按原指示的边界执行"）。随后重新读取本仓库实际的
`requirements.md`/`design.md`/`PLAN.md` 发现这个前提是错的——是基于
本会话更早、已被压缩摘要的上下文里一个更早期、更激进的 Feature 5
草案设想，与当前磁盘上实际生效的规格不符。已向用户当面说明这个偏差
并按磁盘上真实的规格（文档 + 只读生成器，不碰 `~/.claude`）实施，
用户未再提出异议。

- **实现文件**：
  - `mastra-agent/README-EXPERIENCE.md`（新增，约 200 行）——READ/WRITE
    文字架构图、Collection 对照表（`customer_service_knowledge` vs
    `claude-workflow-experience` 物理隔离）、全部 `experience:*` 命令
    一览 + `FinalizeInput` JSON 示例、N1-N8 逐节点建议接入点（N1 可选、
    N2/N3 执行态检索、N4 评审态检索、N5 只生成候选、N6 QA 证据时机、
    N8 finalize 门禁在 ALLOW 后触发）、边界声明（不修改 `AGENTS.md`/
    `~/.claude/**`，引用 Feature 4 的离线可运行实证结论）。
  - `.claude/CLAUDE.md` — 追加 3 行引用 README-EXPERIENCE.md，`git
    diff` 确认为纯新增，未改动任何既有行。
  - `mastra-agent/src/experience/suggest-rules.ts`（新增）——
    `buildSuggestions()` 过滤 `status=verified &&
    occurrence_count>=阈值`（默认 3，`EXPERIENCE_RULE_THRESHOLD` 可
    覆盖）；候选文本（触发场景+正确处理+适用范围三节）再跑一次防御性
    `redact()`，命中 `blocked` 时整条跳过、只留 `document_id`+原因、
    不回显原文；`renderReport()` 生成 Markdown；`runSuggestRules()`
    经 `atomicWriteExperience()`（复用 Feature 1 的原子写入原语，不是
    新写一套）原子写入 `workflow-experience/suggested-rules/
    YYYY-MM-DD.md`——刻意放在 `knowledge/experience/` 摄取根目录
    **之外**，不会被 `experience:ingest`/`rebuild`/`audit` 误扫描。
  - `mastra-agent/scripts/experience-suggest-rules.ts`（新增）——薄
    CLI 封装，已实跑通过：对本仓库当前空知识库运行输出"候选规则：0
    条，跳过：0 条"，报告文件正常生成，未抛异常。
  - `mastra-agent/package.json` — 新增 `experience:suggest-rules`
    脚本。
- **测试**：`suggest-rules.test.ts`（新增 7 项）——阈值过滤 3 项（含
  `>=` 边界值）、blocked 内容排除 1 项（断言报告文本不含原始 Token
  片段）、端到端 3 项（报告内容正确性、AGENTS.md 内容哈希前后不变、
  报告目录不污染 `scanExperienceFiles()` 扫描结果、候选数为 0 时不
  抛异常）——`npm run experience:test` **195/195 通过**（较 Feature 4
  完成时的 188 增加 7），`npm run test`（typecheck + agent:test:unit
  + experience:test）**82/82 + 195/195 全部通过**。
- **Codex Review 第一轮修复（P1 + P2）**（详见
  `specs/5.workflow-integration/tasks.md` 底部记录）：
  1. [P1] `config.ts` 的 `knowledgeRoot` 默认值是相对路径，按文档化的
     `npm run experience:*` 用法（cwd=`mastra-agent/`）会解析成
     `mastra-agent/knowledge/experience`，不是仓库根
     `knowledge/experience`。修复：仿照 `rag/ingest.ts` 用
     `import.meta.url` 锚定仓库根的既有模式，`knowledgeRoot` 一律
     `path.resolve(REPO_ROOT, ...)` 解析成绝对路径。已用真实 CLI
     重跑 `experience:suggest-rules`/`experience:status` 验证解析到
     仓库根下的 `knowledge/experience/`。
  2. [P2] `finalize.ts` 的 `already_verified` 幂等分支直接返回，从不
     重新协调向量 payload——若上一次 finalize 是"Markdown 写入成功、
     `updatePayload()` 因 Qdrant 瞬时不可用而失败"这种中途失败，向量
     会永久停留在旧 status、被检索排除，且重试也无法自愈。修复：
     `already_verified` 分支返回前也执行一次幂等的 `updatePayload()`，
     失败时和"晋升"分支一样直接抛出。
  `experience:test` 195/195（测试数量不变，只是更新了两处受影响的
  既有断言以匹配新行为），`npm run test` 82/82 + 195/195，均无回归。

### T-006: 真实接入 ~/.claude 全局 yd 工作流（2026-08-01，用户明确授权扩大范围）

详见 `specs/5.workflow-integration/tasks.md` T-006 完整记录，摘要：

- 时间戳备份 `~/.claude/backups/experience-integration-20260801-1507/`
  （改前 diff 逐字节确认一致）。
- 新增 CLI `experience:write`（`scripts/experience-write.ts` +
  `src/experience/write-and-ingest.ts` 的 `writeExperienceWithFallback()`，
  Embedding 探测失败时仍完成 Markdown 写入，只跳过向量摄取）——
  `write-and-ingest.test.ts` 新增 3 项，`experience:test` **195→198**。
- `~/.claude/commands/{yd-ai-nodes/N2-enter-feature.md,
  yd-ai-nodes/N5-mark-done.md, yd-ai-nodes/N8-finish.md, yd:prd.md}`
  各新增一个纯增量小节（N2 读端检索、N5 写端候选、N8 finalize 晋升、
  prd Step 8 检索），统一走 `YD_EXPERIENCE_REPO` 环境变量间接引用仓库
  路径（未设置或命令失败 → 静默跳过，原工作流表现与接入前一致）。
- 改动后的 4 个文件复制进本仓库 `workflow-experience/yd-integration/`
  （含 README 说明安装步骤，`grep` 确认不含机器相关绝对路径）。
- 端到端 dry-run（真实在线 Qdrant/Ollama/Reranker）走通
  search→write→rebuild→search→finalize→search 全链路，**过程中发现并
  修复了 N5/N8 节点文件里两处会导致未来真实运行失败的 bug**（正文缺
  一级标题、`<(...)` 进程替换在 `npm run` 转发下不可靠），dry-run 测试
  数据已清理，`experience:status` 确认恢复到 `candidate=0 verified=0
  deprecated=0` 的空状态。
- 全程未 `git add`/`commit`/`push`，冻结路径无改动，停在 Review 点等待
  用户确认。

### T-007: Codex Review 第一轮修复 + /yd:init 接入 + 降级提示统一（2026-08-01）

详见 `specs/5.workflow-integration/tasks.md` T-007 完整记录，摘要：

- **Codex Review 3 项 finding 修复**（均为真实 bug，非误报）：
  1. [P1] N8 finalize 失败时仍无条件删除待处理候选清单，导致候选引用
     永久丢失——改为只在 finalize 退出码为 0 时才删除。
  2. [P1] finalize 对不存在的向量点调用 `updatePayload()` 会被 Qdrant
     静默忽略，导致"晋升成功"但实际搜不到——`store.ts` 新增
     `pointsExist()`，`finalize.ts` 新增 `vectors_missing` 结果，缺失时
     不写 Markdown、不更新 payload。
  3. [P2] finalize CLI 只在"批次全是 not_found"时才失败退出，混合批次
     （部分有效+部分 not_found）会误判成功——改为只要有任意未决态
     （not_found/lock_lost/vectors_missing）就非零退出。
  - `experience:test` **195→200**，`npm run test` 82/82 + 200/200。
- **新增范围**（用户明确指示）：`/yd:init` 新增技术栈相关经验检索
  （`stage=execute`、`project-scope=global`）；N2/N5/N8/`yd:prd`/`yd:init`
  五处的"静默跳过"统一为单次固定降级提示（不含机器路径/端口/堆栈/
  环境变量值/原始报错），"成功但召回为空"/"N8 无候选"这类正常情况
  仍不提示，避免噪音。
- **dry-run 验证**：`/yd:init` 检索命令跑通；gating 逻辑（未设置/路径
  错误）正确提示；**vectors_missing 回归**——不可达 Embedding 写入
  候选→真实 Qdrant finalize→输出"向量点缺失：1"、真实退出码 1（非管道
  伪造值）、Markdown 确认仍是 candidate；`experience:rebuild` 恢复后
  重跑 finalize 成功晋升；混合批次（有效+not_found）退出码确认为 1。
  测试数据已清理，`experience:status` 确认空状态。
- 模板同步（`workflow-experience/yd-integration/`）新增 `yd:init.md`，
  README 更新设计要点+回滚说明+Review 策略。
- 未 `git add`/`commit`/`push`，停在 Review 点。

### T-008: bulk-ingest.ts 最后一次定向修复（2026-08-01，Codex Review 收敛）

详见 `specs/5.workflow-integration/tasks.md` T-008 完整记录，摘要：

- **[P1] 增量 `experience:ingest` 不清理孤儿向量点**——文档删除/校验
  失败后旧向量（可能是 `verified`）原样保留，仍可被检索到。修复：
  扫描时收集结构校验通过的 `document_id` 集合，摄取完成后（仅非
  `--rebuild` 路径）用 `store.listPoints({knowledgeSet})` 核对现存点，
  不在集合内的即为孤儿，`store.deletePoints()` 清理。`deprecated` 但
  内容仍合法的文档不受影响（照常 upsert 覆盖 payload，不是孤儿）。
- **[P1] `--rebuild` 的 `deleteIndex().catch(() => {})` 吞掉真实删除
  失败**——底层 `@mastra/qdrant` 已正确区分"不存在"与"真实失败"，多包
  的一层 catch 把真实失败也吞了。修复：去掉这层 catch，真实失败原样
  抛出、中止摄取，不假装 rebuild 成功。
- `bulk-ingest.test.ts` 新增 9 项回归测试；`experience:test`
  **200→209**，`npm run test` 82/82 + 209/209，`git diff --check` 干净。
- **端到端 dry-run**：写入两份 verified 候选 → 删除其中一份的 Markdown
  文件 → `experience:ingest`（增量）输出"清理孤儿向量点：9 个" →
  检索确认该文档不再可命中、另一份不受影响 → 交叉核对
  `customer_service_knowledge` collection 点数全程不变（46，未被
  误伤）。测试数据已清理，恢复空状态。
- 这是本 task 的最后一次定向修复（Stop Hook Review 轮次已达上限，用户
  明确指示不再继续），未 `git add`/`commit`/`push`。

## 已知未决事项

- **5 个 Feature 全部完成**：data-model（102/102，冻结）→
  store-retrieval（142/142 + 2/2 live）→ cli-commands（179/179 + 真实
  全链路冒烟）→ quality-gates（188/188，离线可运行已实测）→
  workflow-integration（195/195）。`npm run experience:test`
  195/195、`npm run test` 82/82 + 195/195 全部通过，无回归，冻结路径
  （`services/**`/`datasets/**`/`training/**`/`configs/**`/
  `knowledge/**`/`models/**`）与 `~/.claude/**` 全程未被触碰。
- 若额度中途耗尽，恢复时请先读本文件 + 对应 Feature 的 `tasks.md`
  （已完成项已打勾），不要重新实现已完成的 Feature。
- **全部 5 个 Feature 已完成、测试通过**，按既有约定需要用户明确指示
  才能 commit；commit 时按精确文件清单显式 `git add`，不用
  `git add -A`。当前尚未收到该指示，未执行任何 `git add`/`commit`/
  `push`。
