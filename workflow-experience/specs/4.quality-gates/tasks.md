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

- [ ] T-001: 编写 `quality-gates.test.ts` 头部对照表（22 项清单 →
  具体测试文件+用例名的映射），作为可执行的"文档" ~15min

### 功能 2: 跨模块新增测试

- [ ] T-002: Hook 重入/并发 finalize 测试（不同 ID 互不阻塞、相同 ID
  正确串行且第二次调用通过 `transitionIdempotent` 幂等收敛，不抛错也
  不重复变更） ~30min
- [ ] T-003: 超时验证测试（假慢速 HTTP server + 环境变量调小超时） ~30min
- [ ] T-004: AGENTS.md 不变性测试（前后快照哈希对比） ~15min
- [ ] T-005: 无配置降级测试（mock 环境变量指向不可达服务） ~30min

### 集成与测试

- [ ] T-006: `experience:test:live` 命令接线（聚合需要真实服务的用例，
  对齐 `agent:test:live` 命名习惯），确认与 `experience:test`（纯逻辑）
  的分层边界清晰 ~15min

## 依赖关系

- T-001 依赖 Feature 1、2、3 全部完成（需要引用其测试文件）
- T-002~T-005 可并行（各自独立场景，无共享文件）
- T-006 依赖 T-002~T-005

## 风险点

- "语义相似但非完全相同"的去重明确定义为不适用范围（见
  requirements.md 功能需求第 4 条），如果后续用户期望更智能的语义
  去重，需要回到 Feature 2 设计阶段重新评估，不应该在本 feature 里
  临时加一个简化版语义相似度判断（会造成两处去重逻辑并存的混乱）。
