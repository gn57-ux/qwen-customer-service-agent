/**
 * 摄取 CLI 入口。真正的流水线在 pipeline.ts，这里只负责组装依赖、打印和落报告。
 *
 *   npm run rag:ingest
 *   npm run rag:ingest -- --recreate     # 显式重建 Collection（会丢数据）
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeConfig, loadConfig } from "./config.ts";
import { createEmbeddingClient } from "./embedding.ts";
import { runIngestion } from "./pipeline.ts";
import { QdrantKnowledgeStore } from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTRA_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(MASTRA_ROOT, "..");

async function main(): Promise<number> {
  const recreate = process.argv.includes("--recreate");
  const cfg = loadConfig();

  console.log("=".repeat(78));
  console.log("客服知识库摄取（Markdown → bge-m3 → Qdrant）");
  console.log("=".repeat(78));
  console.log(JSON.stringify(describeConfig(cfg), null, 2));
  console.log();

  const embedder = await createEmbeddingClient(cfg);
  const store = new QdrantKnowledgeStore(cfg);

  const report = await runIngestion(
    cfg,
    { embedder, store, repoRoot: REPO_ROOT, log: (m) => console.log(m) },
    { recreate },
  );
  report.config = describeConfig(cfg);

  const c = report.counts;
  console.log();
  console.log("-".repeat(78));
  console.log("入库报告");
  console.log("-".repeat(78));
  console.log(`文档数                        : ${c.documentCount}`);
  for (const d of report.documents) {
    console.log(
      `  ${d.sourceFile.padEnd(34)} ${String(d.chunkCount).padStart(3)} chunk  ` +
        `scope=${d.ingestionScope}  upsert=${d.upsertOk ? "成功" : "失败"}`,
    );
  }
  console.log(`Embedding 模型                : ${report.embedding.model}`);
  console.log(`实际向量维度                  : ${report.embedding.dimensionActual}`);
  console.log(`Collection                    : ${report.qdrant.collection}（${report.qdrant.distance}）`);
  console.log(`knowledge_set                 : ${(report.config as { knowledgeSet?: string }).knowledgeSet}`);
  console.log();
  console.log(`collectionTotalPointCount     : ${c.collectionTotalPointCount}`);
  console.log(`currentKnowledgeSetPointCount : ${c.currentKnowledgeSetPointCount}`);
  console.log(`currentScopePointCount        : ${c.currentScopePointCount}`);
  console.log(`expectedScopeChunkCount       : ${c.expectedScopeChunkCount}`);
  console.log(`stalePointsDeleted            : ${c.stalePointsDeleted}`);
  console.log(`idempotent                    : ${c.idempotent}`);
  console.log();
  console.log("按 scope 明细：");
  for (const s of report.scopes) {
    console.log(
      `  ${s.scope.padEnd(12)} 期望 ${String(s.expectedScopeChunkCount).padStart(3)} / ` +
        `实际 ${String(s.currentScopePointCount).padStart(3)} / 清理 ${s.stalePointsDeleted} / ` +
        `幂等 ${s.idempotent}` +
        (s.protectedDocuments.length > 0
          ? `  [保留旧点的文档：${s.protectedDocuments.join(", ")}]`
          : ""),
    );
  }

  if (report.failures.length > 0) {
    console.error();
    console.error(`存在 ${report.failures.length} 个失败文档，其旧点已保留：`);
    for (const f of report.failures) console.error(`  - ${f}`);
  }

  const runtimeDir = path.join(MASTRA_ROOT, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const reportPath = path.join(runtimeDir, "rag-ingestion-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n报告已写入：${path.relative(REPO_ROOT, reportPath)}`);

  return report.failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\n摄取失败：");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
