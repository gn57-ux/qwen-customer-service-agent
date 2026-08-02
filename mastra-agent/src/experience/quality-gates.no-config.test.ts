/**
 * 用户 22 项清单第 22 项：新项目无 experience 配置时原工作流仍可运行
 * （F-004）。
 *
 * 验证"找不到配置/服务不可达 = 优雅跳过，不抛出未捕获异常"这条降级
 * 路径本身——不需要真的新建一个物理临时目录宿主项目（那属于集成测试
 * 范畴），核心是验证 `experience-status.ts` 依赖的检测函数
 * （`getExperienceStatus()`）面对"完全没配置/服务不可达"时表现正确。
 *
 * 用一个刻意不存在/不可达的 Qdrant 地址（`http://127.0.0.1:1`，1 号
 * 端口是保留端口，本机永远不会有服务监听在这里，连接会立即被拒绝，
 * 不需要等待超时）模拟"新项目还没有配置好基础设施"这一具体场景。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { RagConfig } from "../rag/config.ts";
import type { Reranker, RerankerHealth } from "../rag/rerank.ts";
import { getExperienceStatus, type CreateEmbeddingClientFn } from "./status.ts";
import { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-no-config-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function unreachableCfg(): RagConfig {
  return {
    qdrantUrl: "http://127.0.0.1:1", // 保留端口，连接立即被拒绝，不需要等超时
    collection: "claude_workflow_experience",
    embeddingBaseUrl: "http://127.0.0.1:1/v1",
    embeddingModel: "bge-m3",
    embeddingDimension: 1024,
    distance: "Cosine",
    knowledgeSet: "claude-workflow-experience",
    // 全新项目场景：knowledgeRoot 也不存在。
    knowledgeRoot: path.join(tmpDir, "does-not-exist"),
    globs: ["**/*.md"],
    chunk: { maxChars: 800, minChars: 400, overlapChars: 100 },
  };
}

function throwingCreateEmbedder(): CreateEmbeddingClientFn {
  return async () => {
    throw new Error("模拟全新项目未配置 Embedding 服务");
  };
}

function unreachableReranker(): Reranker {
  return {
    name: "fake",
    async health(): Promise<RerankerHealth> {
      return { available: false, detail: "模拟全新项目未配置 Reranker 服务" };
    },
    async rerank() {
      throw new Error("不应该被调用");
    },
  };
}

describe("AC-005: 空配置/服务不可达场景下 experience:status 优雅报告未配置，不崩溃", () => {
  it("getExperienceStatus() 在 Qdrant/Embedding/Reranker 均不可达、knowledgeRoot 不存在时不抛出异常，三项均标注离线", async () => {
    const cfg = unreachableCfg();
    const store = new ExperienceStore(cfg);

    // 核心断言：整个调用不抛出未捕获异常——这是"找不到配置 = 优雅跳过"
    // 这条路径成立的前提，`experience-status.ts` 的 CLI 封装因此也能
    // 正常以退出码 0 结束，而不是让调用方（未来的 yd 工作流）看到一个
    // 未处理的 rejection。
    const report = await getExperienceStatus(cfg, store, unreachableReranker(), throwingCreateEmbedder());

    assert.equal(report.qdrant.available, false);
    assert.equal(report.embedding.available, false);
    assert.equal(report.reranker.available, false);
    assert.deepEqual(report.countsByStatus, { candidate: 0, verified: 0, deprecated: 0 });
    assert.equal(report.unparseableCount, 0);
  });

  it("即使经验子系统完全不可用，也不影响该场景下能同时运行的其他无关逻辑（隔离性的最小验证：调用本身不抛出、不产生副作用）", async () => {
    const cfg = unreachableCfg();
    const store = new ExperienceStore(cfg);

    // 用两次独立调用模拟"经验状态检测"与"宿主项目里其他假设存在的
    // 逻辑"并发运行的场景——如果经验检测内部有未捕获异常，会导致
    // Promise.all 整体 reject，拖累无关的另一侧。
    const results = await Promise.all([
      getExperienceStatus(cfg, store, unreachableReranker(), throwingCreateEmbedder()),
      Promise.resolve("宿主项目其他逻辑正常返回"),
    ]);

    assert.equal(results[1], "宿主项目其他逻辑正常返回");
    assert.equal(results[0].qdrant.available, false);
  });
});
