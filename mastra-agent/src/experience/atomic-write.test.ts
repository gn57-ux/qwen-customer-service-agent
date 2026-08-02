/**
 * atomicWriteExperience 的临时文件路径符号链接逃逸回归测试（Codex Review
 * 第二十一轮指出：`.tmp-{pid}-{timestamp}` 在真正创建前是可预测路径，若
 * experience 目录对本机其他进程可写，攻击者可以预先在这个确切路径放一个
 * 指向 `experienceRoot` 之外的符号链接，`fs.writeFile()` 会跟随该符号
 * 链接写入并截断外部文件）。
 *
 * 用 node:test 的 mock.module() 固定 randomUUID()、用 mock.timers 固定
 * Date.now()，让 atomic-write.ts 内部拼出的 tmp 路径变得完全可预测，
 * 从而能在测试里预先在这个确切路径放一个指向仓库外部文件的符号链接，
 * 验证 `O_NOFOLLOW|O_EXCL` 确实拒绝跟随它，而不是把"路径不可预测"本身
 * 当作唯一防线（那只是纵深防御的第二层，见 atomic-write.ts 顶部注释）。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/atomic-write.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

const FIXED_UUID = "11111111-2222-3333-4444-555555555555";
const FIXED_NOW = 1_800_000_000_000;

// 必须在 import "./atomic-write.ts" 之前完成——ESM 静态 import 在模块
// 顶层就已经解析绑定。只 mock randomUUID 这一个导出，crypto 的其他导出
// 不会用到，故不需要额外补齐 namedExports。
mock.module("node:crypto", {
  namedExports: { randomUUID: () => FIXED_UUID },
});

const { atomicWriteExperience } = await import("./atomic-write.ts");

let tmpDir: string;
let outsideDir: string;

before(() => {
  mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
});

after(() => {
  mock.timers.reset();
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-atomic-write-test-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-atomic-write-outside-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("atomicWriteExperience — tmp 路径符号链接逃逸（Codex Review 第二十一轮）", () => {
  it("预先在可预测 tmp 路径放置指向仓库外部的符号链接时，拒绝写入且不覆盖外部文件", async () => {
    const targetPath = path.join(tmpDir, "doc.md");
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "外部文件的原始内容", "utf-8");

    // randomUUID/Date.now 均已固定，tmp 路径与 atomic-write.ts 内部
    // 拼接逻辑完全一致（process.pid 本身就是已知的真实值）。
    const predictedTmpPath = `${targetPath}.tmp-${process.pid}-${FIXED_NOW}-${FIXED_UUID}`;
    await fs.symlink(outsideFile, predictedTmpPath);

    await assert.rejects(
      () => atomicWriteExperience(targetPath, "攻击者试图写入的内容"),
      /ELOOP|EEXIST/,
      "O_NOFOLLOW|O_EXCL 应当拒绝跟随预先放置的符号链接",
    );

    assert.equal(
      await fs.readFile(outsideFile, "utf-8"),
      "外部文件的原始内容",
      "外部文件内容不应被覆盖",
    );
    const tmpStat = await fs.lstat(predictedTmpPath);
    assert.ok(tmpStat.isSymbolicLink(), "预先放置的符号链接本身不应被静默删除或替换");
    await assert.rejects(() => fs.stat(targetPath), "正式目标文件不应被创建");
  });

  it("正常路径（不存在预置符号链接）下写入仍然成功，不受本轮修复影响", async () => {
    const targetPath = path.join(tmpDir, "doc-normal.md");
    await atomicWriteExperience(targetPath, "正常内容");
    assert.equal(await fs.readFile(targetPath, "utf-8"), "正常内容");
    const entries = await fs.readdir(tmpDir);
    assert.ok(!entries.some((e) => e.includes(".tmp-")), "不应残留 tmp 文件");
  });
});

// `node:fs/promises` 的默认导出是进程内单一共享的可变对象——直接对
// fs.rename 赋值即可让 atomic-write.ts 内部实际调用到的是同一个被替换
// 过的方法，不需要 mock.module()（后者拦截的是跨文件 import 绑定，这里
// 只是给同一个共享对象的方法打补丁，更直接）。
describe("atomicWriteExperience — 失败清理 tmp 文件（Codex Review 第二十二轮）", () => {
  it("rename 失败时清理已创建的 tmp 文件，不留孤儿文件，且不掩盖原始错误", async () => {
    const targetPath = path.join(tmpDir, "doc-rename-fail.md");
    const originalRename = fs.rename;
    const renameError = new Error("模拟磁盘写满导致 rename 失败");
    fs.rename = async () => {
      throw renameError;
    };
    try {
      await assert.rejects(
        () => atomicWriteExperience(targetPath, "内容"),
        (err: unknown) => err === renameError,
        "必须原样抛出底层错误，清理动作不能掩盖它",
      );
      const entries = await fs.readdir(tmpDir);
      assert.ok(!entries.some((e) => e.includes(".tmp-")), "rename 失败后不应残留 tmp 文件");
      await assert.rejects(() => fs.stat(targetPath), "目标文件不应被创建");
    } finally {
      fs.rename = originalRename;
    }
  });
});
