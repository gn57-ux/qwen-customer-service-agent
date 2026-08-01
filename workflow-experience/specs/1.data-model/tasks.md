# Feature 1: data-model — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 新增子模块
- specs 路径: workflow-experience/specs/1.data-model/

## 任务列表

### 功能 1: frontmatter schema 与校验

- [ ] T-001: 定义 `ExperienceFrontmatter` 类型 + `REQUIRED_SECTIONS` 常量 +
  `document_id` 生成函数（`mastra-agent/src/experience/schema.ts`）~30min
- [ ] T-002: `validateExperience()` 校验函数（14 字段类型/枚举 + 9 个
  必需二级标题），返回结构化错误列表，不抛异常；内部的正文分节逻辑
  单独导出为 `parseExperienceSections(body): Map<string,string>`
  （供 Feature 2 检索侧文档级组装复用，见 design.md 模块 1 第十一轮
  Codex Review 修正记录，⛔ 不要让 Feature 2 重新实现一套分节解析）
  ~30min

### 功能 2: 脱敏

- [ ] T-003: `redact()` 实现（8 类规则：①绝对用户路径 ②Token/Key/Cookie
  ③邮箱 ④内网/私有 IP ⑤当前用户名 ⑥账号/组织信息（Git remote
  org/repo 片段 + `@handle`）⑦远程主机（FQDN 白名单排除已知合法公共/
  文档域名）⑧原始聊天内容片段（含 `User:`/`Assistant:` 等角色前缀的
  连续 3 行以上）+ `blocked` 判定——②⑧命中直接 `blocked: true` 拒绝
  写入，其余类别替换为占位符），`mastra-agent/src/experience/redact.ts`
  ~45min（design.md 模块 2 第三轮 Codex Review 已把类别从最初 5 类
  补全到 8 类，本任务描述同步更新，避免按旧清单实现漏掉后 3 类）

### 功能 3: 原子写入与并发锁

- [ ] T-004: `atomicWriteExperience()`（tmp 文件 + rename）+
  `acquireLock()`/`lockPathFor()`，返回 `LockHandle`（所有权 token +
  `wx` 排他创建 + 超时 + 基于 mtime 判定陈旧后 unlink 重试——**不追求
  抢占动作本身无竞态**，见 design.md 第三、四轮 Codex Review 记录的
  结论：纯文件 API 做不到完美 CAS，改为 `assertStillHeld()`
  提交前校验兜底 + `release()` 校验 token 归属；持锁期间按
  `HEARTBEAT_INTERVAL_MS` 心跳刷新 mtime（第五轮 Codex Review 引入，
  防止长时间正常处理被误判陈旧）；`STALE_LOCK_MS`/
  `HEARTBEAT_INTERVAL_MS` 做成可选参数/环境变量覆盖，供 AC-007d 用更短
  阈值加速测试，不必真的等 5 分钟；均导出供 Feature 3 finalize 复用）
  ~30min
- [ ] T-005: `upsertExperience()` 主流程（脱敏→计算 id/hash→加锁→比对
  已有文件→去重累加/版本递增→**落盘前 `assertStillHeld()`**→**先复制
  归档旧内容到 `.superseded/`、再 `atomicWriteExperience()` 覆盖规范
  路径**（顺序不能反——见 design.md 的 Codex Review 修正记录，反过来
  会在归档后、新版本写入前崩溃时导致规范文件消失）→释放锁）；
  `LockLostError` 时不写入任何文件 ~30min

### 功能 4: 生命周期状态机

- [ ] T-006: `transition()` + `canVerify()`（`lifecycle.ts`），非法状态
  转换必须抛出明确错误 ~15min

### 集成与测试

- [ ] T-007: `node:test` 单元测试覆盖 AC-001~AC-008 及 AC-007b/AC-007c/
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
