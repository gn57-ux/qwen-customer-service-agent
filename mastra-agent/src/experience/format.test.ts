import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { formatForInjection } from "./format.ts";
import type { RetrievedLesson } from "./retrieve.ts";

function lesson(overrides: Partial<RetrievedLesson> = {}): RetrievedLesson {
  return {
    title: "锁竞态修复经验",
    summary: "问题表现...\n根因...",
    correctAction: "正确处理...",
    verificationMethod: "验证方法...",
    sourceFile: "my-project/abc123.md",
    documentVersion: 1,
    relevanceScore: 0.8,
    ...overrides,
  };
}

const originalEnv = process.env.EXPERIENCE_MAX_INJECTION_CHARS;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.EXPERIENCE_MAX_INJECTION_CHARS;
  else process.env.EXPERIENCE_MAX_INJECTION_CHARS = originalEnv;
});

describe("formatForInjection", () => {
  it("空数组返回空字符串", () => {
    assert.equal(formatForInjection([]), "");
  });

  it("单条经验包含标题/相关度/版本号/教训/正确做法/验证方式/来源七项信息", () => {
    const text = formatForInjection([lesson()]);
    assert.match(text, /锁竞态修复经验/);
    assert.match(text, /相关度 0\.80/);
    assert.match(text, /v1/);
    assert.match(text, /问题表现\.\.\.\n根因\.\.\./);
    assert.match(text, /正确处理\.\.\./);
    assert.match(text, /验证方法\.\.\./);
    assert.match(text, /my-project\/abc123\.md/);
  });

  it("按 relevanceScore 降序排列，不管传入顺序如何", () => {
    const text = formatForInjection([
      lesson({ title: "低分经验", relevanceScore: 0.3 }),
      lesson({ title: "高分经验", relevanceScore: 0.9 }),
    ]);
    assert.ok(text.indexOf("高分经验") < text.indexOf("低分经验"));
  });

  it("超出长度上限时按整条经验丢弃低分条目，不截断单条经验内部文本（AC-005）", () => {
    process.env.EXPERIENCE_MAX_INJECTION_CHARS = "50";
    const longLesson = lesson({ title: "第一条", relevanceScore: 0.9, summary: "很长的正文".repeat(10) });
    const shortLesson = lesson({ title: "第二条", relevanceScore: 0.1, summary: "简短" });

    const text = formatForInjection([shortLesson, longLesson]);

    // 高分条目本身超过上限也应该完整保留（不截断内部文本），
    // 只是低分条目会被整条丢弃。
    assert.match(text, /第一条/);
    assert.ok(text.includes(longLesson.summary), "高分条目的正文不应被截断到语义不完整");
    assert.ok(!text.includes("第二条"), "预算耗尽后应整条丢弃低分条目，而不是截断拼接");
  });

  it("多条经验都在预算内时全部保留", () => {
    process.env.EXPERIENCE_MAX_INJECTION_CHARS = "5000";
    const text = formatForInjection([lesson({ title: "A" }), lesson({ title: "B" }), lesson({ title: "C" })]);
    assert.match(text, /A/);
    assert.match(text, /B/);
    assert.match(text, /C/);
  });
});
