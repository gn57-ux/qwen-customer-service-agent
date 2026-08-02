import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scanExperienceFiles } from "./scan.ts";
import { serializeExperienceFile, type ExperienceFrontmatter } from "./schema.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-scan-test-"));
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
    status: "candidate",
    occurrence_count: 1,
    content_hash: "abc",
    ...overrides,
  };
}

describe("scanExperienceFiles", () => {
  it("递归扫描所有子目录下的 .md 文件", async () => {
    await fs.mkdir(path.join(tmpDir, "proj-a"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "proj-b"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "proj-a", "doc-a.md"),
      serializeExperienceFile(validFm({ document_id: "doc-a" }), "# 标题\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmpDir, "proj-b", "doc-b.md"),
      serializeExperienceFile(validFm({ document_id: "doc-b" }), "# 标题\n"),
      "utf-8",
    );

    const results = await scanExperienceFiles(tmpDir);
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.frontmatter?.document_id).sort(),
      ["doc-a", "doc-b"],
    );
  });

  it("跳过 .superseded 归档目录，不把历史版本当成活跃文档", async () => {
    const scopeDir = path.join(tmpDir, "proj-a");
    await fs.mkdir(path.join(scopeDir, ".superseded"), { recursive: true });
    await fs.writeFile(
      path.join(scopeDir, "doc-a.md"),
      serializeExperienceFile(validFm({ document_id: "doc-a" }), "# 标题\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(scopeDir, ".superseded", "doc-a@v1.md"),
      serializeExperienceFile(validFm({ document_id: "doc-a", document_version: 1 }), "# 标题\n"),
      "utf-8",
    );

    const results = await scanExperienceFiles(tmpDir);
    assert.equal(results.length, 1, "归档目录里的历史版本不应被扫描到");
  });

  it("frontmatter 解析失败的文件仍然返回，frontmatter 为 null 且带 parseError", async () => {
    await fs.mkdir(path.join(tmpDir, "proj-a"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "proj-a", "broken.md"), "这不是一个合法的经验文件\n", "utf-8");

    const results = await scanExperienceFiles(tmpDir);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.frontmatter, null);
    assert.ok(results[0]!.parseError);
  });

  it("relativePath 不包含绝对用户目录", async () => {
    await fs.mkdir(path.join(tmpDir, "proj-a"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "proj-a", "doc-a.md"),
      serializeExperienceFile(validFm({ document_id: "doc-a" }), "# 标题\n"),
      "utf-8",
    );

    const results = await scanExperienceFiles(tmpDir);
    assert.equal(results[0]!.relativePath, path.join("proj-a", "doc-a.md"));
    assert.ok(!path.isAbsolute(results[0]!.relativePath));
  });

  it("experienceRoot 不存在时返回空数组，不抛异常", async () => {
    const results = await scanExperienceFiles(path.join(tmpDir, "does-not-exist"));
    assert.deepEqual(results, []);
  });
});
