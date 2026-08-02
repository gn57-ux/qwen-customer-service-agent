/**
 * 第二十九轮 Codex Review 指出的真实 bug 的专项回归测试——写入后的
 * 最终读回校验必须像本文件其余所有活跃文件读取一样使用
 * `readActiveFileNoFollow()`，不能用会跟随符号链接的 `fs.readFile()`：
 *
 *   `atomicWriteExperience()` 的 rename 完成、函数返回之后，到
 *   `upsertExperience()` 真正执行读回校验之前，如果另一个本机进程
 *   恰好把规范路径 `{document_id}.md` 替换成一个指向外部"伪造文件"
 *   的符号链接——且这份伪造文件的 `document_version`/`occurrence_count`/
 *   `content_hash` 恰好被精心构造成与本次写入完全一致——旧实现的
 *   `fs.readFile()` 会跟随符号链接读到这份伪造内容，读回校验误判为
 *   "确实生效"，向调用方谎报 `ok: true`；但规范路径此刻实际上已经不是
 *   我们刚 rename 过去的那份文件，调用方还在不知情的情况下读到了
 *   `experienceRoot` 之外的数据。
 *
 * 用 mock.module() 替换 "./atomic-write.ts" 的 `atomicWriteExperience`
 * ——先真实完成写入（让此前所有围栏检查/流程都基于真实状态推进），
 * 再作为副作用立即把刚写好的规范文件替换成指向外部伪造文件的符号
 * 链接，精确模拟"rename 完成、函数返回"与"读回校验真正执行"之间的
 * 这个具体窗口。断言 `upsertExperience()` 必须像遇到其他任何活跃文件
 * 符号链接一样直接抛出，不能返回 `ok: true`。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.verify-symlink.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

const TITLE = "验证读回符号链接测试";
const PROJECT_SCOPE = "verify-symlink-scope";

let tmpDir: string;
let targetPath: string;
let craftedExternalPath: string;

const atomicWriteMock = mock.fn(async (writeTargetPath: string, content: string) => {
  // 先真实完成写入——upsertExperience() 之前的所有步骤（脱敏/围栏检查/
  // 归档）都必须基于真实文件系统状态推进，本测试只关心"写入完成之后、
  // 读回校验之前"这一个具体窗口，不应该在更早的步骤里就引入任何偏差。
  await fs.writeFile(writeTargetPath, content, "utf-8");

  // 立即把刚写好的规范文件替换成指向外部伪造文件的符号链接，模拟
  // "另一个本机进程恰好在这一刻完成了替换"这一既成事实。
  await fs.unlink(writeTargetPath);
  await fs.symlink(craftedExternalPath, writeTargetPath, "file");
});

mock.module("./atomic-write.ts", {
  namedExports: { atomicWriteExperience: atomicWriteMock },
});

const { upsertExperience } = await import("./write.ts");
const { generateDocumentId, serializeExperienceFile } = await import("./schema.ts");
const { redact } = await import("./redact.ts");

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

const CRAFTED_EXTERNAL_CONTENT = "外部伪造文件的原始内容，不应被当作已生效写入读到";

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-verify-symlink-test-"));
  const scopeDir = path.join(tmpDir, PROJECT_SCOPE);
  await fs.mkdir(scopeDir, { recursive: true });

  const documentId = generateDocumentId({
    projectScope: PROJECT_SCOPE,
    taskType: "backend",
    stage: "execute",
    title: TITLE,
  });
  targetPath = path.join(scopeDir, `${documentId}.md`);

  // 与 write.ts 完全相同的算法算出真实 content_hash，让"伪造文件"的
  // 围栏字段精确匹配本次写入即将计算出的值——如果不精确匹配，读回
  // 校验的字段比对本身就会因为"内容不一致"而正确报告 conflict，测不到
  // "读回校验跟随符号链接"这个具体漏洞，必须让伪造内容在字段层面
  // 完全以假乱真，才能证明问题出在"读取方式"本身而不是"字段比对"。
  const redactedBody = redact(VALID_BODY);
  const realContentHash = createHash("sha256").update(redactedBody.text).digest("hex").slice(0, 16);

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-verify-symlink-outside-"));
  craftedExternalPath = path.join(outsideDir, "crafted.md");
  const craftedContent = serializeExperienceFile(
    {
      document_id: documentId,
      document_version: 1, // 新建文档场景下本次写入会算出的真实值
      title: TITLE,
      domain: "workflow-experience",
      stage: "execute",
      task_type: "backend",
      project_scope: PROJECT_SCOPE,
      source: "yd:ai N5",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      risk_level: "medium",
      status: "candidate",
      occurrence_count: 1, // 新建文档场景下本次写入会算出的真实值
      content_hash: realContentHash, // 精确匹配，冒充"写入确实生效"
    },
    CRAFTED_EXTERNAL_CONTENT,
  );
  await fs.writeFile(craftedExternalPath, craftedContent, "utf-8");
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(path.dirname(craftedExternalPath), { recursive: true, force: true });
});

describe("upsertExperience — 写入后读回校验的符号链接防护（Codex Review 第二十九轮）", () => {
  it("rename 完成后、读回校验之前规范路径被替换成符号链接时，必须直接抛出，不得返回 ok: true", async () => {
    await assert.rejects(
      () =>
        upsertExperience({
          experienceRoot: tmpDir,
          title: TITLE,
          stage: "execute",
          taskType: "backend",
          projectScope: PROJECT_SCOPE,
          source: "yd:ai N5",
          riskLevel: "medium",
          body: VALID_BODY,
        }),
      /符号链接/,
      "读回校验应当使用 readActiveFileNoFollow()，在 open 阶段就以 ELOOP 拒绝跟随",
    );

    // 核心断言：符号链接本身应原样保留（不是先删链接再报错这种旁路），
    // 外部伪造文件的内容也不应该被本次流程读取之外的任何方式改动。
    const linkStat = await fs.lstat(targetPath);
    assert.ok(linkStat.isSymbolicLink(), "符号链接本身不应被移除/替换");
    assert.ok(
      (await fs.readFile(craftedExternalPath, "utf-8")).includes(CRAFTED_EXTERNAL_CONTENT),
      "外部伪造文件内容不应被覆盖",
    );
  });
});
