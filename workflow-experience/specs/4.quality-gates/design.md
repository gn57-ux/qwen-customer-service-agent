# Feature 4: quality-gates — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始设计 |

## 项目架构

- 架构类型: 测试聚合层，不新增业务代码，只新增测试文件
- 涉及层: 测试（`node:test`），部分用例需要真实服务（Qdrant/Ollama/
  Reranker），归入 `experience:test:live`，与现有 `agent:test:live`
  的分层策略一致

## 功能模块设计

### 模块 1: 索引测试（`mastra-agent/src/experience/quality-gates.test.ts`）

不新增业务逻辑，而是**引用**Feature 1-3 已实现的函数，针对"用户 22 项
清单"里编号 1-15、18/19/21 这些已被其他 feature 的 AC 覆盖的项，在本文件
里写一个"清单对照表"式的说明性测试套件（`describe.skip` 或纯注释链接到
对应 `*.test.ts` 的具体 `it()`），**不重复实现同样的断言**，避免同一逻辑
维护两份容易漂移的测试。

```ts
/**
 * 本文件不重复 Feature 1/2/3 已覆盖的测试，只新增跨模块/边界场景
 * （F-001~F-004，对应用户 22 项清单里编号 16/17/20/22）。
 * 清单编号 1-15、18/19/21 的对照关系见 requirements.md。
 */
```

### 模块 2: Hook 重入与并发（F-001）

```ts
// 并发调用两次 finalize，分别处理不同/相同的候选 document_id，
// 用 Promise.all 真实并发触发（不是 mock 出并发），断言：
// - 不同 ID：两次都成功，各自 status 正确变为 verified
// - 相同 ID：锁生效，第二个调用等待第一个释放锁后才执行；此时候选
//   status 已被第一个调用转为 verified，第二个调用用
//   transitionIdempotent(verified, "verified") 识别为已达目标状态，
//   直接返回、不抛错、不重复递增 occurrence_count/document_version
//   ——不能断言"两次都执行了真正的状态转换"（verified→verified 本身
//   是状态机拒绝的非法转换，只有幂等包装层会放行）。
```

### 模块 3: 超时验证（F-002）

复用 `rag/embedding.ts`/`rag/rerank.ts` 已有的 `AbortSignal.timeout()`
机制——测试策略是**用一个假的、故意慢响应的 HTTP server**（Node 内置
`http.createServer`，不引入 mock 框架）替换 embedding/rerank 的
baseUrl，验证超时错误按预期时间抛出，而不是真的等待生产环境的超时
时长（测试里可以通过环境变量把超时调小，如 200ms，验证机制生效即可，
不需要真的等 120s）。

### 模块 4: AGENTS.md 不变性（F-003）

```ts
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

function agentsSnapshot(repoRoot: string) {
  const p = path.join(repoRoot, "AGENTS.md");
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
// 运行前后各拍一次快照，断言相等（或都是 null）。
```

### 模块 5: 无配置降级（F-004）

用 `node:test` 的 `t.mock` 或临时环境变量覆盖（`EXPERIENCE_QDRANT_
COLLECTION` 指向一个刻意不存在/不可达的地址），验证
`experience-status.ts` 的核心检测函数返回"未配置/不可达"而不是抛出，
不需要真的新建一个物理临时目录宿主项目（那属于集成测试范畴，超出
"验证代码降级路径"这个具体目标所需的复杂度）。

## 接口契约

本 feature 不新增对外接口，纯测试文件。

## 数据模型

无新增。

## 安全考虑

- 测试中构造的"敏感信息样例"（用于验证脱敏规则命中）必须是**明显的
  假数据**（如 `sk-test-000000000000000000`），不得使用任何真实凭据
  格式之外的、容易被误认成真实泄露的字符串——测试断言之后要清理这些
  字符串，不残留在测试输出日志中超出必要范围。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 是否重复实现已被其他 feature 覆盖的断言 | 重复 vs 引用+说明 | 引用+说明——避免同一逻辑两处维护、容易漂移 |
| 慢响应测试用真实慢服务 vs 假 HTTP server | 假 HTTP server（Node 内置） | 不引入新依赖、可精确控制延迟、不依赖真实网络环境 |
| 无配置降级测试用真实临时目录 vs mock 环境变量 | mock 环境变量 | 更聚焦被测目标（降级判断逻辑本身），减少测试基础设施复杂度 |
