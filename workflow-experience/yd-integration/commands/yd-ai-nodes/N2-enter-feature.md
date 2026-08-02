# N2: 进入 Feature

1. 读取该 feature 的 requirements.md、design.md、tasks.md
2. 断点恢复：`[x]` 已完成 → 跳过，`[DROPPED]` → 跳过，`[CHANGED]` → 按更新后描述执行
3. 如该 feature 所有任务已完成 → 跳过，进入下一个 feature

## 任务数检查（强制）

读取 tasks.md 后，统计未完成任务数（`[ ]` 的行）：

- **≤8 个** → 正常执行
- **>8 个** → 自动拆分：
  1. 保留前 8 个任务在当前 tasks.md
  2. 将剩余任务写入新 feature 目录 `{N+0.5}.{feature-name}-part2/`（编号取当前最大编号+1）
  3. 新目录复制当前的 requirements.md 和 design.md，tasks.md 只含剩余任务
  4. 输出提示：`⚠️ 任务数超出上限，已自动拆分为 {新feature目录名}`
  5. 继续执行当前 feature

## Learning Loop — 检索 Memory（读端）

判难度前，先由主 claude（Queen）检索历史经验注入上下文。这是自学习闭环的「读」端，对应 N5 的「写」端。

1. 读取 `{SPECS_DIR}/memory/INDEX.md`
2. 用本 feature 的关键词（模块名 / 技术栈 / 涉及的 API、schema / 已知风险点）匹配索引行的 tags 与钩子
3. 命中的条目读取其 `memory/{slug}.md` 全文，注入当前上下文
4. **索引未命中 → 降级全文检索**：索引行很短，「换了说法的同类坑」（如索引写 `auth` 正文才提 `登录态`）只有正文能搜到。用 Grep 在 `memory/*.md` 正文里搜同一批关键词及其常见同义改写（中英互换、缩写展开），命中的文件同样全文注入
5. 无 `memory/` 目录，或两级检索都无命中 → 跳过，不阻塞（首次运行、或该主题此前无踩坑记录时属正常情况）

输出命中提示：`🧠 Memory 命中 {n} 条历史经验：{标题列表}`（0 条则 `🧠 Memory 无相关经验`）。

> 与 N1 已加载的 `LESSONS.md`（全量、按时间顺序的踩坑日志）互补：LESSONS.md 面向"整个项目的通读上下文"，这里的 Memory 面向"和当前 feature 主题精确相关"的检索，专供 Router 判难度和后续开发参考。

## 工作流经验 RAG — 跨项目检索（读端，可选，与上方 Memory 互不替代）

上方 Memory 是**本 specs 目录内**的经验（`{SPECS_DIR}/memory/`）；这里额外检索**跨项目**的经验库（独立仓库，独立 Qdrant Collection，见 `YD_EXPERIENCE_REPO` 说明），把其它项目里验证过的踩坑/决策也纳入参考。**整个子系统是可选增强，不可用时必须直接跳过，不得阻塞或拖慢主流程。**

1. **前置判断**：检查环境变量 `YD_EXPERIENCE_REPO` 是否已设置且指向的目录下存在 `mastra-agent/package.json`。
   - 未设置或路径不存在 → 输出一次标准降级提示（见下方「降级提示」），跳过本节其余步骤。
2. 已配置时，执行：
   ```bash
   cd "$YD_EXPERIENCE_REPO/mastra-agent" && npm run experience:search -- \
     --query "{本 feature 名称 + 当前 task 关键信息，1-2 句话}" \
     --stage execute \
     --project-scope "{PROJECT_NAME，kebab-case}"
   ```
   （能判断出工种时可加 `--task-type frontend/backend/database`，判断不出就不加，不强行猜测。）
3. **超时/非零退出/命令报错** → 输出一次标准降级提示，继续 N2 后续步骤，不重试、不暂停。
4. 成功且召回非空 → 把输出的经验文本作为**补充参考**（不覆盖、不替代上方 Memory 和 `LESSONS.md`）纳入本次判难度和开发的上下文。
5. 成功但召回为空 → 不输出提示（零结果是正常检索结果，不是降级）。
6. 输出命中提示（仅在召回非空时输出）：`🌐 跨项目经验命中 {n} 条`。

