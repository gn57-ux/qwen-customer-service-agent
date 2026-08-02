import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { REQUIRED_SECTIONS, serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import { buildSuggestions, renderReport, runSuggestRules } from "./suggest-rules.ts";
import { scanExperienceFiles } from "./scan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");

let tmpDir: string;
let suggestedRulesDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-suggest-rules-test-"));
  suggestedRulesDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-suggested-rules-out-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(suggestedRulesDir, { recursive: true, force: true });
});

function validFm(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "doc-1",
    document_version: 1,
    title: "候选规则测试经验",
    domain: "workflow-experience",
    stage: "execute",
    task_type: "backend",
    project_scope: "proj",
    source: "yd:ai N5",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    risk_level: "low",
    status: "verified",
    occurrence_count: 3,
    content_hash: "abc",
    ...overrides,
  };
}

function bodyWith(overrides: Partial<Record<(typeof REQUIRED_SECTIONS)[number], string>> = {}): string {
  return REQUIRED_SECTIONS.map((s) => `## ${s}\n${overrides[s] ?? `${s}默认内容`}`).join("\n\n");
}

async function writeDoc(fm: ExperienceFrontmatter, body: string): Promise<void> {
  const fullPath = path.join(tmpDir, fm.project_scope, `${fm.document_id}.md`);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${body}\n`), "utf-8");
}

async function snapshotAgentsMd(): Promise<string | null> {
  try {
    const content = await fs.readFile(AGENTS_MD_PATH);
    return createHash("sha256").update(content).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

describe("buildSuggestions（AC-003：阈值过滤）", () => {
  it("只包含 status=verified 且 occurrence_count >= 阈值的经验", async () => {
    await writeDoc(validFm({ document_id: "d-verified-high", status: "verified", occurrence_count: 5 }), bodyWith());
    await writeDoc(validFm({ document_id: "d-verified-low", status: "verified", occurrence_count: 2 }), bodyWith());
    await writeDoc(validFm({ document_id: "d-candidate", status: "candidate", occurrence_count: 10 }), bodyWith());
    await writeDoc(validFm({ document_id: "d-deprecated", status: "deprecated", occurrence_count: 10 }), bodyWith());

    const files = await scanExperienceFiles(tmpDir);
    const entries = buildSuggestions(files, 3);

    assert.equal(entries.length, 1, "只有 d-verified-high 满足 verified + occurrence_count>=3");
    assert.equal(entries[0]!.documentId, "d-verified-high");
  });

  it("occurrence_count 恰好等于阈值时应该被包含（>=，不是 >）", async () => {
    await writeDoc(validFm({ document_id: "d-exact", status: "verified", occurrence_count: 3 }), bodyWith());
    const files = await scanExperienceFiles(tmpDir);
    const entries = buildSuggestions(files, 3);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.documentId, "d-exact");
  });

  it("阈值可配置", async () => {
    await writeDoc(validFm({ document_id: "d-1", status: "verified", occurrence_count: 4 }), bodyWith());
    const files = await scanExperienceFiles(tmpDir);
    assert.equal(buildSuggestions(files, 5).length, 0);
    assert.equal(buildSuggestions(files, 4).length, 1);
  });
});

describe("buildSuggestions（AC-005：blocked 内容整条排除，不回显原文）", () => {
  it("正确处理节含 Token 样式字符串时，该候选被跳过，不出现在建议规则里，报告不含原始 Token 片段", async () => {
    const secretToken = "sk-abcdefghijklmnopqrstuvwxyz123456";
    await writeDoc(
      validFm({ document_id: "d-secret", status: "verified", occurrence_count: 5 }),
      bodyWith({ 正确处理: `使用密钥 ${secretToken} 完成认证` }),
    );
    await writeDoc(
      validFm({ document_id: "d-clean", status: "verified", occurrence_count: 5 }),
      bodyWith(),
    );

    const files = await scanExperienceFiles(tmpDir);
    const entries = buildSuggestions(files, 3);

    const secretEntry = entries.find((e) => e.documentId === "d-secret")!;
    assert.equal(secretEntry.skipped, true);
    if (secretEntry.skipped) {
      assert.ok(secretEntry.reason.length > 0);
    }

    const cleanEntry = entries.find((e) => e.documentId === "d-clean")!;
    assert.equal(cleanEntry.skipped, false);

    const report = renderReport(entries, 3);
    assert.ok(!report.includes(secretToken), "报告文本不得包含被跳过候选的原始敏感内容");
    assert.match(report, /d-secret（已跳过）/);
  });
});

describe("runSuggestRules（端到端：生成报告文件 + AGENTS.md 不变性 AC-002）", () => {
  it("生成的报告文件包含候选规则文本与证据，写在指定目录之外不触碰 AGENTS.md", async () => {
    await writeDoc(
      validFm({ document_id: "d-1", status: "verified", occurrence_count: 3 }),
      bodyWith({ 触发场景: "并发写入场景", 正确处理: "使用排他锁", 适用范围: "所有写入路径" }),
    );

    const before = await snapshotAgentsMd();
    const result = await runSuggestRules(tmpDir, suggestedRulesDir, 3, "2026-08-01");
    const after = await snapshotAgentsMd();

    assert.equal(after, before, "AGENTS.md 的存在性/内容哈希不应该因为运行本生成器发生任何变化");

    assert.equal(result.includedCount, 1);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.reportPath, path.join(suggestedRulesDir, "2026-08-01.md"));

    const reportContent = await fs.readFile(result.reportPath, "utf-8");
    assert.match(reportContent, /并发写入场景/);
    assert.match(reportContent, /使用排他锁/);
    assert.match(reportContent, /所有写入路径/);
    assert.match(reportContent, /需人工审阅后手动写入 AGENTS\.md/);
  });

  it("报告目录在 knowledge/experience 摄取根目录之外，不会被 scanExperienceFiles 扫描到（避免自我摄取的循环）", async () => {
    await writeDoc(
      validFm({ document_id: "d-1", status: "verified", occurrence_count: 3 }),
      bodyWith(),
    );
    await runSuggestRules(tmpDir, suggestedRulesDir, 3, "2026-08-01");

    // suggestedRulesDir 是独立于 tmpDir（模拟 knowledgeRoot）的目录，
    // 对 tmpDir 再次扫描不应该扫到报告文件本身。
    const filesAfter = await scanExperienceFiles(tmpDir);
    assert.equal(filesAfter.length, 1, "报告文件不应该出现在 knowledgeRoot 的扫描结果里");
  });

  it("没有候选满足阈值时仍然生成报告文件（候选数为 0），不抛异常", async () => {
    await writeDoc(validFm({ document_id: "d-1", status: "candidate", occurrence_count: 10 }), bodyWith());
    const result = await runSuggestRules(tmpDir, suggestedRulesDir, 3, "2026-08-01");
    assert.equal(result.includedCount, 0);
    const reportContent = await fs.readFile(result.reportPath, "utf-8");
    assert.match(reportContent, /候选数：0/);
  });
});
