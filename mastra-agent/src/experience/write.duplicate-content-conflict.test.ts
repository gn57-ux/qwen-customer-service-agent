/**
 * 第十九轮 Codex Review 指出的真实 bug 的专项回归测试——内容级围栏检查
 * 如果只比对 content_hash，对"两次并发提交完全相同的内容"这种场景
 * 完全失明：
 *
 *   两个并发请求提交同一份 document_id 的**相同内容**，都会走
 *   write.ts 的去重路径（`existing.content_hash === contentHash`），
 *   都只把 occurrence_count 从同一个基线值各自独立 +1，content_hash
 *   本身从头到尾没有变化。如果锁机制的残余竞态窗口（见 write.ts 顶部
 *   acquireLock() 的说明）恰好让两者都通过了获取锁阶段，只比对
 *   content_hash 的围栏检查会认为"没有变化、没有冲突"，其中一次的
 *   occurrence_count 增量会被另一次无声覆盖丢失，而两次都会报告
 *   `ok: true`——用户能看到的"这份经验被验证过 N 次"这个计数会失真，
 *   且没有任何错误提示。
 *
 * 这个场景与 write.conflict.test.ts 覆盖的"内容不同导致的冲突"是两种
 * 不同的攻击面，用独立文件是为了让这里的 mock.module() 配置（一个
 * "content_hash 相同但 occurrence_count 不同"的具体返回值）不与
 * write.conflict.test.ts 里"content_hash 明显不同"的 mock 配置混在
 * 同一个进程里相互影响。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.duplicate-content-conflict.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

// 与 write.conflict.test.ts 同样的原因：mock.module() 整体替换导出，
// fenceStatesEqual 与 readActiveFileNoFollow（第二十二轮 Codex Review
// 新增）必须一并提供真实实现，否则 write.ts 对它们的 import 会在模块
// 加载阶段就报 SyntaxError；readActiveFileNoFollow 还必须是真实实现
// 而不是打桩——本测试预先在磁盘上写好了 v1 文件，write.ts 读取"现存
// 内容"这一步依赖它返回磁盘上的真实内容，打桩会让 existing 判断读到
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

// 核心 mock：恒定返回"content_hash 与真实 v1 完全相同，但
// occurrence_count 已经被别的进程从 1 悄悄推进到 2"——这正是"两次相同
// 内容的并发提交"场景下，围栏检查在落盘前实际会读到的磁盘状态。
let mockOccurrenceCount = 2;
let mockContentHash = ""; // 运行时用真实计算出的 v1 content_hash 填充
const readCurrentFenceStateMock = mock.fn(async (_targetPath: string) => ({
  contentHash: mockContentHash,
  occurrenceCount: mockOccurrenceCount,
}));
const atomicWriteMock = mock.fn(async (_targetPath: string, _content: string) => {
  throw new Error("不应该走到这里——围栏检查应该已经发现 occurrence_count 不一致并中止");
});

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

const TITLE = "相同内容并发提交测试";
const PROJECT_SCOPE = "duplicate-content-scope";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-dup-content-test-"));

  // 用与 write.ts 完全相同的算法算出真实 content_hash，不猜测/硬编码
  // 一个假值——保证下面预先写入的 v1 文件、以及 mock 返回的
  // contentHash，都精确对应"内容真的没变"这个前提，测试的是围栏检查
  // 本身，不是靠错误配置凑巧触发 conflict。
  const redactedBody = redact(VALID_BODY);
  mockContentHash = createHash("sha256").update(redactedBody.text).digest("hex").slice(0, 16);

  const documentId = generateDocumentId({
    projectScope: PROJECT_SCOPE,
    taskType: "backend",
    stage: "execute",
    title: TITLE,
  });

  const scopeDir = path.join(tmpDir, PROJECT_SCOPE);
  await fs.mkdir(scopeDir, { recursive: true });
  const v1Content = serializeExperienceFile(
    {
      document_id: documentId,
      document_version: 1,
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
      occurrence_count: 1, // 基线：目前记录的是"已出现 1 次"
      content_hash: mockContentHash,
    },
    VALID_BODY,
  );
  await fs.writeFile(path.join(scopeDir, `${documentId}.md`), v1Content, "utf-8");
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertExperience — 相同内容并发提交的围栏检查（Codex Review 第十九轮）", () => {
  it("提交与磁盘完全相同的内容（去重路径）时，若围栏读到的 occurrence_count 已经不是基线值，必须判定 conflict——即使 content_hash 完全没变", async () => {
    const result = await upsertExperience({
      experienceRoot: tmpDir,
      title: TITLE,
      stage: "execute",
      taskType: "backend",
      projectScope: PROJECT_SCOPE,
      source: "yd:ai N5",
      riskLevel: "medium",
      body: VALID_BODY, // 与预先写入的 v1 内容完全相同 → 走去重路径
    });

    // 核心断言：只比对 content_hash 的旧实现会在这里认为"没有变化"，
    // 从而 ok:true 地把 occurrence_count 覆盖回基线+1=2（与磁盘上已经
    // 是 2 的事实巧合相同，但这只是巧合——真实场景下磁盘可能已经被推进
    // 到 3、4 甚至更多次，旧实现永远不会发现，见本文件头部说明）。
    // 加入 occurrence_count 后的围栏检查必须识别出"基线(1) ≠ 当前(2)"
    // 并拒绝，不管 content_hash 是否相同。
    assert.equal(result.ok, false);
    assert.equal(result.reason, "conflict");
    assert.equal(atomicWriteMock.mock.callCount(), 0, "围栏检查失败时不应调用 atomicWriteExperience");
  });

  it("不残留锁文件", async () => {
    const entries = await fs.readdir(path.join(tmpDir, PROJECT_SCOPE));
    assert.ok(!entries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
  });
});
