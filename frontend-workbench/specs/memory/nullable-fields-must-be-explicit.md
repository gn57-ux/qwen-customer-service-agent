---
title: 契约里的可空字段必须必填+显式 null，不能用可选属性省略
feature: 1.contract-retrieval-counts
type: pitfall
tags: [contract, typescript, nullable, order-details, whitelist]
date: 2026-07-31
---

**问题/场景**：`OrderDetails` 白名单映射的第一版把 10 个字段都写成可选（`orderId?: string | null`），映射函数遇到源数据缺失某个键时用 `if (!(from in src)) continue` 直接跳过赋值。CR 审查指出：这让"字段缺失"和"映射函数漏写了这个字段"在类型层面无法区分——两种情况在 TS 看来都是"这个可选属性不存在"。

**解法/结论**：把 10 个字段全部改成必填（去掉 `?`），类型为 `string | null` / `boolean | null`。映射函数改为无条件遍历全部白名单键，对每个键都显式赋值：命中就赋真实值，缺失或类型不符就显式赋 `null`。这样任何时候读到的 `OrderDetails` 对象都保证有全部 10 个键，`in` 检查和类型检查都能覆盖住"漏写"这类回归。

**复用方式**：任何"从外部/泛型数据映射出一个类型化白名单结构"的场景（不只是订单），都应该遵循同一个模式：
- 白名单字段用必填 + `T | null`，不用 `T?`；
- 映射函数遍历**目标字段清单**（不是遍历源数据的 keys），对每个目标字段都显式产出值或 `null`；
- 写单测断言"只给一个字段时，其余字段必须全部存在且为 null，键数量精确等于白名单大小"——这是防回归最直接的方式（`Object.keys(details).length === N`）。

同时配套的第二条防线：如果这个白名单结构只应该在某个前置条件成立时才暴露（本例是 `found === true`），那个判断必须在**调用映射函数之前**做，不能指望映射函数或上游数据"应该"是干净的（见 [[found-false-must-not-leak-data]]）。
