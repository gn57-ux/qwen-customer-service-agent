---
title: 失败态字段不能依赖"上游应该干净"，要在提取前主动挡住
feature: 1.contract-retrieval-counts
type: pitfall
tags: [contract, security, order-details, whitelist, defense-in-depth]
date: 2026-07-31
---

**问题/场景**：`buildContractExtras()` 里对 `queryOrderTool` 结果的处理，第一版是无条件调用 `toOrderDetails(r.order)`，隐含假设"`found: false` 时 `order` 字段应该是空的，所以不会有东西可映射"。这是一个乐观假设——工具层实现变化、异常路径、未来重构都可能让 `found:false` 时 `order` 仍然带着部分或全部数据。CR 用一个"对抗测试"直接证伪了这个假设的安全性：故意构造 `found:false` + 完整 `order` 数据，若不加防护，映射函数会正常把这些数据转出去，前端就会把一次失败查询误当成真实订单展示给客服坐席。

**解法/结论**：改成 `const details = r.found ? toOrderDetails(r.order) : undefined;`——判断条件放在调用点，而不是指望被调用的函数或上游数据自己"表现良好"。这是纵深防御的思路：即使 `toOrderDetails()` 本身逻辑完全正确，`found` 判断这一层独立的防线依然要存在。

**复用方式**：当一个数据结构的"是否应该展示"由另一个独立字段（如 `found`/`success`/`ok`）决定时：
1. 判断条件写在**提取/映射函数的调用点**，不要塞进映射函数内部依赖调用方"应该"传对；
2. 写对抗测试：故意在"不应该有数据"的分支里塞入完整的合法数据，断言最终输出里这个字段不存在（`"details" in order === false`，而不只是 `=== undefined`——后者无法区分"没给"和"给了 undefined"）；
3. 这类防线的成本很低（一个三元表达式），但省掉它是最容易被忽略、也最容易在需求变更中被绕过的一类 bug——因为"正常路径"下测试永远是绿的，只有专门构造对抗数据才能发现。
