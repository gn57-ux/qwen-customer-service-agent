import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadConfig as loadRagConfig } from "../rag/config.ts";
import { loadExperienceConfig } from "./config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

describe("loadExperienceConfig", () => {
  it("默认值与客服知识库的 collection/knowledgeSet/knowledgeRoot 相互独立（F-007 隔离性）", () => {
    const experienceCfg = loadExperienceConfig();
    const ragCfg = loadRagConfig();

    assert.equal(experienceCfg.collection, "claude_workflow_experience");
    assert.equal(experienceCfg.knowledgeSet, "claude-workflow-experience");
    assert.equal(experienceCfg.knowledgeRoot, path.resolve(REPO_ROOT, "knowledge/experience"));
    assert.ok(path.isAbsolute(experienceCfg.knowledgeRoot), "knowledgeRoot 必须锚定仓库根解析为绝对路径，不依赖进程 cwd");
    assert.notEqual(experienceCfg.collection, ragCfg.collection);
    assert.notEqual(experienceCfg.knowledgeSet, ragCfg.knowledgeSet);
    assert.notEqual(experienceCfg.knowledgeRoot, ragCfg.knowledgeRoot);
  });

  it("globs 固定为 **/*.md，不沿用客服知识库的 repair/*.md 分类约定", () => {
    const experienceCfg = loadExperienceConfig();
    assert.deepEqual(experienceCfg.globs, ["**/*.md"]);
  });

  it("qdrantUrl/embeddingBaseUrl/embeddingModel 与客服知识库共享同一套基础设施配置，不是各自硬编码的重复值", () => {
    const experienceCfg = loadExperienceConfig();
    const ragCfg = loadRagConfig();
    assert.equal(experienceCfg.qdrantUrl, ragCfg.qdrantUrl);
    assert.equal(experienceCfg.embeddingBaseUrl, ragCfg.embeddingBaseUrl);
    assert.equal(experienceCfg.embeddingModel, ragCfg.embeddingModel);
    assert.equal(experienceCfg.embeddingDimension, ragCfg.embeddingDimension);
  });

  it("overrides 参数可以覆盖任意字段（供测试注入独立的临时 collection）", () => {
    const experienceCfg = loadExperienceConfig({ collection: "test-override-collection" });
    assert.equal(experienceCfg.collection, "test-override-collection");
    // 其余字段仍是 experience 的默认值，不受 override 影响。
    assert.equal(experienceCfg.knowledgeSet, "claude-workflow-experience");
  });

  it("EXPERIENCE_QDRANT_COLLECTION/EXPERIENCE_KNOWLEDGE_SET/EXPERIENCE_KNOWLEDGE_ROOT 环境变量可覆盖默认值", () => {
    const original = {
      collection: process.env.EXPERIENCE_QDRANT_COLLECTION,
      knowledgeSet: process.env.EXPERIENCE_KNOWLEDGE_SET,
      knowledgeRoot: process.env.EXPERIENCE_KNOWLEDGE_ROOT,
    };
    try {
      process.env.EXPERIENCE_QDRANT_COLLECTION = "env-collection";
      process.env.EXPERIENCE_KNOWLEDGE_SET = "env-knowledge-set";
      process.env.EXPERIENCE_KNOWLEDGE_ROOT = "env/knowledge/root";

      const experienceCfg = loadExperienceConfig();
      assert.equal(experienceCfg.collection, "env-collection");
      assert.equal(experienceCfg.knowledgeSet, "env-knowledge-set");
      assert.equal(experienceCfg.knowledgeRoot, path.resolve(REPO_ROOT, "env/knowledge/root"));
    } finally {
      if (original.collection === undefined) delete process.env.EXPERIENCE_QDRANT_COLLECTION;
      else process.env.EXPERIENCE_QDRANT_COLLECTION = original.collection;
      if (original.knowledgeSet === undefined) delete process.env.EXPERIENCE_KNOWLEDGE_SET;
      else process.env.EXPERIENCE_KNOWLEDGE_SET = original.knowledgeSet;
      if (original.knowledgeRoot === undefined) delete process.env.EXPERIENCE_KNOWLEDGE_ROOT;
      else process.env.EXPERIENCE_KNOWLEDGE_ROOT = original.knowledgeRoot;
    }
  });
});
