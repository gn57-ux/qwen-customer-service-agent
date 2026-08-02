/**
 * queryOrderTool 单元测试：全部对假 HTTP 服务器（node:http），不依赖真实
 * Mock 后端进程，覆盖真实 Mock 后端无法模拟的 500/timeout/字段缺失场景。
 *
 *   npm run agent:test:unit
 *
 * 覆盖：
 *   1. 正常返回（found=true，透传 order 字段）
 *   2. 404 → found=false, error=not_found
 *   3. 500 → found=false, error=server_error，不抛出异常、不编造订单状态
 *   4. 超时 → found=false, error=timeout
 *   5. success=true 但 data 字段缺失 → found=false, error=server_error
 *   6. 响应不是合法 JSON → found=false, error=server_error
 *   7. orderId 大小写/首尾空白归一化
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

let server: Server | null = null;
let baseUrl = "";
let currentHandler: Handler = (_req, res) => {
  res.writeHead(500);
  res.end();
};

before(async () => {
  server = createServer((req, res) => currentHandler(req, res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
});

/** 每个用例独立设置 MOCK_BACKEND_URL 和 QUERY_ORDER_TIMEOUT_MS 后动态 import，
 * 因为 query-order-tool.ts 在模块顶层读取一次环境变量。 */
async function loadToolWith(env: Record<string, string>): Promise<typeof import("./query-order-tool.ts")> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    // 加时间戳查询串绕过模块缓存，确保每次都用当前环境变量重新求值顶层常量
    return await import(`./query-order-tool.ts?t=${Date.now()}-${Math.random()}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("queryOrderTool", () => {
  it("正常返回：found=true, partial=false 并透传 order 字段", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: { order_id: "ORD1001", status: "paid", status_text: "已付款，等待仓库发货" },
      }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = await queryOrderTool.execute!({ orderId: "ord1001" } as any, undefined as any);
    assert.equal((result as any).found, true);
    assert.equal((result as any).partial, false);
    assert.equal((result as any).order.order_id, "ORD1001");
    assert.equal((result as any).error, undefined);
  });

  it("404 → found=false, error=not_found", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD9999" } as any, undefined as any)) as any;
    assert.equal(result.found, false);
    assert.equal(result.error, "not_found");
    assert.match(result.message, /核对订单号/);
  });

  it("500 → found=false, error=server_error，不抛异常、不编造", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "internal error" }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1002" } as any, undefined as any)) as any;
    assert.equal(result.found, false);
    assert.equal(result.error, "server_error");
    assert.match(result.message, /不得编造订单状态/);
  });

  it("超时 → found=false, error=timeout", async () => {
    currentHandler = (_req, res) => {
      // 故意不响应，触发客户端超时
      setTimeout(() => {
        if (!res.writableEnded) res.end();
      }, 5000);
    };
    const { queryOrderTool } = await loadToolWith({
      MOCK_BACKEND_URL: baseUrl,
      QUERY_ORDER_TIMEOUT_MS: "300",
    });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1003" } as any, undefined as any)) as any;
    assert.equal(result.found, false);
    assert.equal(result.error, "timeout");
    assert.match(result.message, /超时/);
    assert.match(result.message, /不得编造订单状态/);
  });

  it("success=true 但 data 字段缺失 → found=false, error=server_error", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1001" } as any, undefined as any)) as any;
    assert.equal(result.found, false);
    assert.equal(result.error, "server_error");
    assert.match(result.message, /缺少订单数据字段/);
  });

  it("字段完整（含未发货订单的合法 null 物流字段）→ found=true, partial=false", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: {
          order_id: "ORD1001", status: "paid", status_text: "已付款，等待仓库发货",
          created_at: "2026-07-21T10:30:00+08:00",
          // 未发货订单的物流字段本来就是 null，不算"字段缺失"
          carrier: null, tracking_number: null, latest_logistics: null, estimated_delivery: null,
          can_cancel: true, customer_tip: "订单尚未出库，可为客户登记催发货。",
        },
      }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1001" } as any, undefined as any)) as any;
    assert.equal(result.found, true);
    assert.equal(result.partial, false);
    assert.equal(result.missingFields, undefined);
    assert.equal(result.order.carrier, null, "未发货订单的物流字段应原样保留为 null，不被当作缺失");
  });

  it("关键字段缺失（status_text 缺失）→ found=true, partial=true, missingFields 包含 status_text", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: { order_id: "ORD1002", status: "shipped" }, // 故意缺 status_text，模拟后端异常响应
      }));
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1002" } as any, undefined as any)) as any;
    assert.equal(result.found, true);
    assert.equal(result.partial, true);
    assert.deepEqual(result.missingFields, ["status_text"]);
    // 已知字段（保留后端已有字段，不得因为部分缺失就整体丢弃）
    assert.equal(result.order.order_id, "ORD1002");
    assert.equal(result.order.status, "shipped");
    assert.match(result.message, /status_text/);
    assert.match(result.message, /不得把这个部分结果当作完整结果处理/);
  });

  it("响应不是合法 JSON → found=false, error=server_error", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json at all {{{");
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    const result = (await queryOrderTool.execute!({ orderId: "ORD1001" } as any, undefined as any)) as any;
    assert.equal(result.found, false);
    assert.equal(result.error, "server_error");
    assert.match(result.message, /无法解析/);
  });

  it("orderId 归一化：小写+首尾空白 → 大写去空白后请求", async () => {
    let capturedPath = "";
    currentHandler = (req, res) => {
      capturedPath = req.url ?? "";
      res.writeHead(404);
      res.end();
    };
    const { queryOrderTool } = await loadToolWith({ MOCK_BACKEND_URL: baseUrl });
    await queryOrderTool.execute!({ orderId: "  ord1001  " } as any, undefined as any);
    assert.equal(capturedPath, "/api/orders/ORD1001");
  });
});
