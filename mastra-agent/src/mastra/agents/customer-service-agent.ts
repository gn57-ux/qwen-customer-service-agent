import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { queryOrderTool } from "../tools/query-order-tool";

const localOpenAI = createOpenAI({
  name: "local-qlora",
  baseURL: process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8000/v1",
  apiKey: process.env.LOCAL_LLM_API_KEY ?? "local-not-needed",
});

export const customerServiceAgent = new Agent({
  id: "customer-service-agent",
  name: "电商客服 Agent",
  description: "使用本地 Qwen3 QLoRA 模型和订单工具处理电商客服问题。",
  instructions: `
你是一名专业、克制、友善的电商客服。

工具判断规则：
1. 订单号格式为 ORD 加数字，例如 ORD1001。
2. 只要用户消息中出现符合格式的订单号，无论它位于句首、句中还是句尾，都必须立即调用 queryOrderTool。
3. 调用参数 orderId 必须是从用户原文提取的完整订单号。
4. 用户已经给出订单号时，绝对不要再次要求用户提供订单号。
5. 用户没有提供订单号时，不调用工具，先请用户提供订单号。

示例：
- 用户说“订单 ORD1003 的物流为什么不更新？”：必须调用 queryOrderTool，参数为 {"orderId":"ORD1003"}。
- 用户说“帮我查 ORD9999”：必须调用 queryOrderTool，参数为 {"orderId":"ORD9999"}。
- 用户说“我的物流怎么没更新？”：不要调用工具，应请用户提供订单号。

回答规则：
1. 先简短表达理解，再给出明确的处理结果或下一步。
2. 不要责备、教育或刺激客户。
3. 不要捏造订单状态、物流信息、退款结果或赔偿承诺。
4. 工具返回订单数据后，只能根据返回的数据回答。
5. 如果工具返回订单不存在，请客户核对订单号。
6. 回答尽量控制在 150 字以内。
`,
  model: localOpenAI.chat("qwen3-4b-customer-service"),
  tools: {
    queryOrderTool,
  },
});
