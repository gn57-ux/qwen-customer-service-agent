# Feature 1: data-model — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |

## 项目架构

- 架构类型: monorepo 内新增子模块
- 涉及层: 纯后端数据层（Node.js/TypeScript），无前端、无网络服务

## 遵循的现有规范

- `mastra-agent` 使用 `node:test` 原生断言，不引入 Jest/Mocha（见
  `.claude/CLAUDE.md` 测试约定）——本 feature 测试同样用 `node:test`。
- `.ts` 相对导入必须带显式扩展名（`.claude/rules/coding-style.md`）。
- 注释只写"为什么"，不复述代码在做什么。
- 复用 `mastra-agent/src/rag/markdown.ts` 的 frontmatter 解析思路（简化
  YAML 标量解析，不引入 `js-yaml` 等新依赖）——`REQUIRED_FRONTMATTER` 的
  7 个字段与本 feature 的字段高度重合，解析器可以共享，但**不修改
  `rag/markdown.ts` 本身**（避免影响客服知识库摄取），改为在
  `experience/schema.ts` 里复用其内部解析函数或复制精简版（若 `rag/
  markdown.ts` 未导出可复用的解析函数，则在 `experience/` 内独立实现一份
  更简单的版本，因为经验文档不需要 Markdown-aware 分块，只需要 frontmatter
  + 固定结构正文）。

## 功能模块设计

### 模块 1: frontmatter schema 与校验（`mastra-agent/src/experience/schema.ts`）

```ts
export interface ExperienceFrontmatter {
  document_id: string;
  document_version: number;
  title: string;
  domain: "workflow-experience";
  stage: "execute" | "review" | "qa" | "finish";
  task_type: "frontend" | "backend" | "rag" | "model" | "data" | "git" | "docs" | "workflow";
  project_scope: string; // 项目名或 "global"
  source: string;        // 来源描述（如 "yd:ai N5" ），不含具体文件绝对路径
  created_at: string;    // ISO 8601
  updated_at: string;    // ISO 8601
  risk_level: "low" | "medium" | "high";
  status: "candidate" | "verified" | "deprecated";
  occurrence_count: number;
  content_hash: string;  // 正文（脱敏后）的稳定哈希
  supersedes?: string;   // 被取代的具体版本，格式 "{document_id}@v{N}"
                          // —— 不能只存 document_id：同一经验的所有版本
                          // 共享同一个 document_id（这是 occurrence_count
                          // 累加机制的前提），裸 document_id 会构成自引用，
                          // 无法定位到具体某个历史版本。
}

export const REQUIRED_SECTIONS = [
  "触发场景", "问题表现", "错误做法", "根因",
  "正确处理", "验证方法", "适用范围", "不适用范围",
  "可提升为稳定规则的条件",
] as const;
```

`document_id` 生成：`sha256(project_scope + "|" + task_type + "|" + stage +
"|" + 标题脱敏归一化文本).slice(0, 16)`——不含时间戳，保证"同一场景重复
提交"能算出相同 ID，天然支持 F-005 的去重判定，不需要额外的相似度检索
就能命中"完全相同场景"的 case（语义近似但非完全相同的去重，属于 Feature 2
检索侧的职责，本 feature 只处理"精确同 ID"这一档）。

校验函数 `validateExperience(frontmatter, body): ValidationResult`——检查
14 个字段类型/枚举合法性 + 9 个必需二级标题是否存在，返回
`{ ok: true }` 或 `{ ok: false, errors: string[] }`，不抛异常（调用方决定
如何处理）。

`validateExperience()` 内部必须先把正文按 9 个固定二级标题切分成
`{ 节名 → 节正文 }` 的映射才能判断"是否缺节"，这一步单独导出为
`parseExperienceSections(body: string): Map<string, string>`（不在
`validateExperience()` 内部私有实现——Codex Review 第十一轮指出：
Feature 2 的检索管线组装 `RetrievedLesson` 时同样需要从完整正文里
取出"问题表现/根因/正确处理/验证方法"四节内容，若不导出会被迫在
`experience/retrieve.ts` 里重新实现一套 9 节解析逻辑，两处解析器
后续可能出现"标题匹配规则漂移"的不一致；缺失的节在返回的 Map 里
直接不存在该 key，不返回空字符串，方便调用方区分"节存在但为空"与
"节缺失"）。

