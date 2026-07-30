/**
 * 检索回归：bge-m3 向量召回 Top20 → 独立 Cross-Encoder Rerank → Top5。
 *
 *   npm run rag:search                 # 固定五问回归（验收门禁，见退出码）
 *   npm run rag:search -- "自定义问题"   # 只展示结果，不做断言
 *
 * 退出码（固定五问模式）：
 *   0  五问均有召回、Rerank 正常执行、Top1 domain 全部符合预期
 *   1  任一查询无召回 / Top1 domain 不符 / Rerank 处于 unavailable
 *
 * 分数口径（不可混淆）：
 * - `vectorScore` / `vectorRank` 来自 Qdrant 的 Cosine 相似度；
 * - `rerankScore` / `rerankRank` 来自 bge-reranker-v2-m3 的交叉编码打分；
 * - 两者**分别保留**，不合成综合分，也不用向量顺序冒充 Rerank；
 * - `risk_level` 不参与任何打分。
 *
 * 检索隔离：所有 query 按 knowledge_set 过滤，不限制 ingestion_scope。
 */

import { loadConfig } from "./config.ts";
import { createEmbeddingClient } from "./embedding.ts";
import { createReranker, loadRerankerConfig, type RerankDocument } from "./rerank.ts";
import { QdrantKnowledgeStore, type StoreHit } from "./store.ts";

interface VerificationQuery {
  question: string;
  expectedDomain: string;
}

const QUERIES: VerificationQuery[] = [
  { question: "冰箱不制冷应该先检查什么", expectedDomain: "refrigerator" },
  { question: "电视有声音没有画面怎么办", expectedDomain: "television" },
  { question: "显示器提示无信号怎么排查", expectedDomain: "monitor" },
  { question: "冰箱冒烟还有焦味能继续用吗", expectedDomain: "refrigerator" },
  { question: "显示器USB-C能充电但没有画面", expectedDomain: "monitor" },
];

const RECALL_TOP_N = Number(process.env.RAG_RECALL_TOP_N || 20);
const FINAL_TOP_K = Number(process.env.RAG_FINAL_TOP_K || 5);

