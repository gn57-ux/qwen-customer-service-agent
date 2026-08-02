# Feature 1: data-model — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |
| 2026-08-01 | v1.17 | 第十七轮 Codex Review：`acquireLock()` 陈旧锁回收分支的 `continue` 从无条件改为 `if (reclaimed) continue`，修复 unlink 持续失败时忙等待、忽略 `timeoutMs` 的 bug |
| 2026-08-01 | v1.18 | 第十八轮 Codex Review：归档写入改用 `fs.open(..., O_NOFOLLOW)` 而非 `fs.writeFile()`，修复归档文件路径本身（而非其父目录）是符号链接时会跟随写入 experienceRoot 之外的 bug |
| 2026-08-01 | v1.19 | 第十九轮 Codex Review：内容级围栏检查改为比对 `{content_hash, occurrence_count}` 组合状态而非只比 `content_hash`，修复两次并发的相同内容提交（去重路径）无法被围栏检查识别、occurrence_count 增量被静默覆盖丢失的 bug |
| 2026-08-01 | v1.20 | 第二十轮 Codex Review：`redact()` 新增带标注名称的密钥/密码赋值检测规则（`API_KEY=...`/`client_secret=...`/`password=...` 等），不依赖值本身熵，修复低熵标注凭据未被 blocked 的 bug |
| 2026-08-01 | v1.21 | 第二十一轮 Codex Review：`atomicWriteExperience` 的 tmp 路径改用 `fs.open(..., O_EXCL\|O_NOFOLLOW)` 排他创建并追加 `randomUUID()`，修复可预测 tmp 路径被预置符号链接后 `fs.writeFile()` 跟随写入截断 experienceRoot 外部文件的 bug |
| 2026-08-01 | v1.22 | 第二十二轮 Codex Review：新增 `readActiveFileNoFollow()` 并替换 write.ts 两处对 `{document_id}.md` 的直接 `fs.readFile()`，修复规范路径本身是符号链接时读取会跟随的 bug；`atomicWriteExperience` 补上失败清理 tmp 文件的 `try/catch`，修复孤儿 tmp 文件的 bug |
| 2026-08-01 | v1.23 | 第二十三轮 Codex Review：`upsertExperience()` 在晚期围栏检查之后、rename 之前新增第三次 `assertStillHeld()`，修复所有权在此窗口被窃取时静默丢失更新的 bug；`acquireLock()` 心跳改为基于已打开的 `FileHandle` 调用 `handle.utimes()`，修复心跳按路径操作误刷新接班者新锁 mtime 的 bug |
| 2026-08-01 | v1.24 | 第二十四轮 Codex Review：`tryCreateFresh()` 排他创建成功但写入 token 失败时补上关闭句柄+删除孤儿锁文件的清理逻辑，修复瞬时故障被放大成长时间阻塞且掩盖原始错误的 bug |
| 2026-08-01 | v1.25 | 第二十五轮 Codex Review：内容实质变化的新版本 frontmatter 补上 `status: "candidate"`，修复沿用旧版本 verified/deprecated 状态绕过生命周期约束的 bug；`mastra-agent/package.json` 的默认 `test` 命令补上 `experience:test`，修复新测试套件被默认入口跳过的问题 |
| 2026-08-01 | v1.26 | 第二十六轮 Codex Review：归档源读取之后、写入归档文件之前新增一次围栏状态核实（用刚读到的内容自算，不需要额外磁盘读取），修复早期围栏检查通过后、归档源真正读取前所有权被窃取可能污染历史归档的 bug |
| 2026-08-01 | v1.27 | 第二十七轮 Codex Review：`validateExperience()` 新增 `hasTopLevelTitle()` 校验 F-002 要求的一级标题，修复只检查二级标题齐全、完全遗漏一级标题校验的 bug |
| 2026-08-01 | v1.28 | 第二十八轮 Codex Review：`writeArchiveFile()` 改用 tmp+rename 原子写入（保留独立的符号链接显式拒绝检查，不直接复用 `atomicWriteExperience()`），修复 `O_TRUNC` 原地截断写入在崩溃/失败时可能销毁唯一旧版本归档的 bug |
| 2026-08-01 | v1.29 | 第二十九轮 Codex Review：写入后读回校验改用 `readActiveFileNoFollow()`，修复它是本模块唯一仍用 `fs.readFile()` 读取活跃文件、可能跟随符号链接谎报 `ok: true` 的 bug |
| 2026-08-01 | v1.30 | 第三十轮 Codex Review：正文先归一化（`trim()`）一次，哈希/校验/序列化统一复用同一份 `normalizedBody`，修复 `content_hash` 基于归一化前文本计算、与 `serializeExperienceFile()` 实际落盘内容不一致、导致空白差异误判为内容变化的 bug |
| 2026-08-01 | v1.31 | 第三十一轮 Codex Review：`upsertExperience()` 在计算 `projectDir` 之前新增 `assertNotSymlink(candidate.experienceRoot)`，修复 `experienceRoot` 本身是符号链接时词法检查与 `projectDir` 的 lstat 都拦不住、写入实际落到配置根之外的 bug；**Feature 1 功能/安全范围自本轮起冻结（102/102 通过），后续仅接受可由 AC-001~AC-030 证明的缺陷修复** |

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
14 个字段类型/枚举合法性 + F-002 要求的一级标题（`# 标题`）+ 9 个必需
二级标题是否存在，返回 `{ ok: true }` 或 `{ ok: false, errors: string[] }`，
不抛异常（调用方决定如何处理）。

