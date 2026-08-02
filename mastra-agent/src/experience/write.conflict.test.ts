/**
 * 内容级围栏检查的回归测试——模拟"落盘前一刻，目标文件的围栏状态
 * （content_hash + occurrence_count）已经不是本次更新所依据的基线"这
 * 一具体场景（第十四轮 Codex Review 指出：仅靠锁 token 比对不足以防止
 * 两个进程都完成写入，必须在数据层面独立再核实一次）。
 *
 * 用 node:test 的 mock.module() 替换 "./read-content-hash.ts" 的
 * readCurrentFenceState，强制围栏检查读到一个与基线不同的状态，断言：
 * 1. upsertExperience() 返回 `{ ok: false, reason: "conflict" }`；
 * 2. atomicWriteExperience 从未被调用（不会覆盖磁盘上的内容）。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.conflict.test.ts
 */

import assert from "node:assert/strict";
import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

const readCurrentFenceStateMock = mock.fn(async (_targetPath: string) => ({
  contentHash: "some-other-process-already-wrote-this-hash",
  occurrenceCount: 999,
}));
const atomicWriteMock = mock.fn(async (_targetPath: string, _content: string) => {
  throw new Error("不应该走到这里——围栏检查应该已经中止写入");
});

// mock.module() 是整体替换模块的导出，不是"打补丁只覆盖列出的几个
// 名字"——write.ts 同时从 "./read-content-hash.ts" 导入
// fenceStatesEqual（纯比较函数）与 readActiveFileNoFollow（第二十二轮
// Codex Review 新增），如果这里的 namedExports 缺任何一个，缺的那个
// 会在 write.ts 里变成 undefined，直接在 import 阶段报 SyntaxError。
// 这里内联复刻两者的真实实现——只 mock 真正需要控制的 I/O 部分
// （读取围栏状态），readActiveFileNoFollow 是本测试预先在磁盘上写好
// v1 文件后 write.ts 读取"现存内容"要用到的真实路径，必须是真实实现
// 而不是打桩，否则 upsertExperience() 内部对 existing 的判断会读到
// 假数据，测试就不再验证围栏检查本身。
function fenceStatesEqual(
  a: { contentHash: string; occurrenceCount: number } | null,
  b: { contentHash: string; occurrenceCount: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.contentHash === b.contentHash && a.occurrenceCount === b.occurrenceCount;
}

async function readActiveFileNoFollow(targetPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(targetPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

// 必须在 import "./write.ts" 之前完成——ESM 静态 import 在模块顶层就已经
// 解析绑定，specifier 用与 write.ts 完全相同的相对路径。**mock 的导出名
// 必须与 write.ts 实际 import 的名字完全一致**——第十九轮 Codex Review
// 修复把 readCurrentContentHash 重命名为 readCurrentFenceState，若这里
// 的 namedExports 键名不同步更新，mock.module() 会静默失效（不报错，
// 只是根本没拦截到任何东西，write.ts 会跑真实实现），后面的断言会
// 因为完全不同的原因偶然通过或失败，而不是真的验证了围栏检查逻辑。
mock.module("./read-content-hash.ts", {
  namedExports: {
    readCurrentFenceState: readCurrentFenceStateMock,
    fenceStatesEqual,
    readActiveFileNoFollow,
  },
});
mock.module("./atomic-write.ts", {
  namedExports: { atomicWriteExperience: atomicWriteMock },
});

const { upsertExperience } = await import("./write.ts");
const { generateDocumentId, serializeExperienceFile } = await import("./schema.ts");

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-conflict-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertExperience — 内容级围栏检查（Codex Review 第十四轮）", () => {
  it("落盘前发现 content_hash 与基线不一致时中止，不覆盖，不调用 atomicWriteExperience", async () => {
    const result = await upsertExperience({
      experienceRoot: tmpDir,
      title: "围栏检查测试",
      stage: "execute",
      taskType: "backend",
      projectScope: "ai-kefu-test",
      source: "yd:ai N5",
      riskLevel: "medium",
      body: VALID_BODY,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "conflict");
    assert.equal(atomicWriteMock.mock.callCount(), 0, "围栏检查失败时不应调用 atomicWriteExperience");
  });

  it("崩溃/中止后不留下死锁文件", async () => {
    const entries = await fs.readdir(path.join(tmpDir, "ai-kefu-test"));
    assert.ok(!entries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
  });

  it("更新场景下围栏检查在归档之前就中止，不产生 .superseded/ 文件（Codex Review 第十五轮）", async () => {
    atomicWriteMock.mock.resetCalls();
    const scopeDir = path.join(tmpDir, "existing-scope");
    await fs.mkdir(scopeDir, { recursive: true });

    const documentId = generateDocumentId({
      projectScope: "existing-scope",
      taskType: "backend",
      stage: "execute",
      title: "已存在的经验",
    });
    const v1Content = serializeExperienceFile(
      {
        document_id: documentId,
        document_version: 1,
        title: "已存在的经验",
        domain: "workflow-experience",
        stage: "execute",
        task_type: "backend",
        project_scope: "existing-scope",
        source: "yd:ai N5",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
        risk_level: "medium",
        status: "candidate",
        occurrence_count: 1,
        content_hash: "original-v1-hash",
      },
      VALID_BODY,
    );
    await fs.writeFile(path.join(scopeDir, `${documentId}.md`), v1Content, "utf-8");

    const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n更新后的根因");
    const result = await upsertExperience({
      experienceRoot: tmpDir,
      title: "已存在的经验",
      stage: "execute",
      taskType: "backend",
      projectScope: "existing-scope",
      source: "yd:ai N5",
      riskLevel: "medium",
      body: updatedBody,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "conflict");
    assert.equal(atomicWriteMock.mock.callCount(), 0);

    // 核心断言：readCurrentContentHashMock 恒定返回一个与基线（"original-v1-hash"）
    // 不同的值，围栏检查必须在归档之前就发现这一点并中止——.superseded/
    // 目录不应该被创建（Codex Review 第十五轮指出的真实 bug：旧版实现
    // 把围栏检查放在归档之后，会先留下一份归档文件才报告 conflict）。
    await assert.rejects(() => fs.stat(path.join(scopeDir, ".superseded")));
  });
});