### 模块 2: 脱敏（`mastra-agent/src/experience/redact.ts`）

```ts
export interface RedactResult {
  text: string;         // 脱敏后文本
  redactedCount: number;
  blocked: boolean;     // true 表示命中不可安全脱敏的内容，应拒绝写入
}
export function redact(text: string): RedactResult;
```

规则（正则白名单，宁可误拦）：
- 绝对用户目录：`/Users/[^/\s]+` → 替换为 `/Users/<redacted>`（不整体拒绝，
  因为路径脱敏后文本仍可读、仍有参考价值）。
- Token/Key/Cookie：常见模式（`sk-[A-Za-z0-9]{20,}`、`Bearer [A-Za-z0-9._-]+`、
  `AKIA[0-9A-Z]{16}` 等已知前缀 + 通用"看起来像密钥的高熵字符串"启发式）
  → 命中即 `blocked: true`，不允许写入含密钥的经验（密钥没有"脱敏后仍有
  参考价值"的情况，直接拒绝比替换更安全）。
- 邮箱：`[\w.+-]+@[\w-]+\.[\w.-]+` → 替换为 `<email-redacted>`。
- 私有/内网 IP：`10\.\d+\.\d+\.\d+`、`192\.168\.\d+\.\d+`、`172\.(1[6-9]|2\d|3[01])\.\d+\.\d+`
  → 替换为 `<internal-ip-redacted>`（`127.0.0.1`/`localhost` 不拦截——这是
  本项目所有服务的标准回环地址，出现在经验里是正常的工程描述，不是泄露）。
- 用户名：从 `os.userInfo().username` 取当前用户名做字面匹配替换（只能
  拦截"当前运行环境的用户名"，无法穷举所有可能用户名，作为补充手段，
  不是唯一防线——主防线是"经验内容本来就该是脱敏后的工程描述"这一
  写作约束，由 Feature 3 的 `experience:ingest` 在生成候选经验时就应
  优先描述"做法"而非"环境细节"）。

**以下三类是 Codex Review 指出 F-004 明确要求但初版设计遗漏的类别，
补充具体规则（而不是留空指望"写作约束"兜底——那是用户名一类已经承认
"补充手段"的例外，其余类别必须有实际检测规则）**：

- 账号/组织信息：
  - Git 远程地址风格 URL（`git@[host]:[org]/[repo]`、
    `https?://[host]/[org]/[repo]`，`host` 匹配已知代码托管域名如
    `github.com`/`gitlab.com`/`bitbucket.org` 及其自建实例常见前缀
    `git\.`/`code\.`）→ 命中即把 `[org]/[repo]` 段替换为
    `<org-redacted>/<repo-redacted>`（地址结构本身可能是正常的工程
    描述，但组织/仓库名属于账号身份信息，需要单独脱敏，不因为在
    URL 里就整体豁免）。
  - 社交/协作平台 handle：`@[A-Za-z0-9_-]{2,39}\b`（Slack/GitHub/
    Twitter 风格 handle 前缀）→ 替换为 `<handle-redacted>`——**已知
    误伤风险**：技术文档里 `@decorator`（Python 装饰器）、`npm` scope
    包名 `@scope/pkg` 也会命中；本规则允许误伤（宁可误拦），但需要在
    `experience:audit` 报告里把这类命中单独标注"可能是误报，人工确认"，
    不是静默拒绝写入。
- 远程主机（非本机服务地址）：`\b[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?
  (\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?){1,}(:[0-9]{2,5})?\b`
  （FQDN 风格主机名，可带端口）→ 排除白名单（`localhost`、
  `127\.0\.0\.1`、本项目文档里合法出现的公共服务域名如
  `fonts\.googleapis\.com`、`github\.com` 本身不需要脱敏——**脱敏的是
  "内部/私有服务地址"这个语义，不是"任何域名"**，白名单需要显式维护
  一个"已知公共/文档合法域名"列表，避免把项目自己写的技术文档变得
  不可读）→ 命中且不在白名单 → 替换为 `<remote-host-redacted>`。
