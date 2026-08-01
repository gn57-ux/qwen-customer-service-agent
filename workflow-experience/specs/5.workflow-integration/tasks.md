# Feature 5: workflow-integration — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始任务 |

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: 文档 + 只读分析脚本
- specs 路径: workflow-experience/specs/5.workflow-integration/

## 任务列表

### 功能 1: 文档

- [ ] T-001: `mastra-agent/README-EXPERIENCE.md` 架构章节 + Collection
  对照表 + 命令一览 ~30min
- [ ] T-002: N1-N8 逐节点建议接入点示例（同一文件章节）+ 边界声明
  ~15min
- [ ] T-003: `.claude/CLAUDE.md` 追加一行引用（只增不改） ~5min

### 功能 2: 候选规则生成器

- [ ] T-004: `experience-suggest-rules.ts`（复用 audit 的文件扫描 +
  Feature 1 的 redact/原子写入），输出到 `workflow-experience/
  suggested-rules/`（**不在** `knowledge/experience/` 摄取根目录下，
  避免被 `experience:ingest`/`rebuild`/`audit` 误扫描，见 design.md
  的 Codex Review 修正记录） ~30min

### 集成与测试

- [ ] T-005: AGENTS.md 不变性测试（同 4.T-004 模式，独立断言本 feature
  的生成器不触碰它）+ 阈值过滤正确性测试（AC-003）+ `blocked` 内容
  排除测试（AC-005：含 Token 样式字符串的候选被跳过、不回显原文）
  ~30min

## 依赖关系

- T-001、T-002 依赖 Feature 3 全部完成（文档要准确描述真实存在的命令）
- T-003 可独立执行
- T-004 依赖 Feature 1、Feature 3（复用 audit 的扫描逻辑，需其先存在）
- T-005 依赖 T-004

## 风险点

- 文档类任务容易随代码演进过时——建议在 Feature 1-3 后续如有接口签名
  变化时，同步检查本 feature 产出的文档是否需要更新（不在本 feature
  当前范围内新增自动化文档一致性检查，属于可接受的手工维护成本）。
