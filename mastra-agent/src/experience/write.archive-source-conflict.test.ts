/**
 * 第二十六轮 Codex Review 指出的真实 bug 的专项回归测试——归档源读取
 * 必须在写入归档文件之前核实内容仍是本次更新计算 archiveOldVersion
 * 所依据的那个基线版本，否则会把错误版本的内容永久写进历史归档：
 *
 *   早期围栏检查（步骤 5.5）通过之后、归档源读取（步骤 6.1）真正执行
 *   之前，如果另一个写入者恰好完成了自己完整的一轮更新（读到旧内容→
 *   写入新内容→rename），本进程这里读到的 `oldRaw` 已经是对方刚写入
 *   的新内容——但如果不核实就直接写进按本进程自己（此刻已陈旧）的
 *   `archiveOldVersion` 算出的归档路径，就会把"新内容"错误地当成
 *   "旧版本"永久归档。即使随后的第二次围栏检查（步骤 6.3）发现冲突
 *   并让整个 `upsertExperience()` 报告 `conflict`，归档文件此刻已经
 *   被污染，无法撤销——这是"报告冲突就等于没有产生副作用"这条隐含
 *   假设被打破的一个具体反例。
 *
 * 用 mock.module() 让 "./read-content-hash.ts" 的 `readActiveFileNoFollow`
 * 在第一次调用（步骤 4，初次判断"是否已存在"）时返回真实的 v1 内容，
 * 第二次调用（步骤 6.1，归档源读取）时返回一份"已经被另一进程替换"的
 * 内容——围栏状态（content_hash/occurrence_count）与基线不一致，但
 * `readCurrentFenceState`（早期围栏检查用到的另一个函数）恒定返回与
 * 基线一致的状态，模拟"从早期围栏检查的视角看一切正常，问题只发生在
 * 归档源读取这一步"这个具体窗口。断言：
 * 1. `upsertExperience()` 返回 `{ ok: false, reason: "conflict" }`；
 * 2. 归档文件从未被创建（不是"创建了又是错的"，而是"根本没走到创建
 *    这一步"）；
 * 3. `atomicWriteExperience` 从未被调用（新版本也没有被写入）。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.archive-source-conflict.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

// 与 write.conflict.test.ts 同样的原因：mock.module() 整体替换导出，
// fenceStatesEqual 必须一并提供真实实现，否则 write.ts 对它的 import
// 会在模块加载阶段就报 SyntaxError。
function fenceStatesEqual(
  a: { contentHash: string; occurrenceCount: number } | null,
  b: { contentHash: string; occurrenceCount: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.contentHash === b.contentHash && a.occurrenceCount === b.occurrenceCount;
}

let v1RealRaw = ""; // before() 里用真实 serializeExperienceFile 算出的 v1 原始内容
let v1RealContentHash = "";
let intruderRaw = ""; // before() 里构造的"已被另一进程替换"的内容，围栏状态与 v1 不同

let readActiveFileCallCount = 0;
const readActiveFileNoFollowMock = mock.fn(async (_targetPath: string) => {
  readActiveFileCallCount += 1;
  if (readActiveFileCallCount === 1) {
    // 第一次调用对应步骤 4 的初次读取——正常读到磁盘上真实存在的 v1，
    // 保证 baselineFence/archiveOldVersion 是按真实 v1 算出来的。
    return v1RealRaw;
  }
  // 第二次调用对应步骤 6.1 的归档源读取——模拟"另一个写入者已经在
  // 早期围栏检查之后完成了自己完整的一轮更新"，磁盘上此刻实际已经
  // 是别人写入的新内容。
  return intruderRaw;
});

const readCurrentFenceStateMock = mock.fn(async (_targetPath: string) => {
  // 早期围栏检查——恒定返回与基线一致的状态，让这一步正常通过，把
  // 问题精确留给"归档源读取"这一步来暴露（如果早期检查本身就发现
  // 不一致，测的就是另一条已经覆盖过的路径，不是这里要证明的场景）。
  return { contentHash: v1RealContentHash, occurrenceCount: 1 };
});

const atomicWriteMock = mock.fn(async (_targetPath: string, _content: string) => {
  throw new Error("不应该走到这里——归档前的围栏核实应该已经中止写入");
});

mock.module("./read-content-hash.ts", {
  namedExports: {
    readCurrentFenceState: readCurrentFenceStateMock,
    readActiveFileNoFollow: readActiveFileNoFollowMock,
    fenceStatesEqual,
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

const TITLE = "归档源污染测试";
const PROJECT_SCOPE = "archive-source-conflict-scope";

let tmpDir: string;
let documentId: string;
let supersededPath: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-archive-source-conflict-test-"));

  const redactedBody = redact(VALID_BODY);
  v1RealContentHash = createHash("sha256").update(redactedBody.text).digest("hex").slice(0, 16);

  documentId = generateDocumentId({
    projectScope: PROJECT_SCOPE,
    taskType: "backend",
    stage: "execute",
    title: TITLE,
  });

  const scopeDir = path.join(tmpDir, PROJECT_SCOPE);
  await fs.mkdir(scopeDir, { recursive: true });
  v1RealRaw = serializeExperienceFile(
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
      occurrence_count: 1,
      content_hash: v1RealContentHash,
    },
    VALID_BODY,
  );
  await fs.writeFile(path.join(scopeDir, `${documentId}.md`), v1RealRaw, "utf-8");

  // "入侵者"内容：一份合法的 v2——围栏状态（content_hash/occurrence_count）
  // 与 v1 的基线完全不同，代表"另一进程已经完成了自己完整的一轮更新"。
  intruderRaw = serializeExperienceFile(
    {
      document_id: documentId,
      document_version: 2,
      title: TITLE,
      domain: "workflow-experience",
      stage: "execute",
      task_type: "backend",
      project_scope: PROJECT_SCOPE,
      source: "yd:ai N5",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:05:00.000Z",
      risk_level: "medium",
      status: "candidate",
      occurrence_count: 1,
      content_hash: "intruder-content-hash-xyz",
      supersedes: `${documentId}@v1`,
    },
    VALID_BODY.replace("## 根因\n描述", "## 根因\n另一个写入者抢先完成的更新"),
  );

  supersededPath = path.join(scopeDir, ".superseded", `${documentId}@v1.md`);
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertExperience — 归档源读取前的围栏核实（Codex Review 第二十六轮）", () => {
  it("早期围栏检查通过后、归档源读取时发现内容已被替换，必须中止且不污染历史归档，不调用 atomicWriteExperience", async () => {
    const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n本进程试图提交的更新");
    const result = await upsertExperience({
      experienceRoot: tmpDir,
      title: TITLE,
      stage: "execute",
      taskType: "backend",
      projectScope: PROJECT_SCOPE,
      source: "yd:ai N5",
      riskLevel: "medium",
      body: updatedBody,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "conflict");
    assert.equal(
      atomicWriteMock.mock.callCount(),
      0,
      "归档前发现内容已被替换时不应调用 atomicWriteExperience",
    );

    // 核心断言：归档文件必须从未被创建——不是"创建了但内容是错的"，
    // 而是"在写入归档文件之前就已经中止"，历史版本 v1 的归档位置
    // 不应该被"入侵者"的 v2 内容污染。
    await assert.rejects(
      () => fs.stat(supersededPath),
      "归档文件不应被创建，避免用错误版本的内容污染历史归档",
    );
  });
});
