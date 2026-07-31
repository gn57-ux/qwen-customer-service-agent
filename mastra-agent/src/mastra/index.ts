import { Mastra } from "@mastra/core/mastra";
import { customerServiceAgent } from "./agents/customer-service-agent";
import { customerServiceChatRoute, customerServiceStreamRoute } from "./routes/customer-service";
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
  server: {
    apiRoutes: [customerServiceChatRoute, customerServiceStreamRoute],
  },
});

export { runAgentTurn, streamAgentTurn } from "./orchestration";