function excerpt(text: unknown, max = 76): string {
  const raw = typeof text === "string" ? text : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function label(hit: StoreHit): string {
  const p = hit.payload;
  return `${str(p, "domain")} | ${str(p, "section")}`;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const rerankCfg = loadRerankerConfig();
  const custom = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  console.log("=".repeat(96));
  console.log(`检索回归：向量召回 Top${RECALL_TOP_N} → Cross-Encoder Rerank → Top${FINAL_TOP_K}`);
  console.log("=".repeat(96));

  const store = new QdrantKnowledgeStore(cfg);
  const version = await store.health();
  const info = await store.describe();
  if (!info.exists) {
    throw new Error(`Collection ${cfg.collection} 不存在。请先执行：npm run rag:ingest`);
  }
  const total = await store.countPoints();
  const inSet = await store.countPoints({ knowledgeSet: cfg.knowledgeSet });
  console.log(
    `Qdrant ${version} | ${cfg.collection} | ${info.dimension} 维 / ${info.metric} | ` +
      `总点数 ${total}（knowledge_set=${cfg.knowledgeSet}: ${inSet}）`,
  );

  const embedder = await createEmbeddingClient(cfg);
  if (info.dimension !== embedder.dimension) {
    throw new Error(
      `查询用的 Embedding 维度（${embedder.dimension}）与 Collection（${info.dimension}）不一致，中止。`,
    );
  }
  console.log(`向量模型：${embedder.model}（与入库同一模型，${embedder.dimension} 维）`);
  console.log(`检索隔离：knowledge_set=${cfg.knowledgeSet}（不限制 ingestion_scope）`);

  const reranker = createReranker(rerankCfg);
  const health = await reranker.health();
  console.log(`Reranker ：${reranker.name}`);
  console.log(
    `           enabled=${rerankCfg.enabled}  ${health.available ? "可用" : "不可用"} —— ${health.detail}`,
  );
  console.log();

  const isRegression = custom.length === 0;
  const queries: VerificationQuery[] = isRegression
    ? QUERIES
    : custom.map((question) => ({ question, expectedDomain: "" }));

  const problems: string[] = [];
  const timings: Array<{ q: string; embedMs: number; searchMs: number; rerankMs: number | null }> = [];
  let domainOk = 0;
  let sawUnavailable = false;

  for (const [index, query] of queries.entries()) {
    const t0 = Date.now();
    const [vector] = await embedder.embed([query.question]);
    const t1 = Date.now();
    const hits = await store.query(vector!, RECALL_TOP_N);
    const t2 = Date.now();

    console.log("─".repeat(96));
    console.log(`查询 ${index + 1}/${queries.length}：${query.question}`);
    if (query.expectedDomain) console.log(`期望 domain：${query.expectedDomain}`);
    console.log("─".repeat(96));

    if (hits.length === 0) {
      console.log("  （无召回结果）");
      if (isRegression) problems.push(`查询「${query.question}」无召回结果`);
      console.log();
      continue;
    }

    const byId = new Map(hits.map((h) => [h.id, h]));
    const vectorRankOf = new Map(hits.map((h, i) => [h.id, i + 1]));
    const docs: RerankDocument[] = hits.map((h) => ({
      id: h.id,
      text: str(h.payload, "text"),
    }));

    const rr = await reranker.rerank(query.question, docs, FINAL_TOP_K);
    timings.push({
      q: query.question,
      embedMs: t1 - t0,
      searchMs: t2 - t1,
      rerankMs: rr.elapsedMs,
    });

    // ---- Rerank 前：向量召回 Top20 ----
    console.log(`  【Rerank 前】向量召回 Top${hits.length}（vector_score）`);
    for (const [i, hit] of hits.entries()) {
      const mark = i < FINAL_TOP_K ? "*" : " ";
      console.log(
        `   ${mark}v${String(i + 1).padStart(2)}  ${hit.score.toFixed(4)}  ${label(hit)}`,
      );
    }
    console.log();

    // ---- Rerank 后：Top5 ----
    if (rr.status !== "ok") {
      const tag = rr.status === "disabled" ? "已显式关闭" : "降级";
      console.log(`  【Rerank 后】未产出：${tag} —— ${rr.reason ?? ""}`);
      if (rr.status === "disabled") {
        console.log(`  以下为**未经过 Rerank**的向量顺序 Top${FINAL_TOP_K}（rerankScore=null）：`);
        for (const [i, hit] of hits.slice(0, FINAL_TOP_K).entries()) {
          console.log(
            `    r${i + 1}  vectorScore=${hit.score.toFixed(4)}  vectorRank=${i + 1}  ` +
              `rerankScore=null  ${label(hit)}`,
          );
        }
      } else {
        sawUnavailable = true;
        console.log("  不输出向量顺序冒充 Rerank 结果。");
        if (isRegression) {
          problems.push(`查询「${query.question}」Rerank 不可用：${rr.reason ?? ""}`);
        }
      }
      console.log();
      continue;
    }

    console.log(`  【Rerank 后】Top${rr.ranked.length}（rerank_score，耗时 ${rr.elapsedMs}ms）`);
    for (const item of rr.ranked) {
      const hit = byId.get(item.id)!;
      const vRank = vectorRankOf.get(item.id)!;
      const delta = vRank - (item.rerankRank ?? 0);
      const move = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : "＝";
      console.log(
        `    r${item.rerankRank}  rerankScore=${item.rerankScore!.toFixed(4)}  ` +
          `vectorRank=v${vRank}(${hit.score.toFixed(4)})  ${move}  ` +
          `knowledge_set=${str(hit.payload, "knowledge_set")} scope=${str(hit.payload, "ingestion_scope")}`,
      );
      console.log(
        `         ${str(hit.payload, "title")} / ${str(hit.payload, "section")}\n` +
          `         ${str(hit.payload, "source_file")}  chunk_index=${str(hit.payload, "chunk_index")}\n` +
          `         ${excerpt(hit.payload.text)}`,
      );
    }

    const topHit = byId.get(rr.ranked[0]!.id)!;
    const topDomain = str(topHit.payload, "domain");
    if (query.expectedDomain) {
      const ok = topDomain === query.expectedDomain;
      if (ok) domainOk += 1;
      else problems.push(`查询「${query.question}」Rerank Top1 domain=${topDomain}，期望 ${query.expectedDomain}`);
      console.log(`  Rerank Top1 domain：${ok ? "合理" : "不合理"}（实际 ${topDomain}）`);
    }
    console.log();
  }

  // ---- 汇总 ----
  console.log("=".repeat(96));
  console.log("分数口径：vectorScore 来自 Qdrant Cosine；rerankScore 来自 bge-reranker-v2-m3 交叉编码。");
  console.log("          两者分别保留，未合成综合分，未用向量顺序冒充 Rerank，risk_level 未参与打分。");

  if (timings.length > 0) {
    console.log();
    console.log("耗时（毫秒）：");
    console.log(`  ${"查询".padEnd(30)} ${"embed".padStart(7)} ${"search".padStart(7)} ${"rerank".padStart(7)}`);
    for (const t of timings) {
      const q = t.q.length > 26 ? `${t.q.slice(0, 26)}…` : t.q;
      console.log(
        `  ${q.padEnd(30)} ${String(t.embedMs).padStart(7)} ${String(t.searchMs).padStart(7)} ` +
          `${String(t.rerankMs ?? "-").padStart(7)}`,
      );
    }
  }

  if (!isRegression) {
    console.log("自定义查询模式：只展示结果，不做断言，退出码固定 0。");
    console.log("=".repeat(96));
    return 0;
  }

  console.log();
  console.log(`Rerank Top1 domain 合理数：${domainOk}/${queries.length}`);
  if (problems.length > 0) {
    console.log("回归失败：");
    for (const p of problems) console.log(`  - ${p}`);
    if (sawUnavailable) {
      console.log("  提示：Reranker 不可用时验收模式一律判失败，不接受向量顺序作为替代。");
    }
    console.log("=".repeat(96));
    return 1;
  }
  console.log("回归通过：五问均有召回，Rerank 正常执行，Top1 domain 全部符合预期。");
  console.log("=".repeat(96));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\n检索回归失败：");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
