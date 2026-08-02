# N8: 完成

所有 feature 的所有任务完成后：

## 1. 调用 yd-doc-syncer

调用 `yd-doc-syncer` skill 完成文档同步：

- README 精炼更新（架构 + 业务 + 快速开始）
- .claude/CLAUDE.md 和 rules/ 同步
- specs CHANGELOG 按日期生成
- 文档一致性验证

## 2. 工作流经验 RAG — 候选晋升（finalize，可选）

把本次运行中 N5 累积的跨项目经验候选，一次性晋升为可被检索的 `verified` 状态。**只在候选存在时才执行；没有候选或子系统不可用不得阻塞总结输出。**

1. `YD_EXPERIENCE_REPO` 未设置，或 `{SPECS_DIR}/.experience-pending.jsonl` 不存在/为空 → 跳过本节，直接进入「3. 输出总结」，**不输出提示**（没有候选是正常状态，不是降级，不需要提示用户）。
2. 已配置且候选非空时，读取该文件的全部 `document_id`（去重），构造 `FinalizeInput` 写入临时文件（**不要用 `<(...)` 进程替换**——`npm run` 转发子进程时 fd 不总能存活到 `node` 读取的时刻，实测会报 `Unexpected end of JSON input`；用 Write 工具写一个真实临时文件最可靠）并调用：
   ```json
   {"codexVerdict":"ALLOW","testsPassed":true,"privacyOrSecretHit":false,"candidateDocumentIds":[{候选 document_id 列表}],"evidence":{"before":"{本次运行前的问题/起点，一句话}","after":"全部 Feature 完成，各 task 均已通过 N4 的 yd-code-reviewer + Codex Review 双重审查（ALLOW）"}}
   ```
   ```bash
   cd "$YD_EXPERIENCE_REPO/mastra-agent" && npm run experience:finalize -- --input {临时文件路径}
   ```
   - `codexVerdict`/`testsPassed` 固定为 `ALLOW`/`true`——本次运行里每个被标记 `[x]` 的 task 都已在 N4 拿到 `CODEX_REVIEW_ALLOW` 才能走到这里，不存在"带着 BLOCK 的 task 混进候选列表"的情况。
   - `privacyOrSecretHit` 固定 `false`——候选内容在 N5 `experience:write` 阶段已经过 Feature 1 的强制脱敏，命中会在写入时直接被拒绝（不会进入 `.experience-pending.jsonl`）。
3. **命令退出码非 0**（含"部分候选仍是 `not_found`/`lock_lost`/`vectors_missing` 等未决状态"、命令报错、连接失败等一切失败形态）→ 输出一次固定提示：`经验增强本次不可用，已跳过，不影响当前工作流。`（不输出机器路径、端口、堆栈、环境变量值或命令的原始错误文本），不重试、不暂停、不影响总结输出；**`.experience-pending.jsonl` 保留不删除**——这些候选下次任意项目跑 N8 时会被重新尝试，不会丢失引用。
4. **退出码为 0**（本批候选全部拿到已解决的终态：晋升成功/本来就是 verified/因生命周期规则合法拒绝）→ **执行成功后删除** `{SPECS_DIR}/.experience-pending.jsonl`（这批已经处理完，不需要保留）。
5. 成功时输出：`🌐 跨项目经验晋升：新增 verified {n} 条`（数字取自命令输出的"新增 verified"行）。

## 3. 输出总结

```text
🎉 全部完成

📂 Features: {完成数}/{总数}
📋 总任务: {完成数}/{总数}
📝 文档同步: 已完成

各 Feature 摘要:
- 1.{name}: {N} 个任务 ✅
- 2.{name}: {N} 个任务 ✅
```
