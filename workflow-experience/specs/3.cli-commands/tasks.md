# Feature 3: cli-commands — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 新增 CLI 层
- specs 路径: workflow-experience/specs/3.cli-commands/

## 任务列表

### 功能 1: 摄取与检索命令

- [ ] T-001: `experience-ingest.ts`（含 `--rebuild` 分支）+
  `package.json` 接线 `experience:ingest`/`experience:rebuild` ~30min
- [ ] T-002: `experience-search.ts` + `package.json` 接线
  `experience:search` ~15min

### 功能 2: 巡检命令

- [ ] T-003: `experience-status.ts`（三项服务连通性 + 经验数量统计）+
  接线 `experience:status` ~30min
- [ ] T-004: `experience-audit.ts`（frontmatter 校验/脱敏扫描/孤儿文件/
  悬空向量点，只读不改）+ 接线 `experience:audit` ~30min

### 功能 3: finalize 与自检

- [ ] T-005: `experience-finalize.ts`（JSON 输入、逐候选晋升判定、
  payload 局部更新、统计输出）+ 接线 `experience:finalize` ~30min
- [ ] T-006: `experience:test` 接线（聚合 Feature 1/2/3 全部
  `*.test.ts`） ~15min

### 集成与测试

- [ ] T-007: 中文路径 + 环境变量覆盖 + 目录缺失不影响宿主项目 的
  可移植性测试，覆盖 AC-001~AC-003 ~30min
- [ ] T-008: finalize 晋升/保留 candidate 的端到端测试 + audit 脱敏
  报告不回显原文的测试，覆盖 AC-004~AC-006 ~30min

## 依赖关系

- T-001 依赖 Feature 2 全部完成（T-001~T-008）
- T-002 依赖 T-001（需要有数据可搜）
- T-003、T-004 依赖 T-001
- T-005 依赖 T-001、Feature 1 的 `canVerify`/`transition`
- T-006 依赖 T-001~T-005（需要有测试文件可聚合）
- T-007、T-008 依赖 T-001~T-006 全部完成

## 风险点

- `experience:finalize` 的 payload 局部更新依赖 Qdrant 原生 REST
  的 `points/payload` 接口，若 `QdrantVector` 未来版本行为有变化需要
  重新核实该接口路径与请求格式（与 `store.ts` 里其他"原生 REST 补充"
  操作同类风险）。
- 中文路径测试需要在真实的 `/Users/ruolan/Documents/ai客服` 路径下跑，
  不能只在临时英文路径下测试后就假设通过——这正是本项目自身路径就是
  最佳测试环境的原因。