**一级标题的校验必须显式存在，不能只靠二级标题齐全就判定通过**（第
二十七轮 Codex Review 修复，AC-026）：旧实现只切分并检查了 9 个二级
标题，完全没有校验 F-002 明确要求的 `# 标题` 本身是否存在——没有一级
标题、或一级标题前有任意无关文字的正文都能通过校验并被持久化，违反
文档化的 schema。修复：新增私有函数 `hasTopLevelTitle(body): boolean`，
只检查正文的第一条非空行是否匹配 `/^#\s+\S/`（单个 `#` 后至少一个
空白、再跟非空白标题文字）——`\s+` 紧跟在唯一的 `#` 之后天然排除了
`##` 这类更深层标题（第二个 `#` 会让 `\s+` 匹配失败），不需要额外判断
层级。校验的是"是否存在合法的一级标题"，不要求标题文字是字面的
"标题"二字（测试夹具里的 `"# 标题"` 只是示例文本）。

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

`serializeExperienceFile(frontmatter, body): string` 序列化 frontmatter
时，字符串字段（`title`/`source` 等，candidate 可控）**必须做 YAML 标量
转义/引用**，不能直接字符串拼接（第十二轮 Codex Review 指出的真实
bug：`title` 含冒号、`#`、前导特殊字符或换行时，原样拼接会产出对标准
YAML 消费者无效或被误解析的 frontmatter，例如 `title: Failure: retry
handling` 里第二个冒号会被解析成新的 key）——命中以下任一条件就用双引号
包裹并转义（`\`/`"`/换行）：空字符串、首尾有空白、含 `:`/`#`、含
换行、以 YAML 特殊字符开头（`- ? : , [ ] { } & * ! | > ' " % @` 反引号）、
是 `true`/`false`/`null`/`yes`/`no` 字面量、是纯数字。`parseExperienceFile`
必须能反向解析双引号转义（含 `\\`/`\"`/`\n`/`\r`/`\t`），保证
序列化→解析往返一致；数值字段（`document_version`/`occurrence_count`）
不套用这套规则，原样输出数字字面量。

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
  参考价值"的情况，直接拒绝比替换更安全）。**Cookie 单独补充规则**
  （第十六轮 Codex Review 指出的真实漏洞：普通 Cookie 值如
  `session_id=abc123` 往往是短小写字母数字串，不满足"高熵启发式"，
  之前会被漏放，违反 F-004/AC-005 明确要求 Token/Key/Cookie 三类都
  必须 blocked 的规定）：
  - `Cookie:`/`Set-Cookie:` 请求/响应头（大小写不敏感）→ 命中即整行
    `blocked: true`，不依赖值本身的熵。
  - 不带头部前缀、但值本身是已知会话 cookie 名称（`session_id`/
    `sessionid`/`PHPSESSID`/`JSESSIONID`/`connect.sid`/`auth_token`/
    `csrf_token`/`xsrf_token` 等）的赋值形式 → 同样 `blocked: true`，
    覆盖日志片段/代码示例里不带 `Cookie:` 前缀但仍是真实会话凭据的
    情况。
  - **第二十轮 Codex Review 补充**：带标注名称的密钥/密码赋值——
    `API_KEY=abc123`/`client_secret=secret`/`password=hunter2` 这类值
    本身很短、很像普通单词的场景，同样不满足通用高熵启发式，会被漏放。
    命中已知凭据标签（`api_key`/`api_secret`/`secret_key`/
    `client_secret`/`access_key`/`access_token`/`private_key`/
    `auth_key`/`signing_key`/`encryption_key`/`password`/`passwd`/
    `pwd`）+ `:`/`=` 赋值语法（标签后允许一个可选收尾引号，兼容
    `{"api_key": "..."}` 这种 JSON 写法）→ 同样 `blocked: true`，不管
    值本身长什么样。只收录明确是凭据语义的复合标签，不收录裸
    "key"/"secret"/"token" 这类会在正常技术散文里大量出现的通用词
    （避免"key 的类型定义在 schema.ts 里"这类正常描述被误判）。
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
  **实现阶段发现并收紧**：上述正则原样实现会把"schema.ts"/
  "package.json"这类几乎出现在每篇技术经验里的文件名整体误判成远程
  主机（两段式 `word.word` 结构与 FQDN 无法用正则本身区分），会让脱敏
  后的经验文档不可读，违背脱敏的本来目的——收紧为：只有末段是已知
  TLD（`com`/`net`/`org`/`io`/`dev`/`ai`/`co`/`app`/`cloud`/`info`/
  `gov`/`edu`/`me`/`xyz`/`tech`/`cn`/`top`/`site`/`online`）或带子域名
  （三段及以上，如 `api.internal.example.io`）才判定为主机；末段是常见
  源码/文档扩展名（`ts`/`tsx`/`js`/`json`/`md`/`py`/`yml`/`css`/`html`/
  `sh`/…）时直接放行。收紧方向仍是"宁可漏放明显是文件名的 case，不放宽
  到误拦所有技术文档"，不违反 NFR 的"宁可误拦不可漏放"原则——那条原则
  约束的是"真正疑似主机的字符串该不该拦"，不是"把所有 word.word 结构
  都当成主机"。**第十二轮 Codex Review 追加发现**：三段及以上判定为
  "带子域名的强 FQDN 信号"这条分支完全没检查标签内容，会把
  "Node 22.1.0"这类随处可见的版本号、构建号整体误判成远程主机——补充
  规则：所有标签都是纯数字（`^[0-9]+$`）时一律不算主机（真实主机名的
  标签是字母数字混合，纯数字点分串是版本号/IP 的特征；公网 IP 地址本来
  就不在本规则覆盖范围内，只有 `INTERNAL_IP_RE` 命中的内网/私有 IP
  才需要脱敏，这条排除不会漏掉任何本该拦截的目标）。
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
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const handle = await fs.open(
    tmpPath,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
  );
  try {
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, targetPath); // 同文件系统内 rename 是原子操作
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
}
```

**实现时独立成 `mastra-agent/src/experience/atomic-write.ts` 单文件**（`write.ts`
从这里 re-export，对外接口不变）——`node:test` 的 `mock.module()` 只能
拦截跨文件 import，AC-006 需要模拟"归档已完成、原子写入尚未执行前"
这个具体时间点，必须让 `atomicWriteExperience` 是可被独立 mock 掉的
外部依赖，不能是 `upsertExperience()` 同文件内的私有函数调用。

**tmp 路径必须用 `O_CREAT|O_EXCL|O_NOFOLLOW` 排他创建，不能用
`fs.writeFile()` 直写（第二十一轮 Codex Review 修复，AC-017）**——
`${targetPath}.tmp-{pid}-{timestamp}` 这个路径在真正创建之前是可
预测的，如果 experience 目录对本机其他进程可写，攻击者可以预先在
这个确切路径放一个指向 `experienceRoot` 之外的符号链接；
`fs.writeFile()` 默认跟随符号链接写入并截断链接指向的外部文件，
绕开了 project/archive 路径已有的符号链接防护（AC-011/AC-014），
是同一类攻击面在原子写入这最后一步的遗漏。`O_NOFOLLOW` 让 `open()`
在目标是符号链接时以 `ELOOP` 失败；`O_EXCL` 确保该路径此刻确实
不存在任何东西（符号链接或普通文件），排除"复用已存在普通文件"
这另一种意外覆盖。文件名额外加 `randomUUID()` 段是纵深防御的第二层
（降低被提前猜中的概率），不是唯一防线——真正的安全边界是
`O_NOFOLLOW`/`O_EXCL` 这两个标志本身。`fs.rename(tmpPath, targetPath)`
不需要同样的防护：POSIX `rename()` 语义是替换目标路径的目录项本身
（若目标已是符号链接，链接本身被替换掉），不会跟随目标符号链接写穿
到它指向的位置，这与 `open`/`writeFile` 跟随符号链接的行为不同。

**tmp 文件创建成功后，写入/关闭句柄/`rename` 任一步失败都必须清理
它（第二十二轮 Codex Review 修复，AC-019）**——磁盘耗尽、权限问题等
瞬时故障会在每次失败重试后留下一份包含完整经验内容的孤儿 `.tmp-*`
文件，此前这些路径一直被文档描述为"transient"，实际上从未被回收。
用外层 `try/catch` 包住"写入+关闭+rename"整个序列，失败时 `unlink`
清理 tmp 文件（`.catch()` 静默吞掉清理本身的失败，不能让它掩盖需要
抛给调用方的原始错误），再重新抛出原始异常。

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

// 返回打开的 FileHandle 而不是布尔值——心跳需要基于这个 fd 做
// `handle.utimes()`，不能按路径（第二十三轮 Codex Review 修复，见下方
// acquireLock() 里的用法说明）。
async function tryCreateFresh(lockPath: string, token: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, O_WRONLY | O_CREAT | O_EXCL); // 排他创建，内容即所有权凭证
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try {
    await handle.writeFile(token, "utf-8");
  } catch (e) {
    // 排他创建已经成功，但写入所有权凭证本身失败（磁盘耗尽/瞬时 I/O
    // 错误等）——此时磁盘上已经留下一个空的 `.lock` 文件（第二十四轮
    // Codex Review 指出的真实 bug，AC-022）：如果不清理，后续任何进程
    // 都会把它当作"别人持有的活跃锁"，需要等满一整个 staleLockMs 才能
    // 判定陈旧并回收，把一次瞬时故障放大成一次长时间阻塞，还掩盖了
    // 真正的失败原因。必须关闭 fd 并删除这个刚创建、内容还是空的锁
    // 文件，再把原始错误原样抛出——不能让清理动作本身掩盖需要让调用方
    // 看到的错误。
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    throw e;
  }
  return handle;
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

// STALE_LOCK_MS/HEARTBEAT_INTERVAL_MS 均可被 opts 参数或环境变量
// （EXPERIENCE_LOCK_STALE_MS/EXPERIENCE_LOCK_HEARTBEAT_MS）覆盖——
// AC-007d 需要用远小于 5 分钟的阈值加速测试，不必真的等待。
export async function acquireLock(
  lockPath: string,
  timeoutMs = 5000,
  opts: { staleLockMs?: number; heartbeatIntervalMs?: number } = {},
): Promise<LockHandle> {
  const staleLockMs = opts.staleLockMs ?? STALE_LOCK_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const myToken = newOwnerToken();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const handle = await tryCreateFresh(lockPath, myToken);
    if (handle) {
      // 心跳必须基于已经打开的 fd 用 `handle.utimes()`，不能按路径用
      // `fs.utimes(lockPath, ...)`（第二十三轮 Codex Review 修复，
      // AC-021）：如果本进程停顿过久（超过 staleLockMs 却没能发出下一
      // 次心跳），另一进程会判定这把锁陈旧、`unlink` 掉、在同一路径
      // 重新创建一把属于它自己的新锁；本进程恢复后，若心跳仍按路径
      // 操作，会不加区分地刷新"此刻这个路径上无论是谁的锁"的
      // mtime——把新 owner 的锁误刷新成"看起来很新鲜"，即使新 owner
      // 随后真的崩溃，陈旧检测也会被这个僵尸心跳永久蒙蔽，探测不到。
      // fd 天然没有这个问题：`unlink` 只是移除目录项，我们持有的 fd
      // 仍然引用着原来那个（此刻已从目录中摘除的）inode，`handle.
      // utimes()` 只会作用在这个"幽灵" inode 上，不会影响同一路径上
      // 新创建的文件——不需要额外的"心跳前先校验归属"这类本身仍有
      // TOCTOU 窗口的补丁，直接从机制上避免了这个问题。
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle.utimes(now, now).catch(() => {});
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
          } catch { /* 已不存在 / 读取失败，视为无需再处理 */
          } finally {
            await handle.close().catch(() => {});
          }
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
    //
    // **第十四轮 Codex Review 追加**：单纯"stat 一次就直接 unlink"会把
    // "判定陈旧"到"真正删除"之间的任意时长窗口都暴露给竞态——unlink
    // 无差别删除当前实际存在的文件，不管它是不是最初判定为陈旧的那份。
    // 收紧为：紧贴在 unlink 之前再读一次内容+mtime，两次读到的结果完全
    // 一致才真正回收；不一致说明这段时间内已经有其他进程回收并重新
    // 持有了这把锁，本轮不动它，直接进入下一轮重试。这不是真正的原子
    // CAS（两次 await 之间仍有极短间隙，POSIX 文件 API 做不到内容级
    // compare-and-swap），只是把窗口从"任意时长"压缩到"两次背靠背系统
    // 调用之间"。**真正防止"两个进程都完成写入"的保证不在这里**，而在
    // 模块 4 `upsertExperience()` 落盘前的 content_hash 围栏检查——
    // 该检查从数据本身而不是锁状态判断冲突，与锁的实现细节无关，覆盖了
    // 锁机制任何残余竞态都可能引入的边界情况。
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        const staleToken = await fs.readFile(lockPath, "utf-8").catch(() => null);
        const recheck = await fs.stat(lockPath).catch(() => null);
        const stillStale = recheck !== null && Date.now() - recheck.mtimeMs > STALE_LOCK_MS;
        let reclaimed = false;
        if (stillStale) {
          const recheckToken = await fs.readFile(lockPath, "utf-8").catch(() => null);
          if (recheckToken === staleToken) {
            reclaimed = await fs.unlink(lockPath).then(() => true, () => false);
          }
        }
        // **第十七轮 Codex Review 指出的真实 bug**：只有确认真的删掉了
        // 陈旧锁，状态才发生了变化，值得立即重试创建。上一版在这里无
        // 条件 `continue`——如果 unlink 持续失败（EACCES、只读文件系统、
        // 或本轮 recheck 发现锁已不再陈旧/token 已变化），这个无条件
        // `continue` 会跳过下面的超时检查（`if (Date.now() > deadline)`）
        // 和 50ms 退避，整个循环退化成完全忽略 `timeoutMs` 的忙等待：
        // 既不会超时报错，也会占满 CPU 空转。收紧为只有 `reclaimed`
        // 为真才立即重试；未能回收时落到下面统一的超时检查/退避分支，
        // 保证 `acquireLock()` 在任何情况下都会在 `timeoutMs` 内返回
        // （成功或抛出"获取经验写入锁超时"），不会无限等待。
        if (reclaimed) continue;
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

