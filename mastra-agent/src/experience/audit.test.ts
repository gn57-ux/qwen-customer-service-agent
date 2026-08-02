import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExistingPoint, ScopeFilter } from "../rag/store.ts";
import { auditExperience } from "./audit.ts";
import { serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";
import type { ExperienceStore } from "./store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-audit-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validFm(overrides: Partial<ExperienceFrontmatter> = {}): ExperienceFrontmatter {
  return {
    document_id: "doc-1",
    document_version: 1,
    title: "测试经验",
    domain: "workflow-experience",
    stage: "execute",
    task_type: "backend",
    project_scope: "proj",
    source: "yd:ai N5",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    risk_level: "low",
    status: "verified",
    occurrence_count: 1,
    content_hash: "abc",
    ...overrides,
  };
}

const VALID_BODY = [
  "触发场景",
  "问题表现",
  "错误做法",
  "根因",
  "正确处理",
  "验证方法",
  "适用范围",
  "不适用范围",
  "可提升为稳定规则的条件",
]
  .map((s) => `## ${s}\n${s}内容`)
  .join("\n\n");

async function writeDoc(relativePath: string, fm: ExperienceFrontmatter, body = VALID_BODY): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeExperienceFile(fm, `# 标题\n\n${body}\n`), "utf-8");
}

function fakeStore(existingPoints: ExistingPoint[]): ExperienceStore {
  return {
    knowledgeSet: "claude-workflow-experience",
    async listPoints(_filter: ScopeFilter) {
      return existingPoints;
    },
  } as unknown as ExperienceStore;
}

describe("auditExperience", () => {
  it("frontmatter 校验失败的文档报告在 validationFindings 里", async () => {
    const badBody = VALID_BODY.replace("## 验证方法\n验证方法内容\n\n", "");
    await writeDoc("proj/bad-doc.md", validFm({ document_id: "bad-doc" }), badBody);

    const report = await auditExperience(tmpDir, fakeStore([]));
    assert.equal(report.validationFindings.length, 1);
    assert.equal(report.validationFindings[0]!.relativePath, path.join("proj", "bad-doc.md"));
    assert.ok(report.validationFindings[0]!.errors.some((e) => e.includes("验证方法")));
  });

  it("脱敏规则命中的行号被报告，且报告文本不包含被扫描出的敏感内容原文（AC-006）", async () => {
    const bodyWithSecret = VALID_BODY.replace(
      "## 问题表现\n问题表现内容",
      "## 问题表现\n泄露了密钥 sk-abcdefghijklmnopqrstuvwxyz123456",
    );
    await writeDoc("proj/leaky-doc.md", validFm({ document_id: "leaky-doc" }), bodyWithSecret);

    const report = await auditExperience(tmpDir, fakeStore([]));
    assert.equal(report.redactionFindings.length, 1);
    assert.ok(report.redactionFindings[0]!.lines.length > 0, "应该能定位到具体行号");

    const reportText = JSON.stringify(report);
    assert.ok(
      !reportText.includes("sk-abcdefghijklmnopqrstuvwxyz123456"),
      "巡检报告本身不得回显命中的敏感内容原文",
    );
  });

  it("没有命中脱敏规则的正常文档不出现在 redactionFindings 里", async () => {
    await writeDoc("proj/clean-doc.md", validFm({ document_id: "clean-doc" }));
    const report = await auditExperience(tmpDir, fakeStore([]));
    assert.deepEqual(report.redactionFindings, []);
  });

  it("孤儿文件：文件存在但 Qdrant 里没有对应向量点", async () => {
    await writeDoc("proj/orphan-doc.md", validFm({ document_id: "orphan-doc" }));
    const report = await auditExperience(tmpDir, fakeStore([]));
    assert.deepEqual(report.orphanFiles, ["orphan-doc"]);
    assert.deepEqual(report.danglingDocumentIds, []);
  });

  it("悬空向量点：Qdrant 有点但对应文件已删除", async () => {
    await writeDoc("proj/exists-doc.md", validFm({ document_id: "exists-doc" }));
    const report = await auditExperience(
      tmpDir,
      fakeStore([
        { id: "point-1", documentId: "exists-doc" },
        { id: "point-2", documentId: "deleted-doc" },
      ]),
    );
    assert.deepEqual(report.orphanFiles, []);
    assert.deepEqual(report.danglingDocumentIds, ["deleted-doc"]);
  });

  it("frontmatter 完全无法解析的文件计入 validationFindings，不参与孤儿/悬空比对", async () => {
    await fs.mkdir(path.join(tmpDir, "proj"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "proj", "broken.md"), "不合法内容", "utf-8");

    const report = await auditExperience(tmpDir, fakeStore([]));
    assert.equal(report.validationFindings.length, 1);
    assert.equal(report.scannedCount, 1);
  });

  it("只读——不修改任何文件（audit 前后文件内容字节相同）", async () => {
    await writeDoc("proj/doc-1.md", validFm({ document_id: "doc-1" }));
    const before = await fs.readFile(path.join(tmpDir, "proj", "doc-1.md"), "utf-8");
    await auditExperience(tmpDir, fakeStore([]));
    const after = await fs.readFile(path.join(tmpDir, "proj", "doc-1.md"), "utf-8");
    assert.equal(before, after);
  });
});