**降级提示**（本节及 N5/N8/`/yd:prd`/`/yd:init` 的同类接入点统一用这一条，每次触发只输出一次，**不得**包含机器路径、端口、堆栈、环境变量的值或命令的原始报错文本）：
```text
经验增强本次不可用，已跳过，不影响当前工作流。
```

> 这条通道只读不写：N2 不会创建、修改任何经验文档，也不会主动装 Embedding/Qdrant 等依赖——完全依赖 `YD_EXPERIENCE_REPO` 指向的仓库自带的运行环境。

## Router — 逐 Feature 判难度（核心）

**每个 feature 第一次进入 N2 时，主 claude（Queen）判一次难度**，动态选执行路径；注入的 Memory 经验参与判定（历史踩坑会抬高难度）。同一 feature 内后续 task 循环回到 N2 时**沿用第一次的判定，不重复判**。判完**始终回 Queen 收口**，subagent 无权自行决定路径。

| 档 | 判定特征 | 执行路径 |
| -- | -------- | -------- |
| **低** | 单文件 / 低风险 / 无跨模块 / 无 schema·API 变更 | **正常执行**：主 claude inline 直接做完，跳过下方「执行计划」与 N3，做完进 N4 |
| **中 / 高** | 多 task / 同一或少量项目 / 中高风险 / 有依赖 / 涉及共享 schema·API | **`/goal`**：交给 `/goal` 工作流执行（写代码先停，Stop hook 跑 codex review 门禁，过了才提交），完成后进 N4 |
| **极复杂** | 多模块 + 多项目 + 高风险 / 大范围重构 / 跨服务联动 | **ultracode**：进 N3，走下方「执行计划」并行派发，或调用 `yd-ai-wf` dynamic workflow（方式见 N3） |

输出判定：`🧭 Router 判定：{低/中/高/极复杂} — {一句理由} → 走 {正常执行 / goal / ultracode}`。

无论哪档，**判完始终回 Queen 收口**：低/中高档做完直接进 N4；极复杂档经 N3 后再进 N4。

## 执行计划

> 仅 Router 判定为**极复杂档（ultracode）**时执行——拆 task 并行派发 subagent，或整体交给 `yd-ai-wf` dynamic workflow（N3 方式 B）。
> 低档主 claude 直接做；中/高档交 `/goal`，均不走此段、也不进 N3。

分析 tasks.md 的依赖关系，自行决定串行或并行：

| 串行 | 并行 |
| ---- | ---- |
| 有显式依赖 | 无依赖 |
| 会修改同一文件/模块 | 分属不同代码项目 |
| 涉及共享状态定义（schema、API） | 天然隔离 |

并行时用 Agent 工具派发**角色化 subagent**（优先使用 `~/.claude/agents/`；项目内分发版本在 `agents/`，安装时应同步到 `.claude/agents/`），按工种选择 `subagent_type`：

| 工种 | subagent_type | 何时派发 |
| ---- | ------------- | -------- |
| 前端 | `yd-frontend-engineer` | 前端页面/组件 task |
| 后端 | `yd-backend-engineer` | API/procedure、认证、服务端业务 task |
| 数据库 | `yd-database-engineer` | schema/migration/查询层 task |

派发时在 prompt 里务必传齐：**specs 路径、本次 task 编号与描述、代码项目路径**（subagent 是冷启动，要靠这些自行加载上下文）。每个 subagent 内部会加载同名 `yd-*` skill 执行，并在最终消息回报「文件清单 + 验证结果 + 待配合事项」。

所有任务都有依赖时退化为全串行（此时不派 subagent，在主流程 inline 调用 skill）。

输出：

```text
📂 Feature {N}/{总数} — {feature名}
📋 执行计划：
  串行 1: T-001 → T-002
  并行 2: T-003 + T-004
  串行 3: T-005 ← 依赖 T-003, T-004
```
