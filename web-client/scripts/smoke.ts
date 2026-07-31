/**
 * 真实 Mastra Client smoke 测试：不 mock 任何一层。
 *
 *   npm run smoke
 *
 * 需要：mastra dev（4111）+ FastAPI(8000) + llama-server(8002) + Mock 后端(8001)
 *       + Qdrant + Ollama + Reranker 全部在线。
 *
 * 验证六类真实调用：
 *   1. 问候：不调用工具
 *   2. 冰箱不制冷：searchKnowledgeBase，Top20→Rerank Top5
 *   3. ORD1001：queryOrderTool
 *   4. 无订单号物流查询：追问订单号
 *   5. 挂架松动：先给安全边界
 *   6. 多轮 ORD1002→ORD1003：第二次真实调用新订单号
 * 外加一次 /customer-service/stream 的流式验证。
 */

import { createCustomerServiceClient } from "../src/client.ts";
import type { ChatHistoryTurn } from "../src/types.ts";

const MASTRA_BASE_URL = process.env.MASTRA_BASE_URL || "http://127.0.0.1:4111";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `：${detail}` : ""}`);
  }
}

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

async function main(): Promise<number> {
  // 拦截 fetch：客户端网络请求只应该访问 Mastra 服务的端口（4111），
  // 绝不能出现 :8000（FastAPI）或 :8002（llama-server）——client.ts 的实现
  // 结构上就不可能拼出这些地址（只用 options.baseUrl），这里额外加一层
  // 运行期断言，防止未来改动引入直连。
  const seenUrls: string[] = [];
  const originalFetch = global.fetch;
  global.fetch = ((url: any, opts: any) => {
    seenUrls.push(typeof url === "string" ? url : url.toString());
    return originalFetch(url, opts);
  }) as typeof fetch;

  const client = createCustomerServiceClient({ baseUrl: MASTRA_BASE_URL });

  console.log("=".repeat(78));
  console.log(`Mastra Client smoke：${MASTRA_BASE_URL}`);
  console.log("=".repeat(78));

  console.log("\n1. 问候：不调用工具");
  const greet = await client.chat("你好");
  check("route=general", greet.route === "general", greet.route);
  check("toolCalls 为空", greet.toolCalls.length === 0, JSON.stringify(greet.toolCalls));
  check("reply 非空", greet.reply.length > 0);

  console.log("\n2. 冰箱不制冷：searchKnowledgeBase，Top20→Rerank Top5");
  const repair = await client.chat("冰箱不制冷应该先检查什么");
  check("route=repair", repair.route === "repair", repair.route);
  check("调用了 searchKnowledgeBase", repair.toolCalls.some((c) => c.name === "searchKnowledgeBase"));
  check("sources 非空", (repair.sources?.length ?? 0) > 0, JSON.stringify(repair.sources));
  check("sources 不超过 5 条（Rerank Top5）", (repair.sources?.length ?? 0) <= 5);
  if (repair.reranked) {
    check("reranked=true 时 rerankScore 全部非空", repair.sources!.every((s) => typeof s.rerankScore === "number"));
  } else {
    check("degraded=true（Reranker 不可用/关闭时的显式降级）", repair.degraded === true);
  }

  console.log("\n3. ORD1001：queryOrderTool");
  const order1001 = await client.chat("帮我查一下 ORD1001 的状态");
  check("route=order", order1001.route === "order", order1001.route);
  check("调用了 queryOrderTool", order1001.toolCalls.some((c) => c.name === "queryOrderTool"));
  check("order.found=true", order1001.order?.found === true, JSON.stringify(order1001.order));

  console.log("\n4. 无订单号物流查询：追问订单号");
  const noOrderId = await client.chat("我的物流怎么没更新？");
  check("route=general", noOrderId.route === "general", noOrderId.route);
  check("不调用 queryOrderTool", !noOrderId.toolCalls.some((c) => c.name === "queryOrderTool"));
  check("回复里提到订单号", /订单号/.test(noOrderId.reply), noOrderId.reply);

  console.log("\n5. 挂架松动：先给安全边界");
  const safety = await client.chat("电视挂在墙上有点松动，晃一晃能动。");
  check("route=safety", safety.route === "safety", safety.route);
  check("不调用任何工具", safety.toolCalls.length === 0);
  check(
    "回复体现远离/专业处理",
    /远离|不要靠近|专业|停止使用|上门/.test(safety.reply),
    safety.reply,
  );

  console.log("\n6. 多轮 ORD1002→ORD1003：第二次真实调用新订单号");
  const first = await client.chat("帮我查一下 ORD1002 的状态");
  const orderCall1 = first.toolCalls.find((c) => c.name === "queryOrderTool");
  check("第一轮 orderId=ORD1002", orderCall1?.arguments.orderId === "ORD1002");
  const history: ChatHistoryTurn[] = [
    { role: "user", content: "帮我查一下 ORD1002 的状态" },
    { role: "assistant", content: first.reply },
  ];
  const second = await client.chat("不对，我要查 ORD1003", history);
  const orderCall2 = second.toolCalls.find((c) => c.name === "queryOrderTool");
  check("第二轮真实重新调用，orderId=ORD1003", orderCall2?.arguments.orderId === "ORD1003");
  check(
    "第二轮不是编造（真实数据里 ORD1003 承运商是中通快递）",
    (orderCall2?.result as { order?: { carrier?: string } })?.order?.carrier === "中通快递",
  );

  console.log("\n7. 流式：/customer-service/stream 真实 SSE");
  const seenEvents: string[] = [];
  let streamedText = "";
  const streamResult = await client.streamChat("你好", [], (event) => {
    seenEvents.push(event.event);
    if (event.event === "text-delta") streamedText += event.data.delta;
  });
  check("收到 meta 事件", seenEvents.includes("meta"));
  check("收到至少一个 text-delta", seenEvents.includes("text-delta"));
  check("收到 done 事件", seenEvents.includes("done"));
  check("拼接的流式文本与 done.reply 一致", streamedText.trim() === streamResult.reply.trim());

  console.log("\n8. 流式中断：客户端提前取消不应导致异常/挂起");
  // streamChat 内部封装了 MastraClient，这里直接用同一个底层客户端做一次
  // "只读一块就取消"，验证中断路径不抛未捕获异常、不挂起。
  await (async () => {
    const { MastraClient } = await import("@mastra/client-js");
    const rawClient = new MastraClient({ baseUrl: MASTRA_BASE_URL, apiPrefix: "" });
    const response = (await rawClient.request("/customer-service/stream", {
      method: "POST",
      body: { message: "冰箱不制冷应该先检查什么" },
      stream: true,
    })) as Response;
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    check("中断前至少读到一块数据", (value?.length ?? 0) > 0);
    let cancelThrew = false;
    try {
      await reader.cancel("client gave up reading");
    } catch {
      cancelThrew = true;
    }
    check("提前 cancel() 不抛异常", !cancelThrew);
  })();

  console.log("\n8b. 正式 streamChat(..., {signal})：AbortController 中途取消");
  await (async () => {
    const controller = new AbortController();
    let sawMeta = false;
    let sawDone = false;

    let thrown: unknown = null;
    try {
      await client.streamChat(
        "冰箱不制冷应该先检查什么",
        [],
        (event) => {
          if (event.event === "meta") {
            sawMeta = true;
            controller.abort(); // 收到 meta 就立刻取消，不等第一个 text-delta
          }
          if (event.event === "done") sawDone = true;
        },
        { signal: controller.signal },
      );
    } catch (error) {
      thrown = error;
    }

    check("收到过 meta 事件（取消发生在有真实响应之后）", sawMeta);
    check(
      "抛出的是 AbortError",
      thrown instanceof DOMException && thrown.name === "AbortError",
      thrown ? `${(thrown as Error).name}: ${(thrown as Error).message}` : "没有抛出异常",
    );
    check("没有收到 done 事件", !sawDone);
  })();

  console.log("\n8c. 正式 streamChat(..., {signal})：调用前 signal 已 aborted，不发请求");
  await (async () => {
    const preSeenUrlsBefore = seenUrls.length;
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown = null;
    try {
      await client.streamChat("你好", [], () => {}, { signal: controller.signal });
    } catch (error) {
      thrown = error;
    }
    check(
      "预先 abort 时立刻抛出 AbortError",
      thrown instanceof DOMException && thrown.name === "AbortError",
      thrown ? `${(thrown as Error).name}: ${(thrown as Error).message}` : "没有抛出异常",
    );
    check("没有发出任何新请求", seenUrls.length === preSeenUrlsBefore, `新增请求：${seenUrls.slice(preSeenUrlsBefore)}`);
  })();

  console.log("\n9. 错误处理：非法请求体返回明确错误，不是静默失败");
  try {
    const { MastraClient } = await import("@mastra/client-js");
    const rawClient = new MastraClient({ baseUrl: MASTRA_BASE_URL, apiPrefix: "" });
    await rawClient.request("/customer-service/chat", { method: "POST", body: {} });
    check("空 message 应该抛错", false, "没有抛出异常");
  } catch (error: any) {
    check("空 message 抛出 HTTP 400", error?.status === 400, `实际 status=${error?.status}`);
  }

  console.log("\n10. 客户端网络请求只访问 Mastra 端口（4111），不直连 FastAPI/llama-server");
  check(
    "所有请求都打到 :4111",
    seenUrls.every((u) => u.includes(":4111")),
    JSON.stringify(seenUrls),
  );
  check(
    "没有任何请求打到 :8000 或 :8002",
    !seenUrls.some((u) => u.includes(":8000") || u.includes(":8002")),
    JSON.stringify(seenUrls),
  );

  global.fetch = originalFetch;

  // 给任何可能残留的 rejected promise 一个机会冒泡到 unhandledRejection，
  // 再做最终断言——覆盖"没有产生未处理异常或挂起"这条要求。
  await new Promise((resolve) => setImmediate(resolve));
  console.log("\n11. 全程没有产生未处理的 Promise rejection（覆盖挂起/泄漏检查）");
  check("unhandledRejection 计数为 0", unhandledRejections.length === 0, JSON.stringify(unhandledRejections));

  console.log("\n" + "=".repeat(78));
  console.log(`smoke 完成：PASS=${passed} FAIL=${failed}`);
  console.log("=".repeat(78));
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\nsmoke 异常终止：", error instanceof Error ? error.message : error);
    process.exit(1);
  });
