import { Mastra } from "@mastra/core/mastra";
import { customerServiceAgent } from "./agents/customer-service-agent";
import { queryOrderTool } from "./tools/query-order-tool";
import { searchKnowledgeBaseTool } from "./tools/search-knowledge-base-tool";

export const mastra = new Mastra({
  agents: {
    customerServiceAgent,
  },
  tools: {
    queryOrderTool,
    searchKnowledgeBaseTool,
  },
});

export { runAgentTurn } from "./orchestration";
