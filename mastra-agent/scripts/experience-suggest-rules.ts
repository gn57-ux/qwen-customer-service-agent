/**
 * "建议升级为 AGENTS.md 规则"候选生成 CLI 入口——只生成建议报告到
 * `workflow-experience/suggested-rules/`，不自动修改 AGENTS.md。
 *
 *   npm run experience:suggest-rules
 *   EXPERIENCE_RULE_THRESHOLD=5 npm run experience:suggest-rules
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadExperienceConfig } from "../src/experience/config.ts";
import { DEFAULT_RULE_THRESHOLD, runSuggestRules } from "../src/experience/suggest-rules.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTRA_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(MASTRA_ROOT, "..");

async function main(): Promise<number> {
  const cfg = loadExperienceConfig();
  const threshold = Number(process.env.EXPERIENCE_RULE_THRESHOLD || DEFAULT_RULE_THRESHOLD);
  const suggestedRulesDir = path.join(REPO_ROOT, "workflow-experience", "suggested-rules");

  const report = await runSuggestRules(cfg.knowledgeRoot, suggestedRulesDir, threshold);

  console.log(`阈值 occurrence_count >= ${threshold}`);
  console.log(`候选规则：${report.includedCount} 条，跳过（敏感信息）：${report.skippedCount} 条`);
  console.log(`报告已写入：${report.reportPath}`);
  console.log("以上均为建议，需人工审阅后手动写入 AGENTS.md，本命令未修改任何文件之外的内容。");

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:suggest-rules 执行失败：", error);
    process.exit(1);
  });
