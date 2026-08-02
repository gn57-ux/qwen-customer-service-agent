/**
 * 只读巡检 CLI 入口——frontmatter 校验/脱敏扫描/孤儿文件/悬空向量点。
 * 只读，不修改任何文件或向量点，始终以退出码 0 结束（巡检命令）。
 *
 *   npm run experience:audit
 */

import { loadExperienceConfig } from "../src/experience/config.ts";
import { auditExperience } from "../src/experience/audit.ts";
import { ExperienceStore } from "../src/experience/store.ts";

async function main(): Promise<number> {
  const cfg = loadExperienceConfig();
  const store = new ExperienceStore(cfg);

  const report = await auditExperience(cfg.knowledgeRoot, store);

  console.log("=== Claude Workflow Experience 巡检报告（只读） ===");
  console.log(`扫描文件数：${report.scannedCount}`);
  console.log();

  console.log(`frontmatter 校验失败：${report.validationFindings.length} 份`);
  for (const finding of report.validationFindings) {
    console.log(`  - ${finding.relativePath}: ${finding.errors.join("; ")}`);
  }
  console.log();

  console.log(`脱敏规则命中：${report.redactionFindings.length} 份（只报告行号，不回显原文）`);
  for (const finding of report.redactionFindings) {
    const where = finding.fileLevel ? "文件级（跨行规则）" : `第 ${finding.lines.join(", ")} 行`;
    console.log(`  - ${finding.relativePath}: ${where}`);
  }
  console.log();

  console.log(`孤儿文件（存在但未入 Qdrant，建议 experience:ingest 补齐）：${report.orphanFiles.length}`);
  for (const documentId of report.orphanFiles) {
    console.log(`  - ${documentId}`);
  }
  console.log();

  console.log(`悬空向量点（Qdrant 有点但文件已删除，建议 experience:rebuild 清理）：${report.danglingDocumentIds.length}`);
  for (const documentId of report.danglingDocumentIds) {
    console.log(`  - ${documentId}`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:audit 执行失败：", error);
    process.exit(1);
  });
