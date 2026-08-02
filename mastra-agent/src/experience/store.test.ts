/**
 * `buildExperienceFilter()` 是 ExperienceStore.query() 里唯一的
 * 正确性关键逻辑（其余方法都是对 QdrantVector/REST 的常规转发，
 * 需要真实 Qdrant 才能有意义地测试，留给 T-008 的集成测试）——
 * 单独导出成纯函数后不依赖真实服务就能验证过滤条件是否按 MongoDB
 * 风格正确构造。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildExperienceFilter } from "./store.ts";

describe("buildExperienceFilter", () => {
  it("不传 extraFilter 时只有 knowledge_set 一个条件", () => {
    const filter = buildExperienceFilter("claude-workflow-experience");
    assert.deepEqual(filter, { knowledge_set: "claude-workflow-experience" });
  });

  it("stage/taskType/riskLevel/status 各自映射为对应的 snake_case 字段", () => {
    const filter = buildExperienceFilter("claude-workflow-experience", {
      stage: "execute",
      taskType: "backend",
      riskLevel: "medium",
      status: "verified",
    });
    assert.deepEqual(filter, {
      knowledge_set: "claude-workflow-experience",
      stage: "execute",
      task_type: "backend",
      risk_level: "medium",
      status: "verified",
    });
  });

  it("projectScopeIn 翻译成 $in 数组，表达 OR/any-of 语义（而不是单值 match）", () => {
    const filter = buildExperienceFilter("claude-workflow-experience", {
      projectScopeIn: ["my-project", "global"],
    });
    assert.deepEqual(filter, {
      knowledge_set: "claude-workflow-experience",
      project_scope: { $in: ["my-project", "global"] },
    });
  });

  it("projectScopeIn 为空数组时不加入 filter（不产出一个永远不匹配的空 $in）", () => {
    const filter = buildExperienceFilter("claude-workflow-experience", { projectScopeIn: [] });
    assert.deepEqual(filter, { knowledge_set: "claude-workflow-experience" });
  });

  it("绝不产出原生 Qdrant REST 的 must/match 数组形状——那是翻译器的输出，不是输入", () => {
    const filter = buildExperienceFilter("claude-workflow-experience", {
      stage: "execute",
      projectScopeIn: ["my-project"],
    });
    assert.equal("must" in filter, false, "filter 不应包含 must 字段");
    assert.equal(typeof filter.stage, "string", "stage 应是扁平字符串值，不是 { match: {...} } 包装");
  });

  it("knowledge_set 隔离条件始终存在，即使 extraFilter 传了同名字段也不会被覆盖掉隔离保险", () => {
    const filter = buildExperienceFilter("claude-workflow-experience", {
      stage: "execute",
      taskType: "backend",
      projectScopeIn: ["global"],
      riskLevel: "low",
      status: "candidate",
    });
    assert.equal(filter.knowledge_set, "claude-workflow-experience");
  });
});
