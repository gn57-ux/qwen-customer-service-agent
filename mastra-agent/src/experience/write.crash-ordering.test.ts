/**
 * AC-006 第二部分："先归档、后覆盖"顺序的崩溃安全性——模拟"归档旧内容
 * 已完成、新版本原子写入尚未执行"这个具体时间点被 kill，规范路径
 * `{document_id}.md` 必须仍然是完整的旧版本内容，不能消失。
 *
 * 用 node:test 的 mock.module() 替换 "./atomic-write.ts" 的
 * atomicWriteExperience：第一次调用（新建 v1）放行到真实文件系统实现，
 * 第二次调用（v1→v2 的更新）直接抛错，模拟"归档已完成、rename 尚未
 * 发生"时的进程崩溃。只拦截这一个依赖，upsertExperience() 本身的真实
 * 逻辑（归档顺序、锁、校验）完全不受影响。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.crash-ordering.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

let callCount = 0;
const atomicWriteMock = mock.fn(async (targetPath: string, content: string) => {
  callCount += 1;
  if (callCount === 1) {
    // 第一次调用走真实实现，为"更新场景"准备好 v1 文件。
    const tmp = `${targetPath}.tmp-crash-test`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, targetPath);
    return;
  }
  throw new Error("simulated crash before atomic rename");
});

// 必须在 import "./write.ts" 之前完成——ESM 静态 import 在模块顶层就已经
// 解析绑定，specifier 用与 write.ts 完全相同的相对路径。
mock.module("./atomic-write.ts", {
  namedExports: { atomicWriteExperience: atomicWriteMock },
});

const { upsertExperience } = await import("./write.ts");
const { coerceFrontmatter, parseExperienceFile } = await import("./schema.ts");

const VALID_BODY = [
  "# 标题",
  "## 触发场景",
  "描述",
  "## 问题表现",
  "描述",
  "## 错误做法",
  "描述",
  "## 根因",
  "描述",
  "## 正确处理",
  "描述",
  "## 验证方法",
  "描述",
  "## 适用范围",
  "描述",
  "## 不适用范围",
  "描述",
  "## 可提升为稳定规则的条件",
  "描述",
  "",
].join("\n");

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-crash-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertExperience — AC-006 归档后覆盖顺序的崩溃安全性", () => {
  it("v1 正常写入，v2 更新在原子写入阶段崩溃时，规范文件仍是完整的 v1", async () => {
    const base = {
      experienceRoot: tmpDir,
      title: "崩溃顺序测试",
      stage: "execute" as const,
      taskType: "backend" as const,
      projectScope: "ai-kefu-test",
      source: "yd:ai N5",
      riskLevel: "medium" as const,
    };

    const first = await upsertExperience({ ...base, body: VALID_BODY });
    assert.equal(first.ok, true);
    assert.equal(first.documentVersion, 1);

    const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n会导致崩溃的更新");
    await assert.rejects(
      () => upsertExperience({ ...base, body: updatedBody }),
      /simulated crash/,
    );

    // 规范路径必须仍然完整存在，且内容是未受影响的 v1（不是半截文件、
    // 也不是文件消失）。
    const targetPath = first.filePath!;
    const raw = await fs.readFile(targetPath, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    assert.equal(fm.document_version, 1);
    assert.ok(!raw.includes("会导致崩溃的更新"));

    // 归档步骤发生在原子写入之前，此时已经执行完成（"归档白做了"，
    // 见 design.md 对该场景的说明），.superseded/ 下应能看到这份归档。
    const supersededPath = path.join(
      tmpDir,
      "ai-kefu-test",
      ".superseded",
      `${first.documentId}@v1.md`,
    );
    const archived = await fs.readFile(supersededPath, "utf-8");
    assert.ok(archived.includes("触发场景"));
  });

  it("锁在崩溃后仍被释放，不留下死锁文件", async () => {
    const lockDir = path.join(tmpDir, "ai-kefu-test");
    const entries = await fs.readdir(lockDir);
    assert.ok(!entries.some((e) => e.endsWith(".lock")), "崩溃后不应残留锁文件");
  });
});
