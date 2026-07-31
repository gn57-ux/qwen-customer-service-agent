# Memory 索引

- [ChatResponseBody 组装点在 routes/customer-service.ts，不在 orchestration.ts](contract-response-body-assembly-point.md) — 改响应体字段时该动哪个文件、绝不碰哪个文件 | tags: contract,orchestration,routes,buildContractExtras,mastra-agent
- [契约里的可空字段必须必填+显式 null，不能用可选属性省略](nullable-fields-must-be-explicit.md) — 白名单映射的字段设计模式：必填+null，不用可选属性 | tags: contract,typescript,nullable,order-details,whitelist
- [失败态字段不能依赖"上游应该干净"，要在提取前主动挡住](found-false-must-not-leak-data.md) — found=false 时的数据泄露防线要写在调用点 | tags: contract,security,order-details,whitelist,defense-in-depth
- [用 node:test 的 mock.module() + 真实 Hono app 测生产 route，不改生产代码](real-route-testing-with-module-mock.md) — 不起完整服务也能测真实 route/SSE 行为的可复用手法 | tags: testing,hono,mock.module,node-test,route,sse,streaming,mastra
- [发现 specs 与真实架构不符时，必须改权威 requirements/design，不能只记在 tasks.md](specs-drift-must-fix-authoritative-docs.md) — specs 纠错流程：改代码只是第一步，权威文档要同步改版本号 | tags: specs,requirements,design,tasks,documentation,review,service-status
- [归一化比较要双向做；第三方健康检查端点别默认"HTTP 2xx=健康"](bidirectional-normalization-and-health-semantics.md) — Ollama tag 双向归一化 + FastAPI health body 判定的两个踩坑 | tags: normalization,health-check,ollama,fastapi,probe,testing
- [给不支持外部 AbortSignal 的既有函数套超时上限，用 Promise.race 不用改造它](promise-race-timeout-wrapper.md) — probe() 包装器的通用超时模式 | tags: timeout,promise-race,abort-signal,health-check,probe
- [注释里写"禁止的字面量"要用转述，避免被门禁正则误判为违规](comments-avoid-gate-regex-literals.md) — Feature 8 门禁扫描不分注释与代码，写规则说明要用转述 | tags: documentation,comments,gate,regex,false-positive,quality-gates
- [并发 refresh 需用自增 request id 防止旧请求覆盖新状态](stale-concurrent-refresh-must-guard-by-request-id.md) — effect+轮询+用户交互多处触发同一刷新函数时的竞态防护模式 | tags: react-hook,concurrency,race-condition,polling,refresh
- [Stitch 设计稿的图标按钮/可点击列表项要补键盘与屏幕阅读器语义](icon-only-controls-need-real-buttons-and-aria-label.md) — li-onclick 改真实 button + aria-current；图标按钮补 aria-label + 图标 aria-hidden | tags: accessibility,a11y,aria-label,aria-hidden,keyboard,button
- [受控 hook + 定向写入——多实体共享同一异步操作 hook 的正确模式](controlled-hook-with-targeted-write-for-multi-entity-state.md) — 多会话/多标签页共享同一个流式请求 hook 时，数据下放给调用方持有，写回按 entityId 定向 | tags: react-hook,multi-session,controlled-component,race-condition
- [同步中断路径必须搬全异步收尾原本做的每一件事](synchronous-teardown-must-mirror-async-cleanup.md) — abort 的同步旁路要跟正常 finally 做一样的收尾（状态归位+onSettled+资源释放），不能只改一半 | tags: react-hook,abort-controller,race-condition,cleanup,onSettled
- [组件动画/生命周期状态要在 render 阶段同步派生，不能放进 useEffect](render-phase-state-adjustment-for-sync-transitions.md) — Drawer 退场动画：同步派生 vs 异步 tick 的取舍 | tags: react,useEffect,render-phase,animation,drawer
- [CSS 断点隐藏不能替代真正的交互状态收口——响应式组件要配 matchMedia](css-responsive-hiding-needs-matchmedia-state-sync.md) — Drawer 跨断点自动关闭，避免焦点陷阱困住隐藏面板 | tags: responsive,matchmedia,drawer,focus-trap,accessibility
- [从集合选唯一最大项要用严格大于维护下标，不能先求 Math.max() 再等值判断](unique-max-selection-needs-strict-greater-than.md) — rank-1/唯一最大值判定的并列 tie-break 正确写法 | tags: derive,rank-1,tie-break,max,deterministic
- [只画 cursor-pointer/hover 不接点击行为，是误导性 UI](interactive-styling-without-handler-is-misleading.md) — 需求"开放问题"给出的具体 resolution 也是验收范围；交互目标不存在要一并实现 | tags: ui,interaction,open-question,requirements,misleading-affordance
