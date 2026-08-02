/**
 * "建议升级为 AGENTS.md 规则"候选生成器——只生成建议报告，**不自动
 * 修改 `AGENTS.md`**。扫描 `status=verified` 且
 * `occurrence_count >= 阈值`（默认 3）的经验，生成 Markdown 报告到
 * `workflow-experience/suggested-rules/`（刻意在 `knowledge/experience/`
 * 摄取根目录之外，不会被 `experience:ingest`/`rebuild`/`audit` 误
 * 扫描/误报 schema 校验失败）。
 *
 * 生成前对每条候选内容再跑一次防御性 `redact()`——即使理论上
 * `verified` 经验已经在写入时脱敏过，成本很低的"再扫一次"能避免任何
 * 遗漏累积到规则建议报告里。**必须检查 `blocked`，不能只取
 * `.text`**：Token/Key/Cookie、疑似聊天原文这两类命中时 `redact()`
 * 按 Feature 1 的设计直接返回 `blocked: true`，且不保证 `.text` 是
 * 安全替换后的文本——若只读 `.text` 而忽略 `blocked`，未处理的敏感
 * 原文会被写进建议报告，正好绕开了防御性脱敏本该拦住的东西。命中的
 * 候选整条排除出报告，只留痕 `document_id` + 排除原因，不回显命中
 * 内容本身。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { redact } from "./redact.ts";
import { scanExperienceFiles, type ScannedExperienceFile } from "./scan.ts";
import { parseExperienceSections } from "./schema.ts";
import { atomicWriteExperience } from "./write.ts";

export const DEFAULT_RULE_THRESHOLD = 3;

export interface IncludedEntry {
  skipped: false;
  documentId: string;
  suggestedRule: string;
  evidence: { documentId: string; occurrenceCount: number; sourceFile: string; title: string };
}

export interface SkippedEntry {
  skipped: true;
  documentId: string;
  reason: string;
}

export type SuggestionEntry = IncludedEntry | SkippedEntry;

/** 从一份经验的正文里提炼"候选规则文本"——触发场景 + 正确处理 + 适用范围三节 */
function buildRuleText(file: ScannedExperienceFile): string {
  const sections = parseExperienceSections(file.body);
  const parts = [sections.get("触发场景"), sections.get("正确处理"), sections.get("适用范围")].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  return parts.join("\n");
}

export function buildSuggestions(
  files: ScannedExperienceFile[],
  threshold: number = DEFAULT_RULE_THRESHOLD,
): SuggestionEntry[] {
  const candidates = files.filter(
    (f) => f.frontmatter?.status === "verified" && (f.frontmatter?.occurrence_count ?? 0) >= threshold,
  );

  return candidates.map((file): SuggestionEntry => {
    const fm = file.frontmatter!;
    const ruleText = buildRuleText(file);
    const redacted = redact(ruleText);
    if (redacted.blocked) {
      return {
        skipped: true,
        documentId: fm.document_id,
        reason: "内容包含无法安全处理的敏感信息（Token/Key/Cookie 或疑似聊天原文），已跳过，不纳入建议报告",
      };
    }
    return {
      skipped: false,
      documentId: fm.document_id,
      suggestedRule: redacted.text,
      evidence: {
        documentId: fm.document_id,
        occurrenceCount: fm.occurrence_count,
        sourceFile: file.relativePath,
        title: fm.title,
      },
    };
  });
}

function renderEntry(entry: SuggestionEntry): string {
  if (entry.skipped) {
    return `### ${entry.documentId}（已跳过）\n\n${entry.reason}`;
  }
  return [
    `### ${entry.evidence.title}`,
    "",
    `- document_id: ${entry.evidence.documentId}`,
    `- 出现次数: ${entry.evidence.occurrenceCount}`,
    `- 来源: ${entry.evidence.sourceFile}`,
    "",
    "**候选规则文本**（需人工审阅后手动写入 AGENTS.md，不会被自动写入）：",
    "",
    entry.suggestedRule,
  ].join("\n");
}

export function renderReport(entries: SuggestionEntry[], threshold: number): string {
  const included = entries.filter((e): e is IncludedEntry => !e.skipped);
  const skipped = entries.filter((e): e is SkippedEntry => e.skipped);

  const header = [
    "# AGENTS.md 规则候选建议报告",
    "",
    `阈值：occurrence_count >= ${threshold}`,
    `候选数：${included.length}（另有 ${skipped.length} 条因敏感信息被跳过）`,
    "",
    "**以下均为建议，需人工审阅后手动写入 AGENTS.md，本报告不会自动修改任何文件。**",
    "",
    "---",
  ].join("\n");

  const body = entries.map(renderEntry).join("\n\n---\n\n");
  return `${header}\n\n${body}\n`;
}

export interface SuggestRulesReport {
  reportPath: string;
  includedCount: number;
  skippedCount: number;
}

export async function runSuggestRules(
  experienceRoot: string,
  suggestedRulesDir: string,
  threshold: number = DEFAULT_RULE_THRESHOLD,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<SuggestRulesReport> {
  const files = await scanExperienceFiles(experienceRoot);
  const entries = buildSuggestions(files, threshold);
  const report = renderReport(entries, threshold);

  await fs.mkdir(suggestedRulesDir, { recursive: true });
  const reportPath = path.join(suggestedRulesDir, `${today}.md`);
  await atomicWriteExperience(reportPath, report);

  return {
    reportPath,
    includedCount: entries.filter((e) => !e.skipped).length,
    skippedCount: entries.filter((e) => e.skipped).length,
  };
}
