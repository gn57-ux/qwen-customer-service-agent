/**
 * Markdown 摄取：frontmatter 解析校验 + Markdown-aware 分块 + chunk 元数据。
 *
 * 分块用 @mastra/rag 的 MDocument：先按 Markdown 标题切（strategy: "markdown" +
 * headers），拿到每片所属的 h1/h2/h3；再把同一 h2 下过短的相邻片合并到目标区间，
 * 因此既有准确的 section，又能落在 400~800 字符。
 *
 * 目录来源由 config.globs 决定，摄取逻辑本身不认识 "repair"：
 * 将来加 knowledge/policies/*.md 只需扩展 globs，不改本文件。
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MDocument } from "@mastra/rag";

import type { RagConfig } from "./config.ts";

/** frontmatter 必需字段，缺一个就判文档不合格 */
export const REQUIRED_FRONTMATTER = [
  "document_id",
  "document_version",
  "title",
  "domain",
  "source",
  "updated_at",
  "risk_level",
] as const;

export type FrontmatterKey = (typeof REQUIRED_FRONTMATTER)[number];
export type Frontmatter = Record<FrontmatterKey, string> & Record<string, string>;

export interface ParsedDocument {
  sourceFile: string;
  frontmatter: Frontmatter;
  body: string;
  /** 由 sourceFile 相对 knowledgeRoot 的第一层目录推导 */
  ingestionScope: string;
}

