import { Mastra } from "@mastra/core/mastra";
import { customerServiceAgent } from "./agents/customer-service-agent";
import { queryOrderTool } from "./tools/query-order-tool";

export const mastra = new Mastra({
  agents: {
    customerServiceAgent,
  },
  tools: {
    queryOrderTool,
  },
});
