/**
 * `experience:audit` 的核心逻辑——只读巡检，不修改任何文件或向量点：
 * 1. frontmatter 校验失败的文件；
 * 2. 脱敏规则命中（复用 Feature 1 `redact()`，只报告行号，不回显原文
 *    ——AC-006 要求脱敏扫描报告本身不得回显敏感原文）；
 * 3. 孤儿文件（文件存在但 Qdrant 里没有对应向量点）；
 * 4. 悬空向量点（Qdrant 有点，但对应文件已删除）。
 */

import { redact } from "./redact.ts";
import { validateExperience } from "./schema.ts";
import { scanExperienceFiles } from "./scan.ts";
import type { ExperienceStore } from "./store.ts";

export interface ValidationFinding {
  relativePath: string;
  errors: string[];
}

export interface RedactionFinding {
  relativePath: string;
  /** 只报告命中的大致行号，不回显具体内容 */
  lines: number[];
  /** 未能定位到具体行（多行组合规则等）时为 true，仍然报告"该文件命中"，只是没有行号 */
  fileLevel: boolean;
}

export interface AuditReport {
  scannedCount: number;
  validationFindings: ValidationFinding[];
  redactionFindings: RedactionFinding[];
  /** 文件存在但 Qdrant 无对应向量点 */
  orphanFiles: string[];
  /** Qdrant 有向量点但对应文件已删除 */
  danglingDocumentIds: string[];
}

function findRedactionLines(raw: string): { lines: number[]; fileLevel: boolean } {
  const overall = redact(raw);
  if (!overall.blocked && overall.redactedCount === 0) return { lines: [], fileLevel: false };

  const lines: number[] = [];
  const rawLines = raw.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const perLine = redact(rawLines[i]!);
    if (perLine.blocked || perLine.redactedCount > 0) lines.push(i + 1);
  }
  // 整份文件判定为命中，但逐行扫描一条都没定位到——说明命中的是跨行
  // 规则（如连续多行的聊天记录片段检测），只能报告"该文件命中"，
  // 不强行编造一个不准确的行号。
  return { lines, fileLevel: lines.length === 0 };
}

export async function auditExperience(
  experienceRoot: string,
  store: ExperienceStore,
): Promise<AuditReport> {
  const files = await scanExperienceFiles(experienceRoot);

  const validationFindings: ValidationFinding[] = [];
  const redactionFindings: RedactionFinding[] = [];
  const fileDocumentIds = new Set<string>();

  for (const file of files) {
    if (!file.frontmatter) {
      validationFindings.push({ relativePath: file.relativePath, errors: [file.parseError ?? "frontmatter 解析失败"] });
    } else {
      fileDocumentIds.add(file.frontmatter.document_id);
      const validation = validateExperience(file.frontmatter, file.body);
      if (!validation.ok) {
        validationFindings.push({ relativePath: file.relativePath, errors: validation.errors });
      }
    }

    const { lines, fileLevel } = findRedactionLines(file.raw);
    if (lines.length > 0 || fileLevel) {
      redactionFindings.push({ relativePath: file.relativePath, lines, fileLevel });
    }
  }

  const existingPoints = await store.listPoints({ knowledgeSet: store.knowledgeSet });
  const qdrantDocumentIds = new Set(existingPoints.map((p) => p.documentId).filter(Boolean));

  const orphanFiles = [...fileDocumentIds].filter((id) => !qdrantDocumentIds.has(id));
  const danglingDocumentIds = [...qdrantDocumentIds].filter((id) => !fileDocumentIds.has(id));

  return {
    scannedCount: files.length,
    validationFindings,
    redactionFindings,
    orphanFiles,
    danglingDocumentIds,
  };
}
