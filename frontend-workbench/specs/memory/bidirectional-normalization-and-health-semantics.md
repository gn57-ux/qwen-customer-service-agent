---
title: 归一化比较要双向做；第三方健康检查端点别默认"HTTP 2xx=健康"
feature: 2.service-status-endpoint
type: reusable
tags: [normalization, health-check, ollama, fastapi, probe, testing]
date: 2026-07-31
---

**问题/场景 1（归一化单侧遗漏）**：`matchesModelName(id, target)` 要判断 Ollama
`/v1/models` 返回的模型 id（可能带 `:tag`，如 `bge-m3:latest`）是否对应配置里的
`embeddingModel`（通常不带 tag，如 `bge-m3`）。第一版只对 `id` 做 `split(":")[0]`
归一化，没对 `target` 做同样处理。因为多数情况下 target 确实不带 tag，实测能通过，
但 CR 用 `("bge-m3:latest", "bge-m3:latest")`（两侧都带相同 tag）和
`("bge-m3", "bge-m3:latest")`（target 侧带 tag）两个用例证伪了这个假设——单侧归一化
在这两种输入下都会给出错误结果。

**问题/场景 2（健康检查语义）**：FastAPI 的 `/health` 端点在服务"进程活着但模型没
加载完成/降级"（`status: "not_loaded"` / `"degraded"`）时依然返回 **HTTP 200**，
只有解析响应体里的业务字段 `status` 才能判断真实可用性。如果探测逻辑只判断
`response.ok`（即 2xx），会把"活着但不可用"误判为健康。

**解法/结论**：
1. 写任何"比较两个可能格式不一致的字符串"的归一化逻辑时，默认假设**两侧都可能是
   未归一化的原始输入**，除非有明确证据证明某一侧永远是规范形式。用同一个归一化
   函数处理两侧（本例：`modelBaseName(value)` 分别应用于 `id` 和 `target`），
   而不是只处理其中一侧。
2. 补测试时要专门构造"两侧都需要归一化"的组合（不只是"一侧脏一侧干净"），否则
   遗漏会像本例一样在最常见的输入分布下被掩盖，只在边界组合才暴露。
3. 探测第三方服务健康状态时，**先读该服务健康端点的真实实现**，不要默认
   "HTTP 2xx = 健康"。如果它会用 200 + 业务字段表达"不健康"（很多生产级服务是
   这么设计的，避免探测本身触发告警噪音），必须解析 body。
4. "解析第三方健康响应"这段逻辑值得提取成不发真实请求的纯函数（如
   `parseFastApiHealthStatus(httpOk, body)`），既能对"HTTP 200 但业务状态异常"
   这种组合分支写确定性测试，也不需要为了测试导出内部 URL 常量或起真实服务
   ——用 `httpOk: boolean` 而不是 `Response` 对象作为参数，测试不需要构造假的
   `Response`。

**复用方式**：Feature 8 的门禁审计、后续任何新增探测器（如未来给 orderService
也做类似的 body-level 判定）都应遵循同一模式：归一化双向做、健康检查读服务端真实
实现而非猜测、判定逻辑提取为纯函数便于测试。
