/**
 * 检索结果格式化为可直接注入 Execute/Review 上下文的精简文本。
 *
 * 超过长度上限时按整条经验丢弃（从低分开始），不截断单条经验内部
 * 文本到语义不完整——裁剪单位是"整条经验"（F-006/AC-005）。
 */

import type { RetrievedLesson } from "./retrieve.ts";

function renderLesson(lesson: RetrievedLesson): string {
  return [
    `### ${lesson.title}（相关度 ${lesson.relevanceScore.toFixed(2)}，v${lesson.documentVersion}）`,
    `- 教训：${lesson.summary}`,
    `- 正确做法：${lesson.correctAction}`,
    `- 验证方式：${lesson.verificationMethod}`,
    `- 来源：${lesson.sourceFile}`,
  ].join("\n");
}

export function formatForInjection(lessons: RetrievedLesson[]): string {
  const maxChars = Number(process.env.EXPERIENCE_MAX_INJECTION_CHARS || 2000);
  const sorted = [...lessons].sort((a, b) => b.relevanceScore - a.relevanceScore);

  const kept: string[] = [];
  let total = 0;
  for (const lesson of sorted) {
    const block = renderLesson(lesson);
    // "\n\n" 分隔符也计入预算，避免拼接后实际长度悄悄超过 maxChars。
    const addedLength = block.length + (kept.length > 0 ? 2 : 0);
    // 相关度最高的第一条始终完整保留，即使它单独就超过预算——"裁剪单位
    // 是整条经验"针对的是第二条起的低分条目，不能反过来把预算不够
    // 塞下唯一一条最相关经验当成"返回空结果"的理由，那比截断更违反
    // "不得裁剪到语义不完整"的精神。
    if (kept.length > 0 && total + addedLength > maxChars) break;
    kept.push(block);
    total += addedLength;
  }

  return kept.join("\n\n");
}
