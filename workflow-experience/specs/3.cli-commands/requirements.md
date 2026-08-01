# Feature 3: cli-commands — 需求规格

## 概述

提供 `experience:{ingest,search,test,status,audit,rebuild,finalize}` 七个
稳定 CLI 命令，作为全局 `~/.claude` 工作流（未来）调用的唯一入口，并保证
可移植性：不依赖固定用户名/路径、支持中文路径、环境变量可覆盖、找不到
经验子系统配置时不影响宿主项目的原有 `yd` 工作流。

## 项目信息

- 项目名: ai-kefu-workflow-experience
- 架构类型: monorepo 内新增子模块，依赖 Feature 1、Feature 2

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-08-01 | v1 | 初始需求 |

## 用户故事

- 作为全局工作流（未来接线时），我想要一个稳定的命令行入口而不是要
  维护多份复制粘贴的业务逻辑，以便逻辑变更只需要改一处。
- 作为在新项目里第一次使用 `yd:ai` 的用户，我想要没配置经验子系统时
  原有工作流完全不受影响，以便升级/迁移零风险。
- 作为运维者，我想要 `experience:status`/`experience:audit` 能快速看到
  经验库健康状况，而不需要直接查 Qdrant。

## 功能需求

1. [F-001] `experience:ingest [--rebuild]`：批量摄取 `knowledge/experience/
   **/*.md` 到 Qdrant（`--rebuild` 时先清空当前 collection 再全量重建，
   对应 `experience:rebuild` 别名，二者共享实现）。
2. [F-002] `experience:search --query "..." --stage execute [--task-type
   backend] [--project-scope xxx]`：命令行直接调用 Feature 2 的
   `retrieveExperience()`，打印格式化结果，用于人工调试检索效果。
3. [F-003] `experience:test`：跑本 feature 及 Feature 1/2 的全部自动化
   测试（`node:test`），作为 CI/Stop Hook 之外的独立自检入口。
4. [F-004] `experience:status`：打印经验库健康状况——Qdrant/Embedding/
   Reranker 三项连通性、`claude_workflow_experience` collection 点数、
   按 `status` 分组的经验数量（candidate/verified/deprecated）。
5. [F-005] `experience:audit`：只读巡检——扫描 `knowledge/experience/**`
   下所有 Markdown，报告 frontmatter 校验失败、孤儿文件（存在但未入
   Qdrant）、悬空向量点（Qdrant 有点但对应文件已删除）、可能违反脱敏
   规则的内容（复用 Feature 1 `redact()` 的扫描逻辑，只报告不修改）。
6. [F-006] `experience:finalize`：**仅供 N8 集成调用**的命令——接收
   "本轮 Codex Review 最终结论 + 测试结果"作为参数/输入，只有明确
   ALLOW 时才把候选经验从 `candidate` 转 `verified` 并触发向量重新
   索引（`status` 变更需要更新已有向量点的 payload，不需要重新
   embedding 正文）；非 ALLOW 时保留 `candidate`，不污染 verified 检索，
   同时打印本轮"新增/更新/复用/淘汰"的经验统计（复用 Feature 1 的
   occurrence_count/document_version 变化来推断"复用"vs"新增"）。
7. [F-007] 找不到经验子系统配置（如 Qdrant 不可达、`knowledge/experience/`
   目录不存在）时，除 `experience:*` 命令自身报错外，**不得影响**
   直接调用 `mastra-agent` 其他现有命令（`npm run dev`/`npm test` 等）
   ——这是隔离性要求，不是本 feature 需要新写代码的功能点，而是"确保
   新增文件/依赖不产生副作用"的验证项。
8. [F-008] 所有命令支持通过环境变量覆盖服务地址（复用 `rag/config.ts`
   已有的 `QDRANT_URL`/`EMBEDDING_BASE_URL` 等），新增的经验专属变量
   （`EXPERIENCE_QDRANT_COLLECTION` 等）同样遵循"有默认值、可覆盖"模式，
   不硬编码任何绝对路径或用户名。

## 非功能需求

- 性能: `experience:status`/`experience:audit` 应在 10 秒内给出结果
  （不含大规模全量 embedding 重建的 `--rebuild` 场景）。
- 安全: `experience:audit` 的脱敏扫描报告本身不得在输出中回显被扫描出
  的敏感内容原文（只报告"第几行命中了哪类规则"，不回显匹配到的具体
  字符串）。
- 兼容性: 全部命令必须能在路径含中文的项目下正常运行（本仓库自身
  `/Users/ruolan/Documents/ai客服` 就是中文路径，是最直接的验证场景）；
  不依赖 `os.userInfo().username` 之外的任何用户名硬编码。

## 验收标准

- [ ] [AC-001] 在含中文的项目路径下运行全部 7 个命令，均不因路径编码
  问题报错。
- [ ] [AC-002] 设置 `EXPERIENCE_QDRANT_COLLECTION=test_override` 后运行
  `experience:status`，报告的 collection 名确实是覆盖值，不是默认值。
- [ ] [AC-003] 删除/重命名 `knowledge/experience/` 目录后运行
  `mastra-agent` 现有的 `npm test`（客服知识库测试），全部通过，不受
  经验目录缺失影响。
- [ ] [AC-004] `experience:finalize` 收到非 ALLOW 结论时，对应候选经验
  的 `status` 字段保持 `candidate`，不会出现在 `experience:search` 的
  默认（`status=verified`）检索结果里。
- [ ] [AC-005] `experience:finalize` 收到 ALLOW 结论且测试通过证据齐全
  时，候选经验 `status` 变为 `verified`，随后 `experience:search` 能
  检索到它。
- [ ] [AC-006] `experience:audit` 的输出不包含任何完整的敏感字符串
  原文（人工审查报告文本确认）。

## 依赖

- Feature 1（数据模型、写入、生命周期状态机）。
- Feature 2（存储、检索、摄取管线）。

## 开放问题

- 无。