export interface Chunk {
  /** 稳定 ID：document_id + chunk_index + content_hash 派生的 UUIDv5 风格标识 */
  id: string;
  text: string;
  documentId: string;
  documentVersion: string;
  title: string;
  section: string;
  domain: string;
  source: string;
  updatedAt: string;
  riskLevel: string;
  chunkIndex: number;
  contentHash: string;
  sourceFile: string;
  /** 知识集合标识，来自配置（本阶段固定 customer-service） */
  knowledgeSet: string;
  /** 摄取范围，由文件在 knowledgeRoot 下的第一层目录名决定（repair / policies / …） */
  ingestionScope: string;
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 YAML 标量解析：本项目的 frontmatter 只有 key: value 标量 */
function parseFrontmatterBlock(block: string, sourceFile: string): Frontmatter {
  const out: Record<string, string> = {};
  for (const [lineNo, line] of block.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
      throw new Error(`${sourceFile} frontmatter 第 ${lineNo + 1} 行不是 key: value 形式：${line}`);
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out as Frontmatter;
}

export function parseDocument(
  sourceFile: string,
  raw: string,
  ingestionScope: string,
): ParsedDocument {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(
      `${sourceFile} 缺少 YAML frontmatter。文件必须以 --- 开头的元数据块起始，` +
        `并包含：${REQUIRED_FRONTMATTER.join("、")}。`,
    );
  }
  const frontmatter = parseFrontmatterBlock(match[1]!, sourceFile);

  const missing = REQUIRED_FRONTMATTER.filter((key) => !frontmatter[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`${sourceFile} frontmatter 缺少必需字段：${missing.join("、")}`);
  }

  const body = raw.slice(match[0].length).trim();
  if (!body) {
    throw new Error(`${sourceFile} frontmatter 之后没有正文内容。`);
  }

  return { sourceFile, frontmatter, body, ingestionScope };
}

// ---------------------------------------------------------------------------
// 文件发现
// ---------------------------------------------------------------------------

/** 支持 "repair/*.md" / "policies/*.md" 这类单层 glob，以及 "**\/*.md" */
async function expandGlob(root: string, glob: string): Promise<string[]> {
  const [dirPart, filePart] = (() => {
    const idx = glob.lastIndexOf("/");
    return idx === -1 ? ["", glob] : [glob.slice(0, idx), glob.slice(idx + 1)];
  })();

  const recursive = dirPart.includes("**");
  const baseDir = path.join(root, recursive ? dirPart.replace(/\*\*.*$/, "") : dirPart);

  let entries: Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true, recursive });
  } catch (cause) {
    throw new Error(
      `无法读取知识库目录 ${baseDir}：${(cause as Error).message}\n` +
        `请确认 KNOWLEDGE_ROOT 与 globs 配置正确（当前 glob：${glob}）。`,
      { cause },
    );
  }

  const pattern = new RegExp(`^${filePart.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
  return entries
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => path.join(e.parentPath ?? baseDir, e.name))
    .sort();
}

export async function discoverFiles(cfg: RagConfig, repoRoot: string): Promise<string[]> {
  const root = path.resolve(repoRoot, cfg.knowledgeRoot);
  const found = new Set<string>();
  for (const glob of cfg.globs) {
    for (const file of await expandGlob(root, glob)) found.add(file);
  }
  const files = [...found].sort();
  if (files.length === 0) {
    throw new Error(
      `在 ${root} 下按 globs=${JSON.stringify(cfg.globs)} 没有找到任何 Markdown 文件。`,
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// 分块
// ---------------------------------------------------------------------------

interface HeaderChunk {
  text: string;
  section: string;
}

function sectionOf(meta: Record<string, unknown>): string {
  // 优先取最深一级标题作为 section，回退到上一级
  const h3 = typeof meta.h3 === "string" ? meta.h3 : "";
  const h2 = typeof meta.h2 === "string" ? meta.h2 : "";
  const h1 = typeof meta.h1 === "string" ? meta.h1 : "";
  if (h2 && h3) return `${h2} / ${h3}`;
  return h2 || h3 || h1 || "正文";
}

/** 把同一 h2 下过短的相邻片合并到 [minChars, maxChars]，超长的按 maxChars 带 overlap 再切 */
function mergeAndSplit(pieces: HeaderChunk[], cfg: RagConfig): HeaderChunk[] {
  const { maxChars, minChars, overlapChars } = cfg.chunk;
  const merged: HeaderChunk[] = [];

  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    const sameTopSection =
      last !== undefined && last.section.split(" / ")[0] === piece.section.split(" / ")[0];

    if (last && sameTopSection && last.text.length < minChars) {
      const candidate = `${last.text}\n\n${text}`;
      if (candidate.length <= maxChars) {
        last.text = candidate;
        // section 以首片为准，但若首片只是标题行则采用更具体的一级
        if (last.text.startsWith(last.section) && piece.section.includes(" / ")) {
          last.section = piece.section;
        }
        continue;
      }
    }
    merged.push({ text, section: piece.section });
  }

  const out: HeaderChunk[] = [];
  for (const piece of merged) {
    if (piece.text.length <= maxChars) {
      out.push(piece);
      continue;
    }
    // 超长片按 maxChars 滑窗切，保留 overlap
    const step = Math.max(1, maxChars - overlapChars);
    for (let start = 0; start < piece.text.length; start += step) {
      const slice = piece.text.slice(start, start + maxChars).trim();
      if (slice) out.push({ text: slice, section: piece.section });
      if (start + maxChars >= piece.text.length) break;
    }
  }
  return out;
}

function stableChunkId(documentId: string, chunkIndex: number, contentHash: string): string {
  // 稳定：同一文档同一位置同一内容 → 同一 ID。内容变化 → 新 ID（旧点由 ingest 清理）。
  const digest = createHash("sha256")
    .update(`${documentId}::${chunkIndex}::${contentHash}`)
    .digest("hex");
  // 拼成 UUID 形状，Qdrant 接受 UUID 字符串作为点 ID
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

export async function chunkDocument(
  doc: ParsedDocument,
  cfg: RagConfig,
): Promise<Chunk[]> {
  const mdoc = MDocument.fromMarkdown(doc.body);
  const raw = await mdoc.chunk({
    strategy: "markdown",
    maxSize: cfg.chunk.maxChars,
    overlap: cfg.chunk.overlapChars,
    headers: [
      ["#", "h1"],
      ["##", "h2"],
      ["###", "h3"],
    ],
  });

  const pieces: HeaderChunk[] = raw.map((c) => ({
    text: c.text,
    section: sectionOf((c.metadata ?? {}) as Record<string, unknown>),
  }));

  const finalPieces = mergeAndSplit(pieces, cfg);
  const fm = doc.frontmatter;

  return finalPieces.map((piece, index) => {
    const contentHash = createHash("sha256").update(piece.text).digest("hex").slice(0, 16);
    return {
      id: stableChunkId(fm.document_id, index, contentHash),
      text: piece.text,
      documentId: fm.document_id,
      documentVersion: fm.document_version,
      title: fm.title,
      section: piece.section,
      domain: fm.domain,
      source: fm.source,
      updatedAt: fm.updated_at,
      riskLevel: fm.risk_level,
      chunkIndex: index,
      contentHash,
      sourceFile: doc.sourceFile,
      knowledgeSet: cfg.knowledgeSet,
      ingestionScope: doc.ingestionScope,
    };
  });
}

/** 由文件相对 knowledgeRoot 的第一层目录推导 ingestion_scope */
export function scopeOf(relativeToKnowledgeRoot: string): string {
  const first = relativeToKnowledgeRoot.split(path.sep)[0] ?? "";
  if (!first || first.endsWith(".md")) {
    throw new Error(
      `无法从路径推导 ingestion_scope：${relativeToKnowledgeRoot}\n` +
        `知识文档必须放在 knowledge/<scope>/ 下，例如 knowledge/repair/xxx.md。`,
    );
  }
  return first;
}

export interface LoadResult {
  documents: ParsedDocument[];
  chunks: Chunk[];
  /** 本次运行覆盖到的 scope 集合，stale 清理只允许作用于这些 scope */
  scopes: string[];
}

export async function loadAndChunk(cfg: RagConfig, repoRoot: string): Promise<LoadResult> {
  const files = await discoverFiles(cfg, repoRoot);
  const knowledgeRootAbs = path.resolve(repoRoot, cfg.knowledgeRoot);
  const documents: ParsedDocument[] = [];
  const chunks: Chunk[] = [];

  // document_id 全局唯一校验：跨文件、跨 scope 都不允许重复
  const documentIdOwner = new Map<string, string>();

  for (const file of files) {
    const relativeToRepo = path.relative(repoRoot, file);
    const relativeToKnowledge = path.relative(knowledgeRootAbs, file);
    const raw = await readFile(file, "utf8");
    const doc = parseDocument(relativeToRepo, raw, scopeOf(relativeToKnowledge));

    const documentId = doc.frontmatter.document_id;
    const owner = documentIdOwner.get(documentId);
    if (owner) {
      throw new Error(
        `document_id 重复：${documentId}\n` +
          `  已被使用：${owner}\n` +
          `  再次出现：${doc.sourceFile}\n` +
          `document_id 必须全局唯一，否则两份文档的 chunk 会互相覆盖、stale 清理也会误删。`,
      );
    }
    documentIdOwner.set(documentId, doc.sourceFile);

    documents.push(doc);
    chunks.push(...(await chunkDocument(doc, cfg)));
  }

  // chunk ID 唯一性（同一 document_id 下 chunk_index 必须唯一）
  const seen = new Map<string, Chunk>();
  for (const chunk of chunks) {
    const existing = seen.get(chunk.id);
    if (existing) {
      throw new Error(
        `chunk ID 冲突：${chunk.id}\n` +
          `  ${existing.sourceFile} #${existing.chunkIndex}\n` +
          `  ${chunk.sourceFile} #${chunk.chunkIndex}`,
      );
    }
    seen.set(chunk.id, chunk);
  }

  const scopes = [...new Set(documents.map((d) => d.ingestionScope))].sort();
  return { documents, chunks, scopes };
}
