---
description: 代码风格规范（从项目现有 TS 源码与提交历史推断，非通用模板）
globs: mastra-agent/src/**/*.ts,web-client/src/**/*.ts,web-client/src/**/*.tsx
---

# 代码风格

- 全项目 TypeScript，`.ts`/`.tsx` 均使用显式扩展名的相对导入
  （`import { x } from "./y.ts"`），与 `tsx`/Node ESM 运行方式保持一致，
  不要省略扩展名。
- 无 ESLint/Prettier 配置文件——风格约束落在 `tsc --noEmit`（类型检查）
  和 `.claude/rules/frontend-conventions.md`（前端专项约定）上，改动前
  先看现有同类文件的缩进/引号/分号风格并保持一致，不要引入新的格式化
  工具或规则。
- 注释只在"为什么"非显而易见时写（架构决策、真实请求验证过的踩坑、
  刻意的取舍），不写复述代码在做什么的注释——参考
  `mastra-agent/src/mastra/orchestration.ts` 顶部注释的写法。
- 服务端使用 `node:test` 原生断言（`node:assert/strict`），不引入
  Jest/Mocha 等第三方测试框架；前端使用 Vitest + Testing Library。
