import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";

import { queryOrderTool } from "../tools/query-order-tool.ts";
import { searchKnowledgeBaseTool } from "../tools/search-knowledge-base-tool.ts";

/**
 * 生成模型必须走 FastAPI 的 OpenAI 兼容接口（services/app.py，默认 8000），
 * 不允许直连内部 llama-server（8002）——8002 只在 FastAPI 进程内部转发，
 * 不应该被任何客户端直接访问。
 */
export const LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8000/v1";

/**
 * model 字段目前不影响 FastAPI 路由（services/app.py 的 ChatCompletionRequest.model
 * 只透传展示，不用于选择后端），但保留可配置以避免与 FastAPI 实际加载的
 * MODEL_NAME 混淆。
 */
export const MODEL_NAME = process.env.LOCAL_LLM_MODEL_NAME ?? "qwen3-8b-customer-service-production-v1";

const localOpenAI = createOpenAI({
  name: "local-fastapi",
  baseURL: LOCAL_LLM_BASE_URL,
  apiKey: process.env.LOCAL_LLM_API_KEY ?? "local-not-needed",
});

/**
 * System Prompt：不再教模型"输出 <tool_call> 标签"这种格式细节——llama-server
 * 对这个模型能原生支持 OpenAI 标准 function-calling（给定请求里的 tools 后，
 * 用语法约束解码直接产出结构化 message.tool_calls，finish_reason=tool_calls，
 * 已用真实请求核实，见 README-AGENT.md），格式由 Mastra/llama-server 处理，
 * Prompt 只需要说清楚业务上"什么时候该用哪个工具"。
 *
 * 保持简短、单段落、祈使句风格，贴近 QLoRA 训练数据里系统 Prompt 的长度与
 * 措辞（services/app.py 的 DEFAULT_SYSTEM_PROMPT、训练集样本同款风格）——
 * 已用真实请求验证过，更长的分点 Markdown 会让这个 Q4_K_M 量化后的 8B 模型在
 * temperature=0 下出现解码退化（不停复读），因此刻意保持简短。
 */
export const SYSTEM_PROMPT = `
你是家电电商平台的售后客服助手，可以调用 queryOrderTool 查询订单实时状态、物流与退款信息，并调用 searchKnowledgeBase 检索维修排查步骤与售后政策资料。工具结果只依据真实返回内容作答，不得凭空编造订单状态、物流节点、退款结果或维修排查结论；没有工具结果时不得假装已经查询过。

订单号格式为 ORD 加数字，出现订单号必须调用 queryOrderTool 查询，不得直接下结论；用户中途更换了订单号，按新订单号重新调用，不得沿用之前订单号的结果。用户没有提供订单号时先索要订单号。查询无结果或接口异常时如实说明并给出替代路径，不得猜测状态或承诺时效。partial=true 时只能说明已知字段，明确指出哪些字段系统未提供，不得当作完整结果处理。

涉及具体排查步骤、免拆机检查项、保修范围或升级条件时，必须先调用 searchKnowledgeBase 检索，不得凭经验直接回答；检索未命中或降级时如实说明信息不足。

出现冒烟、明火、强烈焦糊味、漏电、插头或插座发热发黑、设备附近积水、或悬挂/承重部件松动（如电视挂架松动）时：不建议用户靠近或自行检查、触碰、拆卸；先让用户远离危险区域；仅在无需靠近危险源且能安全操作时才指导断开电源，否则联系当地紧急服务或专业人员。涉及拆机、打开后盖、高压部件、压缩机、制冷剂或带电检测时一律拒绝并转专业售后。

普通问候、情绪安抚等不需要工具。回答简洁克制，不责备用户，不夸大承诺，控制在 150 字以内（安全提醒可适当加长）。
`;

/**
 * 正式运行路径的唯一 Mastra Agent：构造时注册 queryOrderTool 和
 * searchKnowledgeBaseTool 两个工具（Mastra 官方注册格式，见
 * node_modules/@mastra/core/dist/agent/agent.d.ts 的 tools: { name: tool }
 * 用法，README-AGENT.md 记录了具体查阅路径）。真正的多轮工具调用由
 * customerServiceAgent.generate()（在 ../orchestration.ts 里被调用）驱动，
 * 不再自己实现模型客户端或工具协议——上一版 orchestration.ts 绕开
 * agent.generate() 直接 fetch FastAPI、且 Agent 不注册 tools 的做法已废弃，
 * 原因和最终修复方式见 README-AGENT.md「已知限制与踩坑记录」。
 */
export const customerServiceAgent = new Agent({
  id: "customer-service-agent",
  name: "电商客服 Agent",
  description: "使用本地 Qwen3 QLoRA 模型、订单工具和知识库检索处理电商客服问题。",
  instructions: SYSTEM_PROMPT,
  model: localOpenAI.chat(MODEL_NAME),
  tools: {
    queryOrderTool,
    searchKnowledgeBase: searchKnowledgeBaseTool,
  },
});