- 原始聊天内容片段：检测"连续 3 行以上，每行以已知对话角色前缀开头"
  （`^(User|Assistant|Human|AI|Claude|用户|助手)[:：]`，忽略行首空白）
  → **直接 `blocked: true`，不尝试脱敏后保留**——聊天记录的价值信息
  密度低、且脱敏后残留的对话结构本身仍可能暴露交互细节，此类内容应该
  被提炼成经验的"问题表现/正确处理"等结构化字段，而不是整段保留原文，
  与"密钥类内容直接拒绝"是同一处理原则。

### 模块 3: 原子写入 + 并发锁（`mastra-agent/src/experience/write.ts`）

```ts
export async function atomicWriteExperience(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath); // 同文件系统内 rename 是原子操作
}
```

并发锁：用 `proper-lockfile` 这类第三方库会引入新依赖，本项目倾向"能用
标准库就不加依赖"（见 coding-style 的一贯风格）——改用 **基于
`fs.open(path, "wx")`（排他创建）的自制文件锁**：

**`acquireLock()` 与锁路径计算函数必须导出**（不是模块内部私有函数）
——Feature 3 的 `experience:finalize` 需要复用这**同一把锁**（而不是
另开一把独立的 finalize 专用锁），才能保证"内容更新/生命周期变更/
finalize"三类操作互斥，避免竞态覆盖（见 Feature 3 design.md 的 Codex
Review 修正记录）：

**第三、四轮 Codex Review 揭示的根本问题**：第三轮指出"先 `stat` 判断
陈旧、后 `unlink`"是非原子的 TOCTOU 组合；改成"用 `fs.rename()` 把
陈旧锁移走"后，第四轮又指出——如果检测到"移走的不是真陈旧锁"需要
**归还**（把墓碑文件 rename 回 `lockPath`），这个归还操作本身又是一次
**无条件覆盖式 rename**，如果归还发生前，第三个进程已经在空出来的
`lockPath` 上创建了一把全新的合法锁，归还操作会把它也覆盖掉。

**结论：纯 POSIX 文件 API 无法让"获取锁"这一步本身做到完全无竞态的
compare-and-swap**——每一种"先检测陈旧、再抢占"的方案，理论上都能构造
出"抢占动作执行前，目标已被第三方合法重新占用"的时序。业界对这类问题
的标准解法不是继续在"获取锁"这一步死磕完美无竞态，而是**把真正的互斥
保证从"谁能拿到锁"移到"谁能被允许提交最终写入"**——也就是乐观并发
控制：允许极小概率的"获取阶段短暂多方持有"，但要求任何一方在真正落盘
写入之前，必须重新校验自己的所有权凭证仍然有效，一旦失效立即中止，
不写入任何数据。这样无论获取锁阶段发生怎样的竞态，**最终只会有一个
进程真正完成写入**，其余进程要么在等待队列里正常排队，要么在提交前
的校验中发现自己"已被取代"而安全中止（调用方可以选择重新走一遍完整
的 `acquireLock → ... → commit` 流程重试，不是数据错误，是可恢复的
"本次尝试失败，重试即可"）：

```ts
export function lockPathFor(documentId: string, experienceDir: string): string {
  return path.join(experienceDir, `${documentId}.lock`);
}

const STALE_LOCK_MS = 5 * 60 * 1000; // 5 分钟——超过这个时长视为持有者已崩溃
// 心跳间隔远小于陈旧阈值（1/5，60s vs 5min）——第五轮 Codex Review 指出：
// assertStillHeld() 只是在"落盘前那一刻"查一次，如果持有者在算好最终
// 内容、调用 assertStillHeld() 通过之后、真正调用 atomicWriteExperience()
// 之前，被系统调度/GC pause 等异常挂起超过 STALE_LOCK_MS，另一个进程
// 完全可能在这段"检查完但还没写入"的窗口里判定陈旧、抢占、完成 commit，
// 原进程恢复后没有再检查一次就直接落盘，照样能覆盖新结果——单次
// "检查后写入"不能把这个窗口变成 0。改成**租约续期（lease renewal）**：
// 持锁期间后台每 60s 主动刷新锁文件 mtime（心跳），只要持有者本身没有
// 停顿超过一个心跳周期以上，锁的 mtime 就会持续保持"新鲜"，不会被判定
// 陈旧——把"可能被误抢占"的窗口从"整个处理耗时（不确定，可能很长）"
// 压缩到"必须整整停顿超过 5 分钟、连一次心跳都发不出"这个远小得多、
// 实践中只有真崩溃/真被杀掉才会触发的量级。
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

function newOwnerToken(): string {
  return `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
}

