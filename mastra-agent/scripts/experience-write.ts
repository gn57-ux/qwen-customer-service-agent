/**
 * N5 专用 CLI 入口——把一份候选经验（`candidate` 状态）写入
 * `knowledge/experience/` 并尝试摄取向量索引。核心逻辑（含 Embedding
 * 不可用时的降级）在 `writeExperienceWithFallback()`（可单测），本文件
 * 只做参数解析和打印。
 *
 *   npm run experience:write -- --input candidate.json
 *   cat candidate.json | npm run experience:write
 *
 * candidate.json 形状（UpsertCandidate 去掉 experienceRoot，由本 CLI
 * 从配置里注入）：
 *   { "title", "stage", "taskType", "projectScope", "source",
 *     "riskLevel", "body" }
 */

import fs from "node:fs/promises";

import { loadExperienceConfig } from "../src/experience/config.ts";
import { ExperienceStore } from "../src/experience/store.ts";
import type { UpsertCandidate } from "../src/experience/write.ts";
import { writeExperienceWithFallback } from "../src/experience/write-and-ingest.ts";

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

type CandidateInput = Omit<UpsertCandidate, "experienceRoot">;

const REQUIRED_FIELDS: Array<keyof CandidateInput> = [
  "title",
  "stage",
  "taskType",
  "projectScope",
  "source",
  "riskLevel",
  "body",
];

async function main(): Promise<number> {
  const inputPath = argValue("--input");
  const raw = inputPath ? await fs.readFile(inputPath, "utf-8") : await readStdin();

  let parsed: CandidateInput;
  try {
    parsed = JSON.parse(raw) as CandidateInput;
  } catch (e) {
    console.error(`输入 JSON 格式错误：${(e as Error).message}`);
    return 1;
  }

  const missing = REQUIRED_FIELDS.filter((field) => !parsed[field]);
  if (missing.length > 0) {
    console.error(`输入缺少必填字段：${missing.join(", ")}`);
    return 1;
  }

  const cfg = loadExperienceConfig();
  const candidate: UpsertCandidate = { ...parsed, experienceRoot: cfg.knowledgeRoot };
  const store = new ExperienceStore(cfg);

  const result = await writeExperienceWithFallback(candidate, cfg, store);

  console.log(`ok=${result.ok}`);
  if (result.ok) {
    console.log(`document_id=${result.documentId} version=${result.documentVersion} occurrence_count=${result.occurrenceCount}`);
    console.log(`file=${result.filePath}`);
    console.log(`ingested=${result.ingested}${result.ingestWarning ? ` (${result.ingestWarning})` : ""}`);
  } else {
    console.log(`reason=${result.reason}`);
    if (result.errors?.length) console.log(`errors=${result.errors.join("; ")}`);
  }

  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("experience:write 执行失败：", error);
    process.exit(1);
  });
