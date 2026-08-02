/**
 * classifyRoute() 单元测试：纯函数，不依赖任何真实服务。
 *
 *   npm run agent:test:unit
 *
 * runAgentTurn() 本身现在直接调用真实的 customerServiceAgent.generate()
 * （不再有可替换的 chatCompletion 桩函数——正式运行路径必须是真实 Mastra
 * Agent，见 README-AGENT.md），因此它的行为测试全部放在 agent.e2e.test.ts
 * 里对真实服务跑，这里只测路由分类本身。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyRoute } from "./orchestration.ts";

describe("classifyRoute", () => {
  it("安全场景优先于维修域关键词（挂架松动同时含'电视'）", () => {
    assert.equal(classifyRoute("电视挂在墙上有点松动，晃一晃能动。"), "safety");
    assert.equal(classifyRoute("冰箱冒烟还有焦味"), "safety");
    assert.equal(classifyRoute("插座发热发黑了"), "safety");
  });

  it("订单号识别优先于维修域关键词判断为 order", () => {
    assert.equal(classifyRoute("帮我查一下 ORD1001 的状态"), "order");
  });

  it("维修域关键词识别为 repair", () => {
    assert.equal(classifyRoute("冰箱不制冷应该先检查什么"), "repair");
    assert.equal(classifyRoute("显示器提示无信号怎么排查"), "repair");
  });

  it("无订单号的订单意图不匹配 order/repair，识别为 general（交给模型先追问）", () => {
    assert.equal(classifyRoute("我的物流怎么没更新？"), "general");
  });

  it("不匹配任何规则时识别为 general", () => {
    assert.equal(classifyRoute("你好"), "general");
  });
});
