/**
 * 摄取 CLI 入口。真正的流水线在 src/experience/bulk-ingest.ts。
 *
 *   npm run experience:ingest
 *   npm run experience:rebuild   # 先清空 collection 再全量重建
 */

import { createEmbeddingClient } from "../src/rag/embedding.ts";
import { loadExperienceConfig } from "../src/experience/config.ts";
import { runBulkIngest } from "../src/experience/bulk-ingest.ts";
import { ExperienceStore } from "../src/experience/store.ts";

async function main(): Promise<number> {
  const rebuild = process.argv.includes("--rebuild");
  const cfg = loadExperienceConfig();

  console.log("=".repeat(78));
  console.log(`工作流经验摄取（Markdown → ${cfg.embeddingModel} → Qdrant）${rebuild ? "  [--rebuild]" : ""}`);
  console.log("=".repeat(78));
  console.log(`collection=${cfg.collection}  knowledgeRoot=${cfg.knowledgeRoot}`);
  console.log();

  const embedder = await createEmbeddingClient(cfg);
  const store = new ExperienceStore(cfg);
  const report = await runBulkIngest(cfg.knowledgeRoot, embedder, store, { rebuild });

  console.log(`扫描到 ${report.documentCount} 份文档，成功摄取 ${report.successCount} 份`);
  if (report.orphansRemoved > 0) {
    console.log(`清理孤儿向量点：${report.orphansRemoved} 个（对应文档已删除/校验失败）`);
  }
  if (report.failures.length > 0) {
    console.log(`失败 ${report.failures.length} 份：`);
    for (const failure of report.failures) {
      console.log(`  - ${failure.relativePath}: ${failure.error}`);
    }
  }

  return report.failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:ingest 执行失败：", error);
    process.exit(1);
  });
