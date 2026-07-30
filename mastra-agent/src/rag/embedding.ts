/**
 * Embedding 客户端：本地 Ollama 的 OpenAI 兼容 /v1/embeddings。
 *
 * 硬性约束（与本阶段验收要求一致）：
 * - 入库与查询必须使用同一个模型，模型名来自配置，不做任何隐式回退；
 * - 服务不可用 / 模型不存在 / 维度不符，一律抛出中文错误并中止；
 * - 首次使用前必须对测试文本实测一次：类型 number[]、长度符合预期、无 NaN/Infinity。
 */

import type { RagConfig } from "./config.ts";

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: unknown; index?: number }>;
  model?: string;
  error?: { message?: string; type?: string } | string;
}

export interface EmbeddingClient {
  model: string;
  /** 实测确认的真实维度 */
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

const REQUEST_TIMEOUT_MS = 120_000;

function asErrorMessage(error: OpenAIEmbeddingResponse["error"]): string {
  if (!error) return "";
  return typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
}

async function callEmbeddings(
  cfg: RagConfig,
  input: string[],
): Promise<number[][]> {
  const url = `${cfg.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.embeddingModel, input }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(
      `无法连接 Embedding 服务 ${url}：${(cause as Error).message}\n` +
        `请确认 Ollama 已启动（ollama serve），且 EMBEDDING_BASE_URL 指向其 OpenAI 兼容端点。`,
      { cause },
    );
  }

  const raw = await response.text();
  let payload: OpenAIEmbeddingResponse;
  try {
    payload = JSON.parse(raw) as OpenAIEmbeddingResponse;
  } catch {
    throw new Error(
      `Embedding 服务返回了非 JSON 内容（HTTP ${response.status}）：${raw.slice(0, 200)}`,
    );
  }

  if (!response.ok || payload.error) {
    const message = asErrorMessage(payload.error) || `HTTP ${response.status}`;
    if (/not found|no such model|pull/i.test(message)) {
      throw new Error(
        `Embedding 模型 ${cfg.embeddingModel} 在服务端不存在：${message}\n` +
          `请先执行：ollama pull ${cfg.embeddingModel}\n` +
          `注意：本项目不允许静默回退到其他 Embedding 模型。`,
      );
    }
    throw new Error(`Embedding 请求失败（HTTP ${response.status}）：${message}`);
  }

  const data = payload.data;
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new Error(
      `Embedding 返回条数与输入不符：输入 ${input.length} 条，返回 ${
        Array.isArray(data) ? data.length : "非数组"
      } 条。`,
    );
  }

  return data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item, i) => {
      const vector = item.embedding;
      if (!Array.isArray(vector)) {
        throw new Error(`第 ${i} 条 embedding 不是数组，实际类型：${typeof vector}`);
      }
      for (let j = 0; j < vector.length; j += 1) {
        const value = vector[j];
        if (typeof value !== "number") {
          throw new Error(
            `第 ${i} 条 embedding 的第 ${j} 个元素不是 number，实际类型：${typeof value}`,
          );
        }
        if (Number.isNaN(value) || !Number.isFinite(value)) {
          throw new Error(`第 ${i} 条 embedding 的第 ${j} 个元素为 NaN/Infinity，向量不可用。`);
        }
      }
      return vector as number[];
    });
}

/**
 * 实测校验 Embedding 模型，返回可复用的客户端。
 * 校验不通过直接抛错，绝不带着"预期维度"继续往下跑。
 */
export async function createEmbeddingClient(cfg: RagConfig): Promise<EmbeddingClient> {
  const probeText = "冰箱不制冷应该先检查什么";
  const [vector] = await callEmbeddings(cfg, [probeText]);

  if (!vector) {
    throw new Error("Embedding 校验失败：探测文本没有返回向量。");
  }

  const dimension = vector.length;
  if (dimension !== cfg.embeddingDimension) {
    throw new Error(
      `Embedding 维度与配置不符：模型 ${cfg.embeddingModel} 实测 ${dimension} 维，` +
        `EMBEDDING_DIMENSION 配置为 ${cfg.embeddingDimension} 维。\n` +
        `请修正配置或确认使用的是正确的模型；本项目不接受维度不一致就继续入库。`,
    );
  }

  console.log(
    `Embedding 校验通过：模型=${cfg.embeddingModel} 实测维度=${dimension} ` +
      `类型=number[] NaN/Infinity=无`,
  );

  return {
    model: cfg.embeddingModel,
    dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const vectors = await callEmbeddings(cfg, texts);
      for (const [i, v] of vectors.entries()) {
        if (v.length !== dimension) {
          throw new Error(
            `第 ${i} 条向量维度为 ${v.length}，与已校验维度 ${dimension} 不一致，中止。`,
          );
        }
      }
      return vectors;
    },
  };
}

/** 分批嵌入，避免单请求过大 */
export async function embedInBatches(
  client: EmbeddingClient,
  texts: string[],
  batchSize = 16,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await client.embed(batch);
    out.push(...vectors);
    process.stdout.write(`  嵌入进度 ${Math.min(i + batch.length, texts.length)}/${texts.length}\r`);
  }
  if (texts.length > 0) process.stdout.write("\n");
  return out;
}