async function tryCreateFresh(lockPath: string, token: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, token, { flag: "wx" }); // 排他创建，内容即所有权凭证
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export interface LockHandle {
  /**
   * 提交写入之前必须调用：重新读取锁文件内容，确认仍是自己的 token。
   * 不匹配（含文件已不存在）→ 抛出 LockLostError，调用方必须中止本次
   * 写入、不得继续任何持久化操作。**这是与心跳机制互补的第二道防线**
   * ——心跳把"被误抢占"的概率压得很低但不是零（心跳定时器本身也可能
   * 因为事件循环被长时间阻塞而错过节拍），`assertStillHeld()` 兜底
   * 处理"万一真的被抢占了"这种边界情况，两者缺一不可：没有心跳，
   * 正常的长任务也可能被误判陈旧；没有 `assertStillHeld()`，心跳机制
   * 本身失效时（如整个 Node 进程被挂起）就完全无防护。
   */
  assertStillHeld(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireLock(lockPath: string, timeoutMs = 5000): Promise<LockHandle> {
  const myToken = newOwnerToken();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await tryCreateFresh(lockPath, myToken)) {
      // 心跳：只更新 mtime，不改变文件内容（token 不变），失败（如文件已
      // 被判定陈旧并回收）忽略——release/assertStillHeld 会捕捉到真正的
      // 所有权丢失，心跳定时器本身不需要对失败做任何特殊处理。
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(lockPath, now, now).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.(); // Node 环境下不阻止进程退出

      return {
        async assertStillHeld() {
          let current: string | null = null;
          try {
            current = await fs.readFile(lockPath, "utf-8");
          } catch { /* 文件不存在 → current 保持 null */ }
          if (current !== myToken) {
            throw new LockLostError(
              `锁已被其他进程回收/重新持有：${lockPath}（本次写入必须中止，可重试）`,
            );
          }
        },
        async release() {
          clearInterval(heartbeat);
          // 只删除仍然属于自己的锁，避免误删被回收后由他人持有的新锁。
          try {
            const current = await fs.readFile(lockPath, "utf-8");
            if (current === myToken) await fs.unlink(lockPath);
          } catch { /* 已不存在 / 读取失败，视为无需再处理 */ }
        },
      };
    }

    // 已存在 → 判断是否陈旧。**这里刻意不再追求"抢占动作本身无竞态"**
    // （上两轮 Review 已证明这条路走不通）——陈旧判定为真就直接
    // unlink + 立即重试创建，接受"小概率误删一个刚创建的合法锁"这个
    // 后果；真正兜底的是上面 assertStillHeld() 的提交前校验：即使这里
    // 误删了 B 的合法锁、A 借机创建了新锁，B 在提交写入前调用
    // assertStillHeld() 会发现锁内容已经是 A 的 token，从而安全中止，
    // 不会产生"A、B 都完成写入"的数据损坏。
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(lockPath).catch(() => {}); // 忽略"已被别的进程先删了"
        continue; // 立即重新尝试 tryCreateFresh，不等待下一轮 sleep
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // stat 时文件已消失（被并发释放）→ 直接进入下一轮重试
    }

    if (Date.now() > deadline) throw new Error(`获取经验写入锁超时：${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export class LockLostError extends Error {}
```

锁文件路径：`{targetPath}.lock`，`document_id` 级别加锁（不是全库加锁，
允许不同经验并发写入，只序列化同一份经验的写入）。**必须在 finally 里
调用 `release()`**，即使写入抛异常（含 `LockLostError`）也不能留下
死锁文件。

**如实说明本方案的理论边界**（不是"绝对不可能被误抢占"）：心跳
+ `assertStillHeld()` 把"被误抢占"的场景从"处理耗时超过 5 分钟就可能
发生"压缩到"持有者本身停顿到连一次 60s 心跳都发不出、且恰好在
`assertStillHeld()` 通过之后、`atomicWriteExperience()` 完成之前这个
极窄窗口内被抢占并完成 commit"——这个概率已经压得很低，但纯本地文件
系统上没有外部协调服务（如 etcd/ZooKeeper 的租约）时，不存在数学上
完全消除该窗口的方案；这与 Redis Redlock、etcd lease 等业界标准分布式
锁方案面对"进程长时间挂起"场景时的理论边界是同一类问题，本项目的
实际场景（同机器多进程、单次写入操作通常远小于 60s）下这个残余风险
可以接受，不引入外部协调服务（如需要更强保证，未来可评估把
`claude_workflow_experience` 这类元数据的锁迁移到已有的 Qdrant/其他
协调点，但那是明显更大的架构变更，不在本 feature 范围内）。

### 模块 4: 去重与生命周期（`mastra-agent/src/experience/write.ts` + `lifecycle.ts`）

写入主流程（`upsertExperience(candidate): Promise<UpsertResult>`）：

1. 脱敏（模块 2）→ `blocked` 则直接返回失败，不写入。
2. 计算 `document_id`（模块 1 规则）与 `content_hash`（脱敏后正文的
   `sha256`）。
3. 获取该 `document_id` 的写入锁（`acquireLock()` 返回 `LockHandle`）。
4. 读取现存文件（若存在），在内存里算好本次要写入的最终内容
   （`occurrence_count`/`document_version`/`supersedes` 等字段）：
   - `content_hash` 相同 → 只把 `occurrence_count += 1`、`updated_at` 刷新，
     **不改变 `document_version`**。
   - `content_hash` 不同 → `document_version += 1`，`supersedes` 字段
     记录 **`{document_id}@v{旧版本号}`（版本化复合标识，不是裸
     `document_id`）**——Codex Review 指出：`document_id` 在同一份经验
     的所有版本间保持稳定不变（这是 F-003 支持 occurrence_count 累加
     所必需的设计），如果 `supersedes` 只存 `document_id`，新版本会
     指向"和自己相同"的 ID，构成自引用，一份经验被更新两次以上时
     完全无法区分"取代了哪一个具体版本"。`occurrence_count` 重置为 1
     （新版本是"新的一次观察"）。**归档的具体落盘顺序见步骤 6**（不能
     在这一步先把旧文件移走）。
   - 文件不存在 → 新建，`document_version=1`、`occurrence_count=1`、
     `status="candidate"`。
5. **`await lock.assertStillHeld()`**——真正落盘之前的最后一道校验，
   见模块 3 的锁设计说明；抛出 `LockLostError` 时不写入任何文件（含
   `.superseded/` 归档也不执行），整个 `upsertExperience()` 直接失败，
   调用方可自行决定是否重新调用整个函数重试。
6. 校验通过 → **按"先归档、后覆盖"的顺序落盘，不能反过来**：
   1. **复制**（不是移动/rename）当前 `{document_id}.md` 的现有内容
      到 `.superseded/{document_id}@v{旧版本号}.md`（若本次是"新建"
      分支则跳过这一步，没有旧内容可归档）。
   2. `atomicWriteExperience()` 把新内容原子写入（tmp + rename）到
      规范路径 `{document_id}.md`，覆盖旧内容。

   **Codex Review 指出的真实 bug**：上一版顺序是"先把旧文件移到
   `.superseded/`，再原子写入新版本"——如果进程在"移走旧文件"之后、
   "新版本原子写入完成"之前被 kill，规范路径 `{document_id}.md` 会
   完全消失（不是半截文件，是文件本身不存在），违反 AC-006（不应
   造成规范文件缺失），且会让 `experience:ingest`/`audit` 把这份经验
   误判为"已被删除"。**先复制归档、再原子覆盖**：即使复制这一步之后
   进程崩溃，规范路径上的旧内容原封不动还在（`atomicWriteExperience`
   还没执行到 rename），只是这次更新的归档白做了、`.superseded/`
   下缺一份历史版本——比"规范文件本身消失"轻得多，且下次重新提交
   同样的更新时归档会重新生成，不会永久丢失。
7. `finally` 里调用 `lock.release()`。

`lifecycle.ts` 状态机：

```ts
const ALLOWED_TRANSITIONS: Record<Status, Status[]> = {
  candidate: ["verified", "deprecated"],
  verified: ["deprecated"],
  deprecated: [], // 终态，不允许復活——需要新经验重新走 candidate
};
export function transition(current: Status, target: Status): Status; // 非法转换抛错

/**
 * 幂等包装：current === target 时直接返回 current，不调用 transition()、
 * 不抛错——供 Feature 3 的 experience:finalize 使用。
 *
 * Codex Review 指出的真实场景：两个并发 finalize 请求处理同一个候选，
 * 第一个成功把 candidate 转成 verified 后，第二个请求重新读到的 current
 * 已经是 verified，若直接调用 transition(current, "verified")，
 * ALLOWED_TRANSITIONS 里 verified 只允许转 deprecated，会被当成非法转换
 * 抛错——但这其实是"已经达到目标状态"的正常收敛，不是错误。用本函数
 * 让第二个请求识别到"已经是目标状态"直接返回成功，效果等价于"串行执行
 * 两次 finalize"（第二次相当于发现已完成，不做任何事）。
 * ⛔ 不通过修改 ALLOWED_TRANSITIONS 加一条 verified→verified 自环来解决
 * ——那样会让 transition() 本身的语义变得"允许原地打转"，掩盖真正的
 * 非法转换（如 deprecated→verified）也可能被误写成自环放行；幂等判断
 * 必须在更高层的 transitionIdempotent() 里做，底层状态机保持严格。
 */
export function transitionIdempotent(current: Status, target: Status): Status {
  if (current === target) return current;
  return transition(current, target);
}
```

`candidate → verified` 的**前置条件校验函数**（`canVerify(evidence):
boolean`）本 feature 只定义接口与校验逻辑（检查证据对象的必需字段是否
齐全），**实际的"是否真的 ALLOW/测试是否真的通过"由 Feature 5 的 N8
集成流程负责采集证据后调用本函数**，本 feature 不感知 Stop Hook。

## 接口契约

```ts
// mastra-agent/src/experience/index.ts（对外导出面）
export { validateExperience, parseExperienceSections, type ExperienceFrontmatter } from "./schema.ts"; // parseExperienceSections 供 Feature 2 检索侧文档级组装复用
export { redact, type RedactResult } from "./redact.ts";
export { upsertExperience, type UpsertResult } from "./write.ts";
export { transition, transitionIdempotent, canVerify, type Status } from "./lifecycle.ts";
export { acquireLock, lockPathFor, LockLostError, type LockHandle } from "./write.ts"; // 供 Feature 3 finalize 复用同一把锁
```

## 数据模型

存储介质：Markdown 文件，位于 `knowledge/experience/{project_scope}/
{document_id}.md`（按 project_scope 分子目录，`global` 经验放
`knowledge/experience/global/`）。frontmatter 见模块 1；正文见需求 F-002。

## 安全考虑

- 脱敏是写入路径的**强制**前置步骤，不提供"跳过脱敏"的参数/开关。
- 锁文件与临时文件都写在目标目录内（不是系统临时目录），保证同文件系统
  的 `rename` 原子性；两者都用 `.tmp-`/`.lock` 前缀，纳入 `.gitignore`
  避免被误提交。
- 不修改、不追加 `AGENTS.md`——本 feature 完全不涉及 `AGENTS.md`，"建议
  升级"逻辑在 Feature 5。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 并发锁实现 | 自制 `fs.open(..., "wx")` vs 引入 `proper-lockfile` | 选自制——项目一贯偏好不加依赖，且需求只是"单机内跨进程互斥"，标准库排他创建足够 |
| frontmatter 解析 | 复用/复制 `rag/markdown.ts` 解析函数 | 视其是否导出可复用函数决定；不修改该文件本身，避免影响客服知识库摄取 |
| `document_id` 算法 | 内容哈希 vs 场景描述哈希 | 选场景描述哈希（project_scope+task_type+stage+标题），因为需要"同一场景多次提交"命中同一 ID 来实现 occurrence_count 累加；纯内容哈希会导致措辞不同的同一场景被当成不同经验 |
| 版本历史保留 | 原地覆盖 vs 移入 `.superseded/` | 选后者——`supersedes` 链要求旧版本可追溯，原地覆盖会丢失历史 |
