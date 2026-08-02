import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ExperienceFrontmatter,
  generateDocumentId,
  parseExperienceFile,
  parseExperienceSections,
  serializeExperienceFile,
  validateExperience,
} from "./schema.ts";

const VALID_BODY = [
  "# 标题",
  "## 触发场景",
  "描述触发场景",
  "## 问题表现",
  "描述问题表现",
  "## 错误做法",
  "描述错误做法",
  "## 根因",
  "描述根因",
  "## 正确处理",
  "描述正确处理",
  "## 验证方法",
  "描述验证方法",
  "## 适用范围",
  "描述适用范围",
  "## 不适用范围",
  "描述不适用范围",
  "## 可提升为稳定规则的条件",
  "描述条件",
  "",
].join("\n");

function validFrontmatter(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "abc123",
    document_version: 1,
    title: "测试经验",
    domain: "workflow-experience",
    stage: "execute",
    task_type: "backend",
    project_scope: "ai-kefu",
    source: "yd:ai N5",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    risk_level: "low",
    status: "candidate",
    occurrence_count: 1,
    content_hash: "deadbeef",
    ...overrides,
  };
}

describe("generateDocumentId", () => {
  it("同一场景（含大小写/空白差异）算出相同 ID", () => {
    const a = generateDocumentId({ projectScope: "ai-kefu", taskType: "backend", stage: "execute", title: "锁竞态修复" });
    const b = generateDocumentId({ projectScope: "ai-kefu", taskType: "backend", stage: "execute", title: "  锁竞态修复  " });
    assert.equal(a, b);
  });

  it("不同场景算出不同 ID", () => {
    const a = generateDocumentId({ projectScope: "ai-kefu", taskType: "backend", stage: "execute", title: "锁竞态修复" });
    const b = generateDocumentId({ projectScope: "ai-kefu", taskType: "frontend", stage: "execute", title: "锁竞态修复" });
    assert.notEqual(a, b);
  });
});

describe("parseExperienceSections", () => {
  it("按 9 个二级标题切分正文", () => {
    const sections = parseExperienceSections(VALID_BODY);
    assert.equal(sections.get("触发场景"), "描述触发场景");
    assert.equal(sections.get("正确处理"), "描述正确处理");
    assert.equal(sections.size, 9);
  });

  it("缺失的节不出现在 Map 里（不是空字符串）", () => {
    const sections = parseExperienceSections("## 触发场景\n描述\n");
    assert.equal(sections.has("触发场景"), true);
    assert.equal(sections.has("问题表现"), false);
  });
});

describe("validateExperience — AC-001/AC-002", () => {
  it("合法 frontmatter + 完整正文通过校验", () => {
    const result = validateExperience(validFrontmatter(), VALID_BODY);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("缺少必需二级标题时返回明确失败原因", () => {
    const bodyMissingSection = VALID_BODY.replace("## 验证方法\n描述验证方法\n", "");
    const result = validateExperience(validFrontmatter(), bodyMissingSection);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("验证方法")));
  });

  it("stage 不在枚举范围内时返回失败", () => {
    const result = validateExperience(validFrontmatter({ stage: "unknown" as never }), VALID_BODY);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("stage")));
  });

  it("supersedes 是裸 document_id（无 @v 后缀）时返回失败", () => {
    const result = validateExperience(validFrontmatter({ supersedes: "abc123" }), VALID_BODY);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("supersedes")));
  });

  it("supersedes 是 {document_id}@v{N} 格式时通过", () => {
    const result = validateExperience(validFrontmatter({ supersedes: "abc123@v1" }), VALID_BODY);
    assert.equal(result.ok, true);
  });

  it("缺少一级标题（# 标题）时返回明确失败原因，即使 9 个二级标题齐全（第二十七轮 Codex Review）", () => {
    const bodyMissingTitle = VALID_BODY.replace("# 标题\n", "");
    const result = validateExperience(validFrontmatter(), bodyMissingTitle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("一级标题")));
  });

  it("一级标题前有任意无关文字时同样判定失败（一级标题必须是第一条非空行）", () => {
    const bodyWithJunkBeforeTitle = `一些无关的开场白\n${VALID_BODY}`;
    const result = validateExperience(validFrontmatter(), bodyWithJunkBeforeTitle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("一级标题")));
  });

  it("一级标题写成二级标题（## 标题）时判定失败，不能靠 ## 冒充 #", () => {
    const bodyWithH2InsteadOfH1 = VALID_BODY.replace("# 标题\n", "## 标题\n");
    const result = validateExperience(validFrontmatter(), bodyWithH2InsteadOfH1);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("一级标题")));
  });

  it("一级标题文字不是字面的“标题”二字也能通过——只要求存在合法的一级标题，不要求具体文字", () => {
    const bodyWithCustomTitle = VALID_BODY.replace("# 标题\n", "# 锁竞态修复经验\n");
    const result = validateExperience(validFrontmatter(), bodyWithCustomTitle);
    assert.equal(result.ok, true);
  });
});

describe("serializeExperienceFile + parseExperienceFile 往返一致", () => {
  it("序列化后再解析，字段值不变", () => {
    const fm = validFrontmatter({ supersedes: "abc123@v1" });
    const serialized = serializeExperienceFile(fm, VALID_BODY);
    const { frontmatter, body } = parseExperienceFile(serialized);
    assert.equal(frontmatter.document_id, fm.document_id);
    assert.equal(frontmatter.supersedes, "abc123@v1");
    assert.ok(body.includes("触发场景"));
  });

  it("title 含冒号时被正确引用并往返一致（YAML 冒号是语法字符）", () => {
    const fm = validFrontmatter({ title: "Failure: retry handling" });
    const serialized = serializeExperienceFile(fm, VALID_BODY);
    const titleLine = serialized.split("\n").find((l) => l.startsWith("title:"))!;
    assert.equal(titleLine, 'title: "Failure: retry handling"');
    const { frontmatter } = parseExperienceFile(serialized);
    assert.equal(frontmatter.title, "Failure: retry handling");
  });

  it("source 含井号/引号/反斜杠时被正确转义并往返一致", () => {
    const fm = validFrontmatter({ source: 'yd:ai N5 #123 "quoted" C:\\path' });
    const serialized = serializeExperienceFile(fm, VALID_BODY);
    const { frontmatter } = parseExperienceFile(serialized);
    assert.equal(frontmatter.source, 'yd:ai N5 #123 "quoted" C:\\path');
  });

  it("title 以特殊字符开头或是纯数字/布尔字面量时被引用", () => {
    for (const title of ["- 前导短横线", "true", "123", "@handle-like"]) {
      const fm = validFrontmatter({ title });
      const serialized = serializeExperienceFile(fm, VALID_BODY);
      const { frontmatter } = parseExperienceFile(serialized);
      assert.equal(frontmatter.title, title, `${JSON.stringify(title)} 应该往返一致`);
    }
  });

  it("普通标题不加引号，序列化输出保持简洁", () => {
    const fm = validFrontmatter({ title: "普通标题" });
    const serialized = serializeExperienceFile(fm, VALID_BODY);
    assert.ok(serialized.includes("title: 普通标题"));
  });
});
