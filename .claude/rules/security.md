---
description: 密钥与敏感信息处理规范（从 .gitignore 与本地服务架构推断）
---

# 安全规范

- 所有密钥/环境变量放在 `.env`（各包目录下），`.gitignore` 已排除
  `.env`/`*.env`，仅保留 `.env.example` 作为模板——新增环境变量必须
  同步更新对应的 `.env.example`，⛔ 禁止把真实密钥写进 `.env.example`
  或提交历史。
- 本项目所有推理/RAG 服务均为本地进程（llama-server/FastAPI/Qdrant/
  Ollama/Reranker），当前不涉及第三方 API Key；如未来接入外部服务
  （云端模型、短信/邮件等），密钥一律走环境变量，不硬编码进源码。
- 前端 `web-client` 不持有任何密钥——它只允许访问 Mastra 服务
  （`:4111`），⛔ 禁止在前端代码中出现下游服务的地址、端口或凭据
  （见 `.claude/rules/frontend-conventions.md` 的直连扫描规则）。
- 服务状态探测接口（`GET /customer-service/status`）刻意脱敏，不返回
  内部地址、端口号或堆栈信息——新增探测字段时延续这个约束。