0. **校验 `project_scope` 是安全的单层路径片段**（不含 `/`、`\`、
   空字符，不是裸 `.`/`..`）→ 不合法直接返回
   `{ ok: false, reason: "invalid_project_scope" }`，不做任何文件系统
   操作（第十三轮 Codex Review 指出的真实路径穿越漏洞：
   `path.join(experienceRoot, projectScope)` 对 `"../../etc"` 这类值
   不做任何限制，会在 `experienceRoot` 之外创建锁/归档/Markdown 文件）。
   计算出目标目录后，**再用 `path.resolve` + `path.relative` 二次校验
   结果确实落在 `experienceRoot` 内**作为兜底（防御纵深，不因为已有
   步骤 0 的字符白名单校验就省略）。**第十四轮 Codex Review 追加**：
   上述校验都是词法（lexical）路径比较，不会跟随符号链接——如果
   `experienceRoot` 下已经存在一个名为 `projectScope` 的符号链接、
   指向根目录之外，词法检查会误判为"在根目录内"，但后续锁/归档/
   Markdown 写入会跟随符号链接真正落到根目录之外。用 `lstat`（不跟随
   符号链接）显式检查该项目录条目：不存在 → 安全（后续 `mkdir` 会创建
   一个我们自己拥有的真实目录）；存在且不是符号链接 → 安全；存在且是
   符号链接 → 直接拒绝，不做任何后续文件系统操作。**第十六轮 Codex
   Review 追加**：这个检查不能只做在 `projectDir` 这一层——`projectDir`
   下固定名为 `.superseded` 的归档子目录同样是攻击面，如果它已经被
   预先替换成指向根目录之外的符号链接，归档写入（步骤 6.1）会跟随
   符号链接逃逸；必须在**每一个**即将写入的目录条目（`projectDir` 与
   `.superseded` 目录）上都做这项 `lstat` 检查，不能只检查最外层。
1. **脱敏不能只覆盖正文**——`title`/`source`/`project_scope` 同样是
   candidate 可控的自由文本，必须分别过 `redact()`（模块 2）；任一个
   `blocked` 都直接返回失败，不写入（第十三轮 Codex Review 指出的真实
   漏洞：初版实现只脱敏了 `body`，`title`/`source` 里的邮箱/密钥会原样
   落盘到 frontmatter，绕过了"写入前强制脱敏"这条安全要求）。后续步骤
   使用的都是脱敏后的 `title`/`source`/`project_scope` 文本，不是
   candidate 原始值。
2. 计算 `document_id`（模块 1 规则，用脱敏后的 `title`/`project_scope`）
   与 `content_hash`（脱敏后正文的 `sha256`）。**`content_hash` 必须
   基于归一化之后的正文计算，不能直接对脱敏后但未归一化的
   `redactedBody.text` 求哈希**（第三十轮 Codex Review 指出的真实
   bug，AC-029）：本模块最终落盘时会调用 `serializeExperienceFile()`，
   它对正文执行的是 `body.trim() + "\n"`；如果哈希是对归一化之前的
   文本算出来的，两次语义完全相同、只是前导/尾随空白不同的提交会
   序列化出字节完全一致的文件，却因为归一化前的原始文本不同而算出
   不同的 `content_hash`——把本该走 F-005 去重路径（只
   `occurrence_count += 1`）的重复提交误判成"内容变化"，凭空生成一个
   不必要的新版本（还会触发一次不必要的归档）。修复：`normalizedBody
   = redactedBody.text.trim()` 只算一次，之后计算 `content_hash`、
   调用 `validateExperience()`、调用 `serializeExperienceFile()` 全部
   使用这同一个 `normalizedBody`，不再各自独立引用 `redactedBody.text`
   ——`serializeExperienceFile()` 对已经 trim 过的字符串再次
   `.trim()` 是幂等操作，不会产生额外影响。
3. 获取该 `document_id` 的写入锁（`acquireLock()` 返回 `LockHandle`）。
4. **读取现存文件（若存在）必须用 `readActiveFileNoFollow()`，不能
   直接 `fs.readFile()`**（第二十二轮 Codex Review 指出的真实漏洞）：
   规范路径 `{document_id}.md` 本身也是符号链接逃逸的攻击面——如果
   它在读取之前已经存在且是符号链接、指向 `experienceRoot` 之外，
   `fs.readFile()` 默认会跟随写入并读到外部文件内容，进而可能被当作
   "现存版本"参与后续的去重/版本递增决策，甚至被归档进
   `.superseded/`；project 目录（步骤 0）、`.superseded` 目录（第十六
   轮）、`.superseded` 归档文件本身（第十八轮）、原子写入 tmp 路径
   （第二十一轮）都已经有符号链接防护，唯独遗漏了这个每次更新都必然
   会先读一次的入口。`readActiveFileNoFollow()`（定义于
   `read-content-hash.ts`）用 `fs.open(path, O_RDONLY|O_NOFOLLOW)` 在
   open 阶段本身拒绝跟随符号链接（`ELOOP`），不用"先 `lstat` 检查、
   再 `readFile`"以避免 TOCTOU 窗口，与本模块其余读写路径的一贯做法
   一致；路径不存在时返回 `null`（正常的"首次创建"场景），路径存在
   且是符号链接时直接抛错，不静默跳过。在内存里算好本次要写入的最终
   内容（`occurrence_count`/`document_version`/`supersedes` 等字段）：
   - `content_hash` 相同 → 只把 `occurrence_count += 1`、`updated_at` 刷新，
     **不改变 `document_version`**。
   - `content_hash` 不同 → `document_version += 1`，`supersedes` 字段
     记录 **`{document_id}@v{旧版本号}`（版本化复合标识，不是裸
     `document_id`）**——Codex Review 指出：`document_id` 在同一份经验
     的所有版本间保持稳定不变（这是 F-003 支持 occurrence_count 累加
     所必需的设计），如果 `supersedes` 只存 `document_id`，新版本会
     指向"和自己相同"的 ID，构成自引用，一份经验被更新两次以上时
     完全无法区分"取代了哪一个具体版本"。`occurrence_count` 重置为 1
     （新版本是"新的一次观察"）。**`status` 必须重置为 `"candidate"`，
     不得沿用旧版本的 `verified`/`deprecated`**（第二十五轮 Codex
     Review 修复，AC-023）：`status` 表达的是"这份具体内容有没有经过
     审核"，如果实现里用 `{...existing, ...}` 展开旧 frontmatter，会
     把上一版的审核结论原样带到新内容上——旧版本被验证过不代表新内容
     也经过了同样的审核（绕过 candidate→verified 必须走
     `canVerify()` 的生命周期约束），旧版本被标记 `deprecated` 也不该
     让全新的内容永久带着这个标记、再也无法被正常验证；新版本必须
     重新从 `candidate` 起步，独立走一遍生命周期。**归档的具体落盘
     顺序见步骤 6**（不能在这一步先把旧文件移走）。
   - 文件不存在 → 新建，`document_version=1`、`occurrence_count=1`、
     `status="candidate"`。
4.5. 记录基线围栏状态 `baselineFence = existing ? { contentHash:
   existing.content_hash, occurrenceCount: existing.occurrence_count }
   : null`——这是本次更新决策（去重/版本递增）所依据的磁盘状态快照，
   供步骤 6.5 的内容级围栏检查比对用。**第十九轮 Codex Review 指出的
   真实 bug**：早期实现只记录 `content_hash`（`baselineHash`），漏了
   `occurrence_count`——两次并发的**相同内容**提交都会走去重路径
   （`existing.content_hash === contentHash`），都只把
   `occurrence_count` 从同一个基线值各自独立 +1，`content_hash`
   本身从头到尾不变；如果锁机制的残余竞态窗口（见模块 3 说明）恰好让
   两者都通过了获取锁阶段，只比 `content_hash` 的围栏检查会对这种
   "内容相同、只有计数字段变化"的并发写入完全失明，其中一次的
   `occurrence_count` 增量会被另一次无声覆盖丢失，而两次都报告
   `ok: true`。加入 `occurrence_count` 后，任何一次真正成功的写入
   （无论是否改变内容）都会让基线状态失配，围栏检查才能覆盖全部会
   触发 frontmatter 变化的并发写入路径，不只是"内容变化"这一种。
5. **`await lock.assertStillHeld()`**——落盘之前的第一道校验，见模块 3
   的锁设计说明；抛出 `LockLostError` 时不写入任何文件（含
   `.superseded/` 归档也不执行），整个 `upsertExperience()` 直接失败，
   调用方可自行决定是否重新调用整个函数重试。
5.5. **第一次内容级乐观并发围栏检查**（第十四轮 Codex Review 引入，
   独立于锁 token 比对的第二道防线；**必须在任何文件系统写入/归档
   之前执行**——第十五轮 Codex Review 指出的真实 bug：上一版把这次
   检查放在归档之后，若冲突恰好在这里被发现，函数已经在
   `.superseded/` 下留了一份文件才返回 `conflict`，违反"冲突时不写入
   任何文件"的承诺，还可能把竞争对手的内容错误归档到我们计算出的旧
   版本号下）：重新读取目标文件此刻的围栏状态（`content_hash` **加上**
   `occurrence_count`，第十九轮 Codex Review 追加，不存在则为
   `null`），与步骤 4.5 记录的 `baselineFence` 比较——不一致（任一
   字段不同，见下方 `fenceStatesEqual()`）→ 说明这段时间内已经有人
   成功提交了别的更新，返回 `{ ok: false, reason: "conflict" }`，
   不做任何写入；一致 → 继续。
6. 校验通过 → **按"先归档、后覆盖"的顺序落盘，不能反过来**：
   1. **先对 `.superseded` 目录本身做符号链接检查**（步骤 0 已说明的
      同一个 `lstat` 检查函数，第十六轮 Codex Review 追加），通过后
      **复制**（不是移动/rename）当前 `{document_id}.md` 的现有内容
      到 `.superseded/{document_id}@v{旧版本号}.md`（若本次是"新建"
      分支则跳过这一步，没有旧内容可归档）。**第十八轮 Codex Review
      追加**：目录本身不是符号链接不代表**归档文件这个具体路径**也
      干净——攻击者可以预先在 `.superseded/{document_id}@v{旧版本号}.md`
      这个确切路径放一个文件级符号链接指向 `experienceRoot` 之外，
      `fs.writeFile()` 默认会跟随文件级符号链接写入，绕开了对目录的
      检查（第十六轮只堵了目录这一层，遗漏了目录*里*具体文件路径这一
      层）。第十八轮的修复是归档写入改用 `fs.open(path,
      O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW)` 而不是 `fs.writeFile()`。
      **第二十八轮 Codex Review 进一步指出：这个 `O_TRUNC` 原地截断
      写入不是原子操作**——进程崩溃或 `handle.writeFile()` 失败会让
      归档文件残留为空文件或半截内容，可能销毁这个 feature 本该保留
      的唯一旧版本，违反 F-006"崩溃不得留下半截 Markdown"的要求（AC-
      027）。修复：改为 tmp + rename 的原子写入模式（与
      `atomicWriteExperience()` 同构），但**不能直接复用
      `atomicWriteExperience()`**——`fs.rename()` 替换目标目录项本身
      不跟随符号链接虽然不会写穿到外部文件，但会把符号链接*本身*静默
      替换成归档文件，违反 AC-014"符号链接本身不得被移除或替换"这条
      明确要求。修复后的具体流程：
      1. 写入前先显式 `lstat` 目标路径，是符号链接就直接拒绝（不做
         任何后续操作，符号链接原样保留）。
      2. 写入一个用 `O_EXCL|O_NOFOLLOW` 排他创建的 tmp 文件（tmp 路径
         同样是符号链接逃逸的攻击面，需要与 `atomic-write.ts` 相同的
         防护）。
      3. **紧贴在 `rename` 之前再核实一次目标不是符号链接**——第一次
         检查到这里之间仍有窗口（纯 POSIX 无法把这个窗口彻底消灭到
         零，与本文件其余同类检查是一致的理论边界），但能把窗口压缩
         到"一次系统调用到下一次系统调用之间"。
      4. `rename(tmpPath, targetPath)`；写入/rename 任一步失败都清理
         tmp 文件，不掩盖原始错误。
      不加 `O_EXCL` 的旧约束（"合法的崩溃后重试场景下同一路径可能已经
      是上一次尝试遗留的普通文件，此时应该允许覆盖"）在新方案里依然
      成立——`O_EXCL` 只作用于 tmp 路径（永远是新建），最终的
      `rename` 本身天然允许覆盖已存在的普通文件，不需要额外处理。
      **归档源本身的读取
      同样必须用 `readActiveFileNoFollow()`**（第二十二轮 Codex
      Review 追加）：从步骤 4 的初次读取到这里之间，`{document_id}.md`
      理论上仍可能被替换成符号链接，不能假设入口处检查一次就够，与
      本模块"能用一次系统调用堵住就不留检查-写入两步窗口"的一贯原则
      一致。**归档源读取之后、写入归档文件之前必须再核实一次内容仍是
      基线版本**（第二十六轮 Codex Review 修复，AC-025）：早期围栏
      检查（步骤 5.5）通过之后、这里真正读到内容之前，如果另一个
      写入者恰好完成了自己完整的一轮更新（读到旧内容→写入新内容→
      rename），这里读到的 `oldRaw` 已经是对方刚写入的新版本；若不
      核实就直接写进按本进程自己（此刻已陈旧）的 `archiveOldVersion`
      算出的归档路径，会把错误版本的内容永久写进历史归档——即使下面
      步骤 6.3 的第二次围栏检查随后发现冲突并让整个 `upsertExperience()`
      报告 `conflict`，归档文件此刻已经被污染，无法撤销，这是"报告
      冲突就等于没有产生副作用"这条隐含假设被打破的一个具体反例。
      修复：用刚读到的 `oldRaw` 自己解析出一份围栏状态（不需要额外
      一次磁盘读取），与步骤 4.5 记录的 `baselineFence` 用
      `fenceStatesEqual()` 比较，不一致就必须在调用 `writeArchiveFile()`
      之前直接返回 `{ ok: false, reason: "conflict" }`。
   2. **再次 `await lock.assertStillHeld()`**——紧贴在
      `atomicWriteExperience()` 之前，不能省略（Codex Review 第十二轮
      指出的真实 bug：归档这一步本身有真实 I/O 耗时，如果所有权恰好在
      "步骤 5.5 通过"之后、"归档完成"之前这段窗口内丢失——心跳错过
      节拍、被误判陈旧并抢占——之前的校验并不会重新触发，进程会继续
      执行到 `atomicWriteExperience()`，静默覆盖掉抢占者已经提交的
      更新，这正是"最终只会有一个进程真正完成写入"这条保证本该阻止的
      场景。保证"落盘前重新校验所有权"必须紧贴在真正的 rename 之前，
      不能只在耗时步骤开始前校验一次就假定期间不会丢失所有权）。
   3. **第二次内容级围栏检查**：与步骤 5.5 相同的比对，捕获归档这段
      I/O 耗时期间新出现的冲突——不一致同样返回
      `{ ok: false, reason: "conflict" }`（这一步之前已经产生了
      `.superseded/` 归档文件，属于"归档白做了"的可接受代价，见下方
      归档顺序说明，不违反"不覆盖规范文件"的核心承诺）。
   3.5. **第三次 `await lock.assertStillHeld()`——紧贴在
      `atomicWriteExperience()` 之前，中间不再夹任何其他 I/O**（第
      二十三轮 Codex Review 修复，AC-020）：步骤 2 的所有权校验与
      步骤 4 的 rename 之间仍隔着步骤 3 这次围栏检查的真实 I/O——如果
      所有权恰好在这段窗口内被另一进程回收并重新持有，而围栏状态本身
      没有变化（只是锁的归属变了，内容级围栏检查天生看不出这一点），
      旧实现会在没有再次核实所有权的情况下直接 rename：两个进程可能
      各自对着自己刚写入的内容做步骤 5 的读回校验并都验证成功、都报告
      `ok: true`，其中一次的更新被静默覆盖丢失——这是步骤 5 的读回
      校验本身无法覆盖的镜像情形（它只能发现"自己写完之后又被别人
      覆盖"，无法发现"自己的 rename 覆盖了别人已经报告成功的写入"）。
      把所有权校验挪到紧邻 rename 之前，让"最后一次所有权校验"和
      "真正落盘"之间不再夹着任何额外 I/O，把窗口从"一次围栏检查的
      I/O 耗时"压缩到"一次 Promise resolve 到下一次 await 之间"这个
      量级——纯 POSIX 文件 API 无法把这个窗口彻底消灭到零（与模块
      顶部锁获取阶段、步骤 5 读回校验说明的是同一类"没有外部协调
      服务就无法从数学上完全消除"的理论边界），但这是目前能做到的
      最强保证。
   4. `atomicWriteExperience()` 把新内容原子写入（tmp + rename）到
      规范路径 `{document_id}.md`，覆盖旧内容。
   5. **写入后读回校验**（第十五轮 Codex Review 引入）：立即重新读取
      刚写入的 `{document_id}.md`，确认 `document_version`/
      `occurrence_count`/`content_hash` 确实是本次写入的那份——不一致
      说明有人紧跟着我们的 rename 之后又完成了一次覆盖，返回
      `{ ok: false, reason: "conflict" }`（不再谎称 `ok: true`）。**如实
      说明这一步的理论边界**：这不能撤销已经发生的写入，纯 POSIX 文件
      API 也无法让"围栏检查→rename"两步本身做到完全无竞态的原子操作
      ——第十四、十五轮 Codex Review 反复指出的这类窗口与模块 3 顶部
      锁获取阶段的理论边界是同一类问题，没有外部协调服务（数据库事务/
      分布式锁）无法从数学上完全消除；这一步提供的保证是"不会有调用方
      在更新被覆盖后仍然收到成功假象"，而不是"物理上不可能发生竞争
      写入"——真正生效的那一方会在自己的读回校验里看到自己的内容，
      从而正确报告成功，收敛到"最多一方声称成功，其余如实报告冲突并
      可重试"。**这一步的读取必须用 `readActiveFileNoFollow()`，不能
      用会跟随符号链接的 `fs.readFile()`**（第二十九轮 Codex Review
      指出的真实 bug，AC-028）：`atomicWriteExperience()` 的 rename
      完成、函数返回之后，到这里真正执行读回之前，如果另一个本机进程
      恰好把规范路径替换成指向一份"版本/计数/哈希都精心构造成匹配"的
      外部文件的符号链接，会跟随符号链接的读取会误判"确实生效"并谎报
      `ok: true`，同时读到了 `experienceRoot` 之外的数据——本模块步骤
      4 的初次存在性判断、步骤 6.1 的归档源读取、`readCurrentFenceState`
      内部都已经统一使用这个不跟随符号链接的安全读取，读回校验这最后
      一步此前遗漏了。旧实现用 `.catch(() => null)` 把所有错误（含
      符号链接导致的 `ELOOP`）都吞成"未生效"→`conflict`，看起来"安全
      降级"，实际上掩盖了这个本该向调用方明确报警的异常情形；
      `readActiveFileNoFollow()` 只把"文件不存在"这一个确定状态映射
      为 `null`，符号链接会像本模块别处一样直接抛出描述性错误，不
      静默吞掉。

   **归档顺序本身的 Codex Review 记录**：上一版顺序是"先把旧文件移到
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
