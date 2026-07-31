# Memory 索引

- [ChatResponseBody 组装点在 routes/customer-service.ts，不在 orchestration.ts](contract-response-body-assembly-point.md) — 改响应体字段时该动哪个文件、绝不碰哪个文件 | tags: contract,orchestration,routes,buildContractExtras,mastra-agent
- [契约里的可空字段必须必填+显式 null，不能用可选属性省略](nullable-fields-must-be-explicit.md) — 白名单映射的字段设计模式：必填+null，不用可选属性 | tags: contract,typescript,nullable,order-details,whitelist
- [失败态字段不能依赖"上游应该干净"，要在提取前主动挡住](found-false-must-not-leak-data.md) — found=false 时的数据泄露防线要写在调用点 | tags: contract,security,order-details,whitelist,defense-in-depth
- [用 node:test 的 mock.module() + 真实 Hono app 测生产 route，不改生产代码](real-route-testing-with-module-mock.md) — 不起完整服务也能测真实 route/SSE 行为的可复用手法 | tags: testing,hono,mock.module,node-test,route,sse,streaming,mastra
