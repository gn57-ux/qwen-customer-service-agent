/**
 * 用户要求的 22 项质量/安全测试清单 → 具体测试文件+用例的对照表。
 *
 * 编号 1-15、18/19/21 已经在 Feature 1/2/3 各自的测试文件里覆盖，
 * 本文件**不重复实现同样的断言**（避免同一逻辑两处维护、容易漂移），
 * 只列出对照关系；编号 16/17/20/22 是 Feature 1-3 未直接覆盖的
 * 跨模块/边界场景，对应 F-001~F-004，新增测试在
 * `quality-gates.hook-concurrency.test.ts`（16）、
 * `quality-gates.timeout.test.ts`（17）、
 * `quality-gates.agents-md.test.ts`（20）、
 * `quality-gates.no-config.test.ts`（22）。
 *
 * 下面的 `describe` 块本身不是断言性测试，是让这份对照表可以被
 * `node --test` 拾取展示、且能在 CI 输出里被搜索到——真正的断言在
 * 各自引用的文件里。
 */

import { describe, it } from "node:test";

const CHECKLIST_MAPPING: Array<{ item: number; description: string; coveredBy: string }> = [
  { item: 1, description: "客服 Collection 与经验 Collection 完全隔离", coveredBy: "2.store-retrieval AC-001（live.test.ts 隔离性冒烟）" },
  { item: 2, description: "experience 摄取不会删除或修改 customer_service_knowledge", coveredBy: "2.store-retrieval AC-001" },
  { item: 3, description: "相同经验重复写入幂等", coveredBy: "1.data-model AC-003（write.test.ts AC-007）" },
  { item: 4, description: "相似经验去重（完全相同/版本递增两档；语义相似非完全相同不适用，见本文件 F-004 说明）", coveredBy: "1.data-model AC-003/AC-004" },
  { item: 5, description: "occurrence_count 正确增加", coveredBy: "1.data-model AC-003" },
  { item: 6, description: "Markdown 原子写入", coveredBy: "1.data-model AC-006" },
  { item: 7, description: "并发锁", coveredBy: "1.data-model AC-007" },
  { item: 8, description: "candidate 不参与默认检索", coveredBy: "2.store-retrieval AC-002" },
  { item: 9, description: "deprecated 不参与默认检索", coveredBy: "2.store-retrieval AC-002 + quality-gates.deprecated-not-retrieved.test.ts（本 feature 补充的 deprecated 专项分支）" },
  { item: 10, description: "verified 正常召回", coveredBy: "2.store-retrieval AC-005（隐含于 retrieve.test.ts 正向用例）" },
  { item: 11, description: "metadata 过滤", coveredBy: "2.store-retrieval AC-006/AC-006b" },
  { item: 12, description: "Reranker 可用与降级分支", coveredBy: "2.store-retrieval AC-003" },
  { item: 13, description: "Embedding/Qdrant 不可用时工作流继续", coveredBy: "2.store-retrieval AC-004" },
  { item: 14, description: "敏感信息扫描", coveredBy: "1.data-model AC-005" },
  { item: 15, description: "绝对路径脱敏", coveredBy: "1.data-model AC-005（同一测试覆盖）" },
  { item: 16, description: "Hook 重入保护（并发 finalize 不同/相同候选）", coveredBy: "quality-gates.hook-concurrency.test.ts（F-001，本 feature 新增）" },
  { item: 17, description: "Hook 超时验证（慢响应不无限阻塞）", coveredBy: "quality-gates.timeout.test.ts（F-002，本 feature 新增）" },
  { item: 18, description: "N8 ALLOW 才能 finalize", coveredBy: "3.cli-commands AC-005（finalize.test.ts）" },
  { item: 19, description: "BLOCK 不得写 verified", coveredBy: "3.cli-commands AC-004（finalize.test.ts）" },
  { item: 20, description: "不修改 AGENTS.md", coveredBy: "quality-gates.agents-md.test.ts（F-003，本 feature 新增）" },
  { item: 21, description: "不触碰客服训练数据与维修文档（datasets/training/configs/knowledge/repair）", coveredBy: "2.store-retrieval AC-001（同一验证覆盖）" },
  { item: 22, description: "新项目无 experience 配置时原工作流仍可运行", coveredBy: "quality-gates.no-config.test.ts（F-004，本 feature 新增）" },
];

describe("质量门禁清单对照表（22 项）", () => {
  it("每一项都有明确的覆盖来源，不存在遗漏或占位符", () => {
    if (CHECKLIST_MAPPING.length !== 22) {
      throw new Error(`清单应有 22 项，实际 ${CHECKLIST_MAPPING.length} 项`);
    }
    for (const entry of CHECKLIST_MAPPING) {
      if (!entry.coveredBy.trim()) {
        throw new Error(`第 ${entry.item} 项缺少覆盖来源：${entry.description}`);
      }
    }
  });
});

export { CHECKLIST_MAPPING };
