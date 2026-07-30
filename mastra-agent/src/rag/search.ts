/**
 * 检索回归：用同一个 bge-m3 对固定问题做向量召回 Top 5。
 *
 *   npm run rag:search                 # 跑内置 5 个验证查询（回归门禁，见退出码）
 *   npm run rag:search -- "自定义问题"   # 只展示结果，不做 domain 断言
 *
 * 退出码（固定五问模式）：
 *   0  五个查询全部有召回且 Top1 domain 符合预期
 *   1  任一查询无召回结果，或 Top1 domain 不符合预期
 *
 * 检索隔离：所有 query 都按 knowledge_set 过滤（见 store.ts），
 * 同一 Collection 里其他知识集的点不会进入结果；
 * 不限制 ingestion_scope，因此 repair 与将来的 policies 会被一起检索。
 *
 * 重要口径：本阶段**只有向量召回，没有 Rerank**。
 * 输出里的 score 是 Qdrant 的 Cosine 相似度，不是重排分；
 * 也不会把多个向量分数加权后冒充 Rerank，更不会用 risk_level 加权或过滤来"改善"排序。
 */

import { loadConfig } from "./config.ts";
import { createEmbeddingClient } from "./embedding.ts";
import { QdrantKnowledgeStore } from "./store.ts";

interface VerificationQuery {
  question: string;
  /** 期望命中的 domain；固定五问模式下作为回归断言 */
  expectedDomain: string;
}

const QUERIES: VerificationQuery[] = [
  { question: "冰箱不制冷应该先检查什么", expectedDomain: "refrigerator" },
  { question: "电视有声音没有画面怎么办", expectedDomain: "television" },
  { question: "显示器提示无信号怎么排查", expectedDomain: "monitor" },
  { question: "冰箱冒烟还有焦味能继续用吗", expectedDomain: "refrigerator" },
  { question: "显示器USB-C能充电但没有画面", expectedDomain: "monitor" },
];

const TOP_K = 5;

function excerpt(text: unknown, max = 110): string {
  const raw = typeof text === "string" ? text : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : String(value ?? "");
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const custom = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  console.log("=".repeat(78));
  console.log("向量检索回归（仅向量召回，尚未 Rerank）");
  console.log("=".repeat(78));

  const store = new QdrantKnowledgeStore(cfg);
  const version = await store.health();
  const info = await store.describe();
  if (!info.exists) {
    throw new Error(`Collection ${cfg.collection} 不存在。请先执行：npm run rag:ingest`);
  }
  const total = await store.countPoints();
  const inSet = await store.countPoints({ knowledgeSet: cfg.knowledgeSet });
  console.log(
    `Qdrant ${version} | Collection ${cfg.collection} | ${info.dimension} 维 / ${info.metric} | ` +
      `总点数 ${total}（knowledge_set=${cfg.knowledgeSet}: ${inSet}）`,
  );

  const embedder = await createEmbeddingClient(cfg);
  if (info.dimension !== embedder.dimension) {
    throw new Error(
      `查询用的 Embedding 维度（${embedder.dimension}）与 Collection（${info.dimension}）不一致，` +
        `说明入库和查询用的不是同一个模型，中止。`,
    );
  }
  console.log(`查询 Embedding：${embedder.model}（与入库同一模型，${embedder.dimension} 维）`);
  console.log(`检索隔离：knowledge_set=${cfg.knowledgeSet}（不限制 ingestion_scope）`);
  console.log();

  const isRegression = custom.length === 0;
  const queries: VerificationQuery[] = isRegression
    ? QUERIES
    : custom.map((question) => ({ question, expectedDomain: "" }));

  const problems: string[] = [];
  let reasonable = 0;

  for (const [index, query] of queries.entries()) {
    const [vector] = await embedder.embed([query.question]);
    const hits = await store.query(vector!, TOP_K);

    console.log("-".repeat(78));
    console.log(`查询 ${index + 1}/${queries.length}：${query.question}`);
    if (query.expectedDomain) console.log(`期望 domain：${query.expectedDomain}`);
    console.log("-".repeat(78));

    if (hits.length === 0) {
      console.log("  （无召回结果）");
      if (isRegression) problems.push(`查询「${query.question}」无召回结果`);
      console.log();
      continue;
    }

    for (const [i, hit] of hits.entries()) {
      const p = hit.payload;
      console.log(
        `  #${i + 1}  score=${hit.score.toFixed(4)}  domain=${str(p, "domain")}  ` +
          `knowledge_set=${str(p, "knowledge_set")}  scope=${str(p, "ingestion_scope")}\n` +
          `      title      : ${str(p, "title")}\n` +
          `      section    : ${str(p, "section")}\n` +
          `      source_file: ${str(p, "source_file")}  chunk_index=${str(p, "chunk_index")}\n` +
          `      text       : ${excerpt(p.text)}`,
      );
    }

    const topDomain = str(hits[0]!.payload, "domain");
    if (query.expectedDomain) {
      const ok = topDomain === query.expectedDomain;
      if (ok) reasonable += 1;
      else problems.push(`查询「${query.question}」Top1 domain=${topDomain}，期望 ${query.expectedDomain}`);
      console.log(
        `  Top1 domain 判断：${ok ? "合理" : "不合理"}（实际 ${topDomain}，期望 ${query.expectedDomain}）`,
      );
    }
    console.log();
  }

  console.log("=".repeat(78));
  console.log("说明：以上 score 为 Qdrant Cosine 相似度，属于**向量召回**结果。");
  console.log("      当前只有向量召回，尚未 Rerank；向量分数不构成重排，也未使用 risk_level 加权或过滤。");

  if (!isRegression) {
    console.log("      自定义查询模式：只展示结果，不做 domain 断言，退出码固定 0。");
    console.log("=".repeat(78));
    return 0;
  }

  console.log(`Top1 domain 合理数：${reasonable}/${queries.length}`);
  if (problems.length > 0) {
    console.log("回归失败：");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("=".repeat(78));
    return 1;
  }
  console.log("回归通过：五个查询均有召回，且 Top1 domain 全部符合预期。");
  console.log("=".repeat(78));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\n检索回归失败：");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
