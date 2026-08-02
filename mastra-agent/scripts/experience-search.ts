/**
 * 检索调试 CLI 入口——直接调用 Feature 2 的 retrieveExperience()，
 * 打印格式化结果，供人工调试检索效果。
 *
 *   npm run experience:search -- --query "..." --stage execute \
 *     [--task-type backend] [--project-scope xxx] [--scope-mode project-only]
 */

import { createEmbeddingClient } from "../src/rag/embedding.ts";
import { createReranker } from "../src/rag/rerank.ts";
import { loadExperienceConfig } from "../src/experience/config.ts";
import { formatForInjection } from "../src/experience/format.ts";
import { retrieveExperience, type RetrieveQuery } from "../src/experience/retrieve.ts";
import { ExperienceStore } from "../src/experience/store.ts";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<number> {
  const query = argValue("--query");
  const stage = argValue("--stage");
  if (!query || !stage) {
    console.error("用法：experience:search -- --query \"...\" --stage execute [--task-type backend] [--project-scope xxx] [--scope-mode project-only]");
    return 1;
  }
  if (!["execute", "review", "qa", "finish"].includes(stage)) {
    console.error(`--stage 必须是 execute/review/qa/finish 之一，收到：${stage}`);
    return 1;
  }

  const cfg = loadExperienceConfig();
  const embedder = await createEmbeddingClient(cfg);
  const store = new ExperienceStore(cfg);
  const reranker = createReranker();

  const retrieveQuery: RetrieveQuery = {
    taskDescription: query,
    stage: stage as RetrieveQuery["stage"],
    taskType: argValue("--task-type"),
    projectScope: argValue("--project-scope") ?? "global",
    scopeMode: argValue("--scope-mode") as RetrieveQuery["scopeMode"],
  };

  const result = await retrieveExperience(retrieveQuery, { cfg, embedder, store, reranker });

  console.log(`degraded=${result.degraded}${result.degradedReason ? ` (${result.degradedReason})` : ""}`);
  console.log(`召回 ${result.lessons.length} 条`);
  console.log();
  console.log(formatForInjection(result.lessons) || "（无结果）");

  return result.degraded && result.lessons.length === 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:search 执行失败：", error);
    process.exit(1);
  });
