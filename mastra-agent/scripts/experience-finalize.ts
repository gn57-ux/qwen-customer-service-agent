/**
 * N8 专用 CLI 入口——接收本轮 Codex Review 最终结论 + 测试结果，只有
 * 明确 ALLOW 时才把候选经验从 candidate 转 verified。不提供 --force
 * 这类绕过条件检查的开关。
 *
 *   npm run experience:finalize -- --input result.json
 *   cat result.json | npm run experience:finalize
 *
 * result.json 形状见 FinalizeInput（src/experience/finalize.ts）。
 */

import fs from "node:fs/promises";

import { loadExperienceConfig } from "../src/experience/config.ts";
import { finalizeCandidates, type FinalizeInput } from "../src/experience/finalize.ts";
import { ExperienceStore } from "../src/experience/store.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<number> {
  const inputPath = argValue("--input");
  const raw = inputPath ? await fs.readFile(inputPath, "utf-8") : await readStdin();

  let input: FinalizeInput;
  try {
    input = JSON.parse(raw) as FinalizeInput;
  } catch (e) {
    console.error(`输入 JSON 格式错误：${(e as Error).message}`);
    return 1;
  }
  if (!Array.isArray(input.candidateDocumentIds) || input.candidateDocumentIds.length === 0) {
    console.error("输入缺少非空的 candidateDocumentIds 数组");
    return 1;
  }

  const cfg = loadExperienceConfig();
  const store = new ExperienceStore(cfg);
  const result = await finalizeCandidates(input, cfg.knowledgeRoot, store);

  const promoted = result.outcomes.filter((o) => o.outcome === "promoted").length;
  const alreadyVerified = result.outcomes.filter((o) => o.outcome === "already_verified").length;
  const notPromoted = result.outcomes.filter((o) => o.outcome === "not_promoted");
  const lockLost = result.outcomes.filter((o) => o.outcome === "lock_lost").length;
  const notFound = result.outcomes.filter((o) => o.outcome === "not_found").length;
  const vectorsMissing = result.outcomes.filter((o) => o.outcome === "vectors_missing");

  console.log("=== 本轮经验统计 ===");
  console.log(`新增 verified: ${promoted}`);
  console.log(`已经是 verified（复用，无需变更）: ${alreadyVerified}`);
  console.log(`保持 candidate（未满足晋升条件）: ${notPromoted.length}`);
  for (const item of notPromoted) {
    if (item.outcome === "not_promoted") console.log(`  - ${item.documentId}: ${item.reason}`);
  }
  if (lockLost > 0) console.log(`锁丢失（可重试）: ${lockLost}`);
  if (notFound > 0) console.log(`未找到对应文件: ${notFound}`);
  if (vectorsMissing.length > 0) {
    console.log(`向量点缺失（可重试，需先 rebuild/重新摄取）: ${vectorsMissing.length}`);
    for (const item of vectorsMissing) {
      if (item.outcome === "vectors_missing") console.log(`  - ${item.documentId}: ${item.reason}`);
    }
  }

  // 只有每个候选都拿到"已解决"的终态（promoted/already_verified/not_promoted）
  // 才算成功——not_found/lock_lost/vectors_missing 都是可重试的未决状态，
  // 混入批次时整批必须报失败，调用方（N8）才不会误删还需要重试的候选清单。
  const RETRYABLE = new Set(["not_found", "lock_lost", "vectors_missing"]);
  const hasUnresolved = result.outcomes.some((o) => RETRYABLE.has(o.outcome));
  return hasUnresolved ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:finalize 执行失败：", error);
    process.exit(1);
  });
