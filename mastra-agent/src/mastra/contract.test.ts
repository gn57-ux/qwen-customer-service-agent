/**
 * buildContractExtras() 单元测试：纯函数，不依赖任何真实服务。
 *
 *   npm run agent:test:unit
 *
 * 覆盖 §1.contract-retrieval-counts 的验收标准：
 *   - AC-001~004：retrievedCount/returnedCount 在正常/重排/降级/空召回四个分支下正确透传
 *   - AC-005：本文件内的"两次调用比较"只证明 buildContractExtras() 本身是确定性纯函数，
 *     **不构成** chat 与 stream 两条真实 HTTP/SSE 路径等价的证据（两次调用的是同一个函数、
 *     同一份输入，任何纯函数都会通过）。AC-005 的真实路径级验证见
 *     ./routes/customer-service.route-assembly.test.ts —— 那里真正挂载
 *     customerServiceChatRoute/customerServiceStreamRoute 到 Hono app 并发起请求。
 *   - AC-009~012：order.details 白名单映射（完整订单/部分字段缺失/白名单外键/found:false 双重防线）
 *   - AC-013 由 contract.ts 与 types.ts 的类型定义手工比对覆盖（见两文件 diff）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContractExtras } from "./contract.ts";
import type { ToolCallRecord } from "./orchestration.ts";

function kbCall(result: Record<string, unknown>): ToolCallRecord {
  return { name: "searchKnowledgeBase", arguments: {}, result };
}

function orderCall(result: Record<string, unknown>): ToolCallRecord {
  return { name: "queryOrderTool", arguments: {}, result };
}

describe("buildContractExtras — retrievedCount/returnedCount", () => {
  it("AC-001 正常召回：retrievedCount 等于运行时命中数，returnedCount 等于返回条数，且前者 >= 后者", () => {
    const extras = buildContractExtras([
      kbCall({ reranked: false, degraded: false, retrievedCount: 17, returnedCount: 3, results: [] }),
    ]);
    assert.equal(extras.retrievedCount, 17);
    assert.equal(extras.returnedCount, 3);
    assert.ok(extras.retrievedCount >= extras.returnedCount);
  });

  it("AC-002 重排可用：returnedCount 等于重排后返回条数", () => {
    const extras = buildContractExtras([
      kbCall({ reranked: true, degraded: false, retrievedCount: 20, returnedCount: 5, results: [] }),
    ]);
    assert.equal(extras.reranked, true);
    assert.equal(extras.retrievedCount, 20);
    assert.equal(extras.returnedCount, 5);
  });

  it("AC-003 重排降级：两个计数仍正确返回", () => {
    const extras = buildContractExtras([
      kbCall({
        reranked: false,
        degraded: true,
        degradedReason: "Reranker 不可用",
        retrievedCount: 20,
        returnedCount: 5,
        results: [],
      }),
    ]);
    assert.equal(extras.degraded, true);
    assert.equal(extras.retrievedCount, 20);
    assert.equal(extras.returnedCount, 5);
  });

  it("AC-004 空召回：两个计数均为 0 且字段存在（非 undefined）", () => {
    const extras = buildContractExtras([
      kbCall({ reranked: false, degraded: false, retrievedCount: 0, returnedCount: 0, results: [] }),
    ]);
    assert.equal(extras.retrievedCount, 0);
    assert.equal(extras.returnedCount, 0);
    assert.notEqual(extras.retrievedCount, undefined);
    assert.notEqual(extras.returnedCount, undefined);
  });

  it("未调用 searchKnowledgeBase（如 general 路由）：两个计数均为 0", () => {
    const extras = buildContractExtras([]);
    assert.equal(extras.retrievedCount, 0);
    assert.equal(extras.returnedCount, 0);
  });

  it("buildContractExtras() 本身是确定性纯函数（不代表 AC-005 已验证，见文件头注释）", () => {
    const toolCalls = [kbCall({ reranked: true, degraded: false, retrievedCount: 12, returnedCount: 4, results: [] })];
    const first = buildContractExtras(toolCalls);
    const second = buildContractExtras(toolCalls);
    assert.deepEqual(first.retrievedCount, second.retrievedCount);
    assert.deepEqual(first.returnedCount, second.returnedCount);
  });
});

describe("buildContractExtras — order.details 白名单映射", () => {
  it("AC-009 完整订单（ORD1002 形状）：10 个字段全部正确映射，snake_case 正确转 camelCase", () => {
    const extras = buildContractExtras([
      orderCall({
        found: true,
        order: {
          order_id: "ORD1002",
          status: "shipped",
          status_text: "已发货，运输中",
          created_at: "2026-07-20T09:15:00+08:00",
          carrier: "顺丰速运",
          tracking_number: "SF1234567890",
          latest_logistics: "2026-07-23 16:20 已到达上海转运中心",
          estimated_delivery: "2026-07-25",
          can_cancel: false,
          customer_tip: "物流正在正常运输，建议客户耐心等待。",
        },
      }),
    ]);
    assert.deepEqual(extras.order?.details, {
      orderId: "ORD1002",
      status: "shipped",
      statusText: "已发货，运输中",
      createdAt: "2026-07-20T09:15:00+08:00",
      carrier: "顺丰速运",
      trackingNumber: "SF1234567890",
      latestLogistics: "2026-07-23 16:20 已到达上海转运中心",
      estimatedDelivery: "2026-07-25",
      canCancel: false,
      customerTip: "物流正在正常运输，建议客户耐心等待。",
    });
    // 显式断言非空——防止 snake_case 未转换导致全部静默落 null 而测试仍"通过"
    assert.equal(extras.order?.details?.orderId, "ORD1002");
    assert.equal(extras.order?.details?.carrier, "顺丰速运");
    assert.equal(extras.order?.details?.canCancel, false);
  });

  it("AC-010 部分字段为 null 的订单（ORD1001 形状）：对应字段为 null，未被填充任何默认值", () => {
    const extras = buildContractExtras([
      orderCall({
        found: true,
        order: {
          order_id: "ORD1001",
          status: "paid",
          status_text: "已付款，等待仓库发货",
          created_at: "2026-07-21T10:30:00+08:00",
          carrier: null,
          tracking_number: null,
          latest_logistics: null,
          estimated_delivery: null,
          can_cancel: true,
          customer_tip: "订单尚未出库，可为客户登记催发货。",
        },
      }),
    ]);
    const details = extras.order?.details;
    assert.equal(details?.orderId, "ORD1001");
    assert.equal(details?.carrier, null);
    assert.equal(details?.trackingNumber, null);
    assert.equal(details?.latestLogistics, null);
    assert.equal(details?.estimatedDelivery, null);
    assert.equal(details?.canCancel, true);
    // 未被填充任何编造值（比如不能是空字符串、"暂无"、"顺丰"等占位）
    assert.notEqual(details?.carrier, "");
    assert.notEqual(details?.carrier, "暂无");
  });

  it("只提供 order_id：其余 9 个字段必须全部存在且等于 null（不得省略为 undefined）", () => {
    const extras = buildContractExtras([orderCall({ found: true, order: { order_id: "ORD0001" } })]);
    const details = extras.order?.details;
    assert.ok(details, "details 必须存在");
    assert.equal(details?.orderId, "ORD0001");
    const expectedNullKeys: Array<keyof NonNullable<typeof details>> = [
      "status",
      "statusText",
      "createdAt",
      "carrier",
      "trackingNumber",
      "latestLogistics",
      "estimatedDelivery",
      "canCancel",
      "customerTip",
    ];
    for (const key of expectedNullKeys) {
      assert.ok(details && key in details, `字段 ${key} 必须存在于 details 中（不得省略）`);
      assert.equal(details?.[key], null, `字段 ${key} 缺失时必须显式为 null`);
    }
    // 完整性：details 必须恰好有 10 个键，一个不多一个不少
    assert.equal(Object.keys(details ?? {}).length, 10);
  });

  it("对抗测试：found=false 时即便 order 携带完整订单数据，details 也绝不能出现（防泄露）", () => {
    const extras = buildContractExtras([
      orderCall({
        found: false,
        error: "server_error",
        // 故意在 found=false 的情况下也塞入完整订单数据，模拟工具层异常/被篡改的场景
        order: {
          order_id: "ORD1002",
          status: "shipped",
          status_text: "已发货，运输中",
          created_at: "2026-07-20T09:15:00+08:00",
          carrier: "顺丰速运",
          tracking_number: "SF1234567890",
          latest_logistics: "2026-07-23 16:20 已到达上海转运中心",
          estimated_delivery: "2026-07-25",
          can_cancel: false,
          customer_tip: "物流正在正常运输，建议客户耐心等待。",
        },
      }),
    ]);
    assert.equal(extras.order?.found, false);
    assert.equal(extras.order?.error, "server_error");
    assert.equal(extras.order?.details, undefined, "found=false 时 details 必须为 undefined，不得泄露订单数据");
    assert.equal("details" in (extras.order ?? {}), false, "found=false 时 details 键本身不应出现在 order 对象上");
  });

  it("AC-011 白名单外的键不出现在 details 中", () => {
    const extras = buildContractExtras([
      orderCall({
        found: true,
        order: {
          order_id: "ORD1001",
          status: "paid",
          internal_cost_price: 999,
          supplier_note: "内部供应商备注",
        },
      }),
    ]);
    const details = extras.order?.details as unknown as Record<string, unknown>;
    assert.equal("internal_cost_price" in details, false);
    assert.equal("supplier_note" in details, false);
  });

  it("AC-012 found:false（not_found）：details 为 undefined，不构造空壳", () => {
    const extras = buildContractExtras([orderCall({ found: false, error: "not_found" })]);
    assert.equal(extras.order?.found, false);
    assert.equal(extras.order?.error, "not_found");
    assert.equal(extras.order?.details, undefined);
  });

  it("found:false（timeout）：details 为 undefined", () => {
    const extras = buildContractExtras([orderCall({ found: false, error: "timeout" })]);
    assert.equal(extras.order?.details, undefined);
  });

  it("order 非对象（缺失）：details 为 undefined", () => {
    const extras = buildContractExtras([orderCall({ found: true, partial: true, missingFields: ["carrier"] })]);
    assert.equal(extras.order?.details, undefined);
  });

  it("canCancel 非布尔类型时落 null，不强转", () => {
    const extras = buildContractExtras([
      orderCall({ found: true, order: { order_id: "ORD9999", can_cancel: "yes" } }),
    ]);
    assert.equal(extras.order?.details?.canCancel, null);
  });

  it("未调用 queryOrderTool：order 字段不存在", () => {
    const extras = buildContractExtras([]);
    assert.equal(extras.order, undefined);
  });
});
