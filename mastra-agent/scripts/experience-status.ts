/**
 * 巡检 CLI 入口——三项服务连通性 + 按 status 分组的经验数量统计。
 * 巡检命令，任一服务不可用不应该让命令失败，始终以退出码 0 结束。
 *
 *   npm run experience:status
 */

import { createReranker } from "../src/rag/rerank.ts";
import { loadExperienceConfig } from "../src/experience/config.ts";
import { getExperienceStatus } from "../src/experience/status.ts";
import { ExperienceStore } from "../src/experience/store.ts";

async function main(): Promise<number> {
  const cfg = loadExperienceConfig();
  const store = new ExperienceStore(cfg);
  const reranker = createReranker();

  const report = await getExperienceStatus(cfg, store, reranker);

  console.log("=== Claude Workflow Experience 状态 ===");
  console.log(
    `Qdrant:      ${report.qdrant.available ? "在线" : "离线"}（${report.collection}）—— ${report.qdrant.detail}`,
  );
  console.log(`Embedding:   ${report.embedding.available ? "在线" : "离线"} —— ${report.embedding.detail}`);
  console.log(`Reranker:    ${report.reranker.available ? "在线" : "离线"} —— ${report.reranker.detail}`);
  console.log(
    `经验统计：candidate=${report.countsByStatus.candidate}  ` +
      `verified=${report.countsByStatus.verified}  ` +
      `deprecated=${report.countsByStatus.deprecated}` +
      (report.unparseableCount > 0 ? `  无法解析=${report.unparseableCount}` : ""),
  );

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:status 执行失败：", error);
    process.exit(1);
  });
