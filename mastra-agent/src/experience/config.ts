/**
 * 工作流经验的独立 RAG 配置——复用 `rag/config.ts` 的 `loadConfig()`
 * 而不修改它，只是传入不同的 collection/knowledgeSet/knowledgeRoot
 * 覆盖值。qdrantUrl/embeddingBaseUrl/embeddingModel 等基础设施地址
 * 天然共享同一套环境变量：客服知识库与工作流经验库指向同一批服务
 * 实例，只是各自独立的 Qdrant Collection（F-007 要求的隔离性）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig as loadRagConfig, type RagConfig } from "../rag/config.ts";

// `npm run experience:*` 的进程 cwd 是 mastra-agent/（package.json 所在目录），
// 一个相对路径默认值在这里会被解析成 mastra-agent/knowledge/experience，
// 而不是文档里说的仓库根 knowledge/experience——同 rag/ingest.ts 用
// import.meta.url 锚定仓库根的做法，不依赖 cwd。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

export function loadExperienceConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return loadRagConfig({
    collection: process.env.EXPERIENCE_QDRANT_COLLECTION || "claude_workflow_experience",
    knowledgeSet: process.env.EXPERIENCE_KNOWLEDGE_SET || "claude-workflow-experience",
    knowledgeRoot: path.resolve(REPO_ROOT, process.env.EXPERIENCE_KNOWLEDGE_ROOT || "knowledge/experience"),
    globs: ["**/*.md"],
    ...overrides,
  });
}
