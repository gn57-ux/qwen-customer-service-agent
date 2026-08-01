---
description: Git 提交与分支规范（从提交历史推断）
---

# Git 工作流

- 提交信息遵循 Conventional Commits 前缀：`feat:`/`fix:`/`docs:`/
  `refactor:`/`test:` 等，一句话概括改动的"为什么"而不是逐条列改了
  什么文件（见 `git log --oneline` 的历史提交风格）。
- 每个 Feature/修复对应一个或一组独立提交，不与无关改动混在一起；
  文档同步（README/CLAUDE.md/rules/specs CHANGELOG）通常单独提交
  （`docs:` 前缀），不与功能改动混在同一个提交里。
- 当前开发分支为 `agent/commercial-training-and-web-guide`，⛔ 默认不
  push、不合并 `main`，除非用户明确授权。
- 暂存改动时按精确文件清单显式 `git add <file>...`，⛔ 禁止
  `git add -A`/`git add .`，避免误把未预期的运行时文件或临时脚本
  纳入提交。
