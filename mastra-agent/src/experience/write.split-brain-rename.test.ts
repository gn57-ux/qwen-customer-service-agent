/**
 * 第二十三轮 Codex Review 指出的真实 bug 的专项回归测试——"紧贴在
 * atomicWriteExperience() 之前的所有权重新校验"这道防线，必须真的能
 * 堵住"围栏检查通过之后、rename 之前，所有权被另一进程窃取"这个具体
 * 窗口：
 *
 *   陈旧锁回收允许极小概率的"获取阶段短暂多方持有"（见 write.ts 顶部
 *   acquireLock() 的说明）。如果所有权恰好在"晚期围栏检查通过"之后、
 *   "真正 rename"之前的这段窗口内被另一进程回收并重新持有，而围栏
 *   状态本身（内容/occurrence_count）并没有变化——只是锁的归属变了——
 *   旧实现会在没有再次核实所有权的情况下直接 rename，两个进程可能各自
 *   对着自己刚写入的内容验证成功、都报告 `ok: true`，其中一次的更新
 *   被静默覆盖丢失，"最终只有一个进程完成写入"这条保证被打破。
 *
 * 用 mock.module() 替换 "./read-content-hash.ts" 的 readCurrentFenceState
 * ——在它被调用第二次（对应晚期围栏检查）的那一刻，作为副作用把真实
 * 锁文件的内容整个替换成另一个 token，模拟"另一进程已经完成了完整的
 * 陈旧回收流程"这一既成事实，围栏状态本身照常返回"未变化"（因为这个
 * bug 的关键就在于：光看围栏状态看不出所有权已经易主）。断言：
 * upsertExperience() 必须在这之后、rename 之前发现所有权已丢失并中止，
 * 不能调用 atomicWriteExperience。
 *
 * 运行：
 *   node --experimental-test-module-mocks --import tsx --test \
 *     src/experience/write.split-brain-rename.test.ts
 */

import assert from "node:assert/strict";
import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

// 与 write.conflict.test.ts 同样的原因：mock.module() 整体替换导出，
// fenceStatesEqual 与 readActiveFileNoFollow 必须一并提供真实实现，
// 否则 write.ts 对它们的 import 会在模块加载阶段就报 SyntaxError；
// readActiveFileNoFollow 还必须是真实实现——本测试是"新建文档"场景，
// write.ts 读取"现存内容"这一步必须真实地读到"文件不存在"（返回
// null），打桩会让 existing 判断读到假数据。
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

// 由 before() 用与 write.ts 完全相同的算法算出真实锁路径填充——不能
// 猜测/硬编码一个假路径，否则劫持不会真正命中 write.ts 实际持有的锁。
let lockPathToHijack = "";
let fenceCheckCallCount = 0;
const readCurrentFenceStateMock = mock.fn(async (_targetPath: string) => {
  fenceCheckCallCount += 1;
  if (fenceCheckCallCount === 2) {
    // 第二次调用对应晚期围栏检查（第一次是早期围栏检查，在此之前完成）
    // ——在围栏检查本身返回结果之前，先把锁文件内容替换成"别的进程"的
    // token，模拟所有权恰好在这一刻被回收重建。
    await fs.writeFile(lockPathToHijack, "someone-else-token", "utf-8");
  }
  return null; // 新建场景：目标文件从未存在过，围栏状态从头到尾都是 null，不会因为这次劫持而改变
});
const atomicWriteMock = mock.fn(async (_targetPath: string, _content: string) => {
  throw new Error("不应该走到这里——紧贴在 rename 之前的所有权校验应该已经中止写入");
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

const { upsertExperience, lockPathFor } = await import("./write.ts");
const { generateDocumentId } = await import("./schema.ts");

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

const TITLE = "split-brain rename 测试";
const PROJECT_SCOPE = "split-brain-scope";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-split-brain-test-"));
  const projectDir = path.join(tmpDir, PROJECT_SCOPE);
  await fs.mkdir(projectDir, { recursive: true });
  const documentId = generateDocumentId({
    projectScope: PROJECT_SCOPE,
    taskType: "backend",
    stage: "execute",
    title: TITLE,
  });
  lockPathToHijack = lockPathFor(documentId, projectDir);
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertExperience — rename 前所有权被窃取（Codex Review 第二十三轮）", () => {
  it("晚期围栏检查通过后、rename 之前所有权被另一进程回收重建时，必须中止且不调用 atomicWriteExperience", async () => {
    const result = await upsertExperience({
      experienceRoot: tmpDir,
      title: TITLE,
      stage: "execute",
      taskType: "backend",
      projectScope: PROJECT_SCOPE,
      source: "yd:ai N5",
      riskLevel: "medium",
      body: VALID_BODY,
    });

    // 核心断言：内容级围栏检查本身认为"没有变化"（因为这个 bug 的
    // 关键就是围栏状态看不出所有权已经易主），必须靠紧贴在 rename
    // 之前的所有权校验才能发现并中止——不能因为围栏检查通过就直接
    // rename，否则会静默覆盖掉"接班者"已经生效的写入。
    assert.equal(result.ok, false);
    assert.equal(result.reason, "lock_lost");
    assert.equal(
      atomicWriteMock.mock.callCount(),
      0,
      "所有权已被窃取时不应调用 atomicWriteExperience（即使围栏检查本身没有发现内容冲突）",
    );
  });

  it("不会误删接班者重新持有的锁文件", async () => {
    // release() 会先比对锁内容与自己的 token 是否一致——此刻内容是
    // 劫持时写入的 "someone-else-token"，不匹配，不应该被误删。
    const content = await fs.readFile(lockPathToHijack, "utf-8");
    assert.equal(content, "someone-else-token", "所有权被窃取后，接班者的锁内容不应被原持有者的 release() 误删/篡改");
  });
});
