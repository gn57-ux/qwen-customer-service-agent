---
title: 发现 specs 与真实架构不符时，必须改权威 requirements/design，不能只记在 tasks.md
feature: 2.service-status-endpoint
type: pitfall
tags: [specs, requirements, design, tasks, documentation, review, service-status]
date: 2026-07-31
---

**问题/场景**：`2.service-status-endpoint` 的 `design.md` 字面写着 `probeLlamaServer` 探测
"llama-server :8002"。实现时读码发现真相相反：`agents/customer-service-agent.ts` 顶部注释
明确写"8002 只在 FastAPI 进程内部转发，不应该被任何客户端直接访问"，真正该探测的是
FastAPI 的 `:8000/health`。第一轮我把实现改对了，但只在 `tasks.md` 的版本记录里写了一句
"实现期发现的偏差"，没有回头改 `requirements.md`/`design.md`。Stop hook CR 明确打回：
这样后续 Feature 4（消费 status 的顶栏展示）、Feature 8（验收门禁）如果只读
requirements.md/design.md（这两个文件才是"规格"，tasks.md 只是执行记录），会继续按
错误口径去实现或验收，而 tasks.md 的只言片语很容易被忽略。

**解法/结论**：当实现阶段发现 specs 有错误或与真实代码不符时，修复流程必须包含：
1. 先用实现验证真相（读码、跑测试、连真实服务复现）；
2. **把 requirements.md 与 design.md 也改成新版本**——追加版本号行，说明改了什么、为什么改、
   原来写的是什么（不要直接删掉旧描述，用 `[vN 修正]` 标注，保留可追溯性）；
3. `tasks.md`/`LESSONS.md` 只负责记录"这个过程中发生了什么"，不能替代"当前权威规格是什么"；
4. 如果 `PLAN.md` 有"关键前置事实"这类跨 feature 复用的表格，也要把结论写进去，
   让后续 feature 不需要重新踩一遍。

**复用方式**：任何 feature 实现阶段发现 specs 描述与真实系统行为不符（端口、字段名、
调用路径、契约形状……），都按上面 4 步处理，不要满足于"代码对了就行"——specs 是后续
feature 与验收的唯一依据，代码本身不会被下一个 feature 的开发者读到。
