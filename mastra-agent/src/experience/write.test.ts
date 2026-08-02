/**
 * write.ts 的原子写入、并发锁与 upsertExperience 主流程测试。
 * 全部使用 os.tmpdir() 下的临时目录，不触碰仓库内任何真实路径。
 *
 * "先归档、后覆盖"崩溃安全性的测试（AC-006 第二部分）需要 mock 掉
 * atomicWriteExperience 模拟"归档完成、原子写入尚未执行"这个具体时间点
 * ——见 write.crash-ordering.test.ts（node:test 的模块级 mock 只能拦截
 * 跨文件 import，不能和本文件的"真实实现"测试混在同一个进程里）。
 */

import assert from "node:assert/strict";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { atomicWriteExperience } from "./atomic-write.ts";
import { fenceStatesEqual, readCurrentFenceState } from "./read-content-hash.ts";
import {
  coerceFrontmatter,
  generateDocumentId,
  parseExperienceFile,
  serializeExperienceFile,
  validateExperience,
} from "./schema.ts";
import {
  LockLostError,
  acquireLock,
  lockPathFor,
  type UpsertCandidate,
  upsertExperience,
} from "./write.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-write-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

function candidate(overrides: Partial<UpsertCandidate> = {}): UpsertCandidate {
  return {
    experienceRoot: tmpDir,
    title: "锁竞态修复经验",
    stage: "execute",
    taskType: "backend",
    projectScope: "ai-kefu-test",
    source: "yd:ai N5",
    riskLevel: "medium",
    body: VALID_BODY,
    ...overrides,
  };
}

describe("atomicWriteExperience", () => {
  it("写入后可读回，且不残留 .tmp- 临时文件", async () => {
    const targetPath = path.join(tmpDir, "doc.md");
    await atomicWriteExperience(targetPath, "hello");
    assert.equal(await fs.readFile(targetPath, "utf-8"), "hello");
    const entries = await fs.readdir(tmpDir);
    assert.ok(!entries.some((e) => e.includes(".tmp-")), "不应残留 tmp 文件");
  });
});

// 直接测试真实（未经 mock.module() 替换）的 fenceStatesEqual/
// readCurrentFenceState 本身——write.duplicate-content-conflict.test.ts
// 用 mock.module() 整体替换了 "./read-content-hash.ts" 的导出（包括
// fenceStatesEqual 本身，只能在 mock 里内联复刻真实逻辑），只验证了
// write.ts 在"围栏检查返回不相等"时的控制流分支是否正确，**不能**
// 证明真实的 fenceStatesEqual 实现本身确实把 occurrenceCount 纳入了
// 比较（第十九轮 Codex Review 修复的核心正是这个函数本身的比较逻辑）。
// 这里必须对未经替换的真实模块直接断言，才是这个 bug 修复的真正回归
// 测试；上面 mock 版本的测试仍然有价值（证明 write.ts 正确调用并响应
// 这个依赖），但两者缺一不可。
describe("fenceStatesEqual — 真实实现（不经 mock.module() 替换）", () => {
  it("两侧都是 null 视为相等", () => {
    assert.equal(fenceStatesEqual(null, null), true);
  });

  it("一侧为 null、另一侧非 null 视为不相等", () => {
    assert.equal(fenceStatesEqual(null, { contentHash: "a", occurrenceCount: 1 }), false);
    assert.equal(fenceStatesEqual({ contentHash: "a", occurrenceCount: 1 }, null), false);
  });

  it("contentHash 与 occurrenceCount 都相同才视为相等", () => {
    assert.equal(
      fenceStatesEqual({ contentHash: "abc", occurrenceCount: 3 }, { contentHash: "abc", occurrenceCount: 3 }),
      true,
    );
  });

  it("第十九轮 Codex Review 核心断言：contentHash 相同、occurrenceCount 不同必须判定为不相等（不能只比 contentHash）", () => {
    assert.equal(
      fenceStatesEqual({ contentHash: "abc", occurrenceCount: 1 }, { contentHash: "abc", occurrenceCount: 2 }),
      false,
      "两次并发的相同内容提交只会让 occurrence_count 变化，content_hash 不变——" +
        "只比 content_hash 的旧实现会在这里误判为相等，导致其中一次的计数增量被静默覆盖丢失",
    );
  });

  it("occurrenceCount 相同、contentHash 不同必须判定为不相等", () => {
    assert.equal(
      fenceStatesEqual({ contentHash: "abc", occurrenceCount: 1 }, { contentHash: "xyz", occurrenceCount: 1 }),
      false,
    );
  });
});

describe("readCurrentFenceState — 真实实现（不经 mock.module() 替换）", () => {
  it("目标文件不存在时返回 null", async () => {
    const result = await readCurrentFenceState(path.join(tmpDir, "does-not-exist.md"));
    assert.equal(result, null);
  });

  it("读取真实文件时返回的 contentHash/occurrenceCount 与 frontmatter 一致", async () => {
    const targetPath = path.join(tmpDir, "doc.md");
    const content = [
      "---",
      'document_id: "abc123"',
      "document_version: 1",
      'title: "测试"',
      "domain: workflow-experience",
      "stage: execute",
      "task_type: backend",
      'project_scope: "test-scope"',
      'source: "yd:ai N5"',
      'created_at: "2026-08-01T00:00:00.000Z"',
      'updated_at: "2026-08-01T00:00:00.000Z"',
      "risk_level: medium",
      "status: candidate",
      "occurrence_count: 7",
      'content_hash: "deadbeef12345678"',
      "---",
      "",
      "# 标题",
      "",
    ].join("\n");
    await fs.writeFile(targetPath, content, "utf-8");

    const result = await readCurrentFenceState(targetPath);
    assert.deepEqual(result, { contentHash: "deadbeef12345678", occurrenceCount: 7 });
  });
});

describe("acquireLock/release", () => {
  it("获取锁后锁文件存在，release 后消失", async () => {
    const lockPath = lockPathFor("doc1", tmpDir);
    const lock = await acquireLock(lockPath);
    assert.equal(await fs.readFile(lockPath, "utf-8").then(() => true), true);
    await lock.release();
    await assert.rejects(() => fs.readFile(lockPath, "utf-8"));
  });

  it("assertStillHeld 在持有期间不抛错", async () => {
    const lockPath = lockPathFor("doc2", tmpDir);
    const lock = await acquireLock(lockPath);
    await assert.doesNotReject(() => lock.assertStillHeld());
    await lock.release();
  });

  it("锁内容被他人改写后 assertStillHeld 抛 LockLostError（模拟被抢占）", async () => {
    const lockPath = lockPathFor("doc3", tmpDir);
    const lock = await acquireLock(lockPath);
    await fs.writeFile(lockPath, "someone-else-token"); // 模拟另一进程抢占
    await assert.rejects(() => lock.assertStillHeld(), LockLostError);
  });

  it("AC-007b: 手工构造陈旧锁后，正常写入能自动回收并成功（不永久超时）", async () => {
    const lockPath = lockPathFor("doc4", tmpDir);
    await fs.writeFile(lockPath, "stale-owner-token");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    const start = Date.now();
    const lock = await acquireLock(lockPath, 5000, { staleLockMs: 50 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `陈旧锁回收耗时应远小于超时阈值，实际 ${elapsed}ms`);
    await lock.release();
  });

  it("陈旧锁无法安全 unlink（持续失败）时必须遵守 timeoutMs，不无限忙等——真实触发 unlink 失败，不用条件断言", async () => {
    const lockPath = lockPathFor("doc-unlink-fails", tmpDir);
    await fs.writeFile(lockPath, "stale-owner-token");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    // 直接对共享的 fs/promises 单例打补丁（write.ts 与本文件 import 的
    // 是同一个模块实例，Node 的 fs/promises 默认导出对象本身可写，无需
    // node:test 的 mock.module()）——unlink 恒定拒绝，真实模拟"陈旧锁
    // 判定为可回收，但物理删除持续失败（EACCES/只读文件系统等）"这个
    // 场景。不修改 stat/readFile，让"判定为陈旧"这条路径本身正常走通，
    // 只让最后一步"真正删除"失败，这样才是在测 write.ts 里
    // `if (reclaimed) continue;` 这条 Codex Review 修复本身，而不是在
    // 测别的分支。
    const originalUnlink = fs.unlink;
    fs.unlink = (async () => {
      throw Object.assign(new Error("simulated EACCES: cannot unlink stale lock"), { code: "EACCES" });
    }) as typeof fs.unlink;

    try {
      const start = Date.now();
      const timeoutMs = 300;
      await assert.rejects(
        () => acquireLock(lockPath, timeoutMs, { staleLockMs: 10 }),
        /获取经验写入锁超时/,
      );
      const elapsed = Date.now() - start;
      // 必须真的等到 timeoutMs 附近才失败（证明没有在 unlink 持续失败时
      // 无条件 continue、跳过超时检查变成忙等待）；上限给足够宽松的余量
      // 避免测试环境噪音导致偶发失败，但仍然远小于"无限等待"。
      assert.ok(elapsed >= timeoutMs, `应等待至少 timeoutMs=${timeoutMs}ms 才超时，实际 ${elapsed}ms`);
      assert.ok(elapsed < timeoutMs + 3000, `不应远超 timeoutMs 才返回，实际 ${elapsed}ms（说明可能仍在忙等待或卡住）`);
    } finally {
      fs.unlink = originalUnlink;
      // 锁文件此时仍然是最初手工构造的那把陈旧锁（unlink 全程失败，
      // 从未被真正删除）——用真实 unlink 清理测试现场，不留残留文件
      // 影响其他用例。
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it("AC-007d: 心跳持续刷新期间，长时间处理不被误判陈旧，并发获取应超时而非抢占成功", async () => {
    const lockPath = lockPathFor("doc5", tmpDir);
    const holder = await acquireLock(lockPath, 5000, { staleLockMs: 300, heartbeatIntervalMs: 100 });

    const contender = acquireLock(lockPath, 400, { staleLockMs: 300, heartbeatIntervalMs: 100 }).then(
      () => "acquired",
      () => "timeout",
    );

    await new Promise((r) => setTimeout(r, 600)); // 超过 staleLockMs，但心跳应持续刷新 mtime
    await assert.doesNotReject(() => holder.assertStillHeld());
    assert.equal(await contender, "timeout", "心跳期间不应被并发请求误判陈旧并抢占");

    await holder.release();
  });

  it("原持有者的心跳不会刷新接班者在同一路径新建的锁（第二十三轮 Codex Review）", async () => {
    const lockPath = lockPathFor("doc-heartbeat-cross-refresh", tmpDir);
    const lock = await acquireLock(lockPath, 5000, { heartbeatIntervalMs: 20 });

    try {
      // 模拟"另一进程已经完成了完整的陈旧回收流程"这一既成事实——直接
      // 操作文件系统把同一路径替换成接班者自己的锁，不经过 acquireLock()
      // （那是另一个进程的行为，这里只关心原持有者心跳这一侧会不会
      // 误伤它）。刻意把 mtime 设成"陈旧"，用来证明后续心跳有没有把它
      // 悄悄刷新成"看起来很新鲜"。
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, "successor-token", "utf-8");
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(lockPath, staleTime, staleTime);

      // 等待远超过心跳间隔（20ms）的时间，让原持有者的心跳有充分机会
      // （修复前的按路径实现会）去刷新这个新文件的 mtime。
      await new Promise((r) => setTimeout(r, 150));

      const stat = await fs.stat(lockPath);
      assert.ok(
        Math.abs(stat.mtimeMs - staleTime.getTime()) < 2000,
        `原持有者的心跳不应刷新接班者新建的锁文件的 mtime，实际 mtime 距设定值偏移 ${Math.abs(stat.mtimeMs - staleTime.getTime())}ms`,
      );
      assert.equal(await fs.readFile(lockPath, "utf-8"), "successor-token", "接班者的锁内容不应被破坏");
    } finally {
      // release() 会先比对锁内容与自己的 token 是否一致——此刻内容是
      // "successor-token"，不匹配，不会误删接班者的锁，只负责关闭自己
      // 那个（此刻已从目录中摘除的）fd；接班者的假锁文件需要测试自己
      // 清理。
      await lock.release().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it("排他创建成功但写入 token 失败时，清理已创建的空锁文件，不留孤儿锁（第二十四轮 Codex Review）", async () => {
    const lockPath = lockPathFor("doc-token-write-fail", tmpDir);
    const originalOpen = fs.open;
    const writeError = new Error("模拟磁盘写满导致 token 写入失败");

    // 直接对共享的 fs/promises 单例打补丁——用 Proxy 包一层刚打开的
    // 真实 handle：writeFile 恒定失败，其余方法（尤其 close）原样委托
    // 给真实 handle，这样才能真实模拟"排他创建已经成功、写入 token 这
    // 一步才失败"这个具体故障点，而不是让 open 本身就失败（那是另一条
    // 已经测过的分支）。显式用 target[prop].bind(target) 而不是让
    // Proxy 的 receiver 参与调用——Node 的 FileHandle 内部用私有字段做
    // brand check，如果方法以 Proxy 本身作为 this 被调用会直接抛错。
    fs.open = (async (...args: unknown[]) => {
      const realHandle = await (originalOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
      return new Proxy(realHandle, {
        get(target, prop) {
          if (prop === "writeFile") {
            return async () => {
              throw writeError;
            };
          }
          const value = (target as unknown as Record<string, unknown>)[prop as string];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof fs.open;

    try {
      await assert.rejects(
        () => acquireLock(lockPath, 5000),
        (err: unknown) => err === writeError,
        "必须原样抛出底层错误，清理动作不能掩盖它",
      );
      await assert.rejects(() => fs.stat(lockPath), "写入 token 失败后不应残留空锁文件");
    } finally {
      fs.open = originalOpen;
      await fs.unlink(lockPath).catch(() => {});
    }
  });
});

describe("upsertExperience — AC-001/002/005", () => {
  it("AC-001: 新建经验，frontmatter 14 字段齐全且合法", async () => {
    const result = await upsertExperience(candidate());
    assert.equal(result.ok, true);
    assert.equal(result.documentVersion, 1);
    assert.equal(result.occurrenceCount, 1);

    const raw = await fs.readFile(result.filePath!, "utf-8");
    const { frontmatter, body } = parseExperienceFile(raw);
    const fm = coerceFrontmatter(frontmatter);
    assert.equal(validateExperience(fm, body).ok, true);
  });

  it("AC-002: 正文缺少必需二级标题时返回明确失败原因，不写入文件", async () => {
    const badBody = VALID_BODY.replace("## 验证方法\n描述\n", "");
    const result = await upsertExperience(candidate({ body: badBody, title: "缺节测试" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "validation_failed");
    assert.ok(result.errors!.some((e) => e.includes("验证方法")));

    const entries = await fs.readdir(tmpDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => typeof e === "string" && e.endsWith(".md")), "校验失败不应写入任何 md 文件");
  });

  it("AC-005: 命中 Token 类内容时 blocked，不写入文件", async () => {
    const body = VALID_BODY.replace("## 问题表现\n描述", "## 问题表现\nsk-abcdefghijklmnopqrstuvwxyz123456");
    const result = await upsertExperience(candidate({ body, title: "密钥测试" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked");

    const entries = await fs.readdir(tmpDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => typeof e === "string" && e.endsWith(".md")), "blocked 内容不应写入任何 md 文件");
  });

  it("source 含邮箱时被脱敏后写入 frontmatter，不是原样落盘", async () => {
    const result = await upsertExperience(candidate({ source: "yd:ai N5 by alice@example.com" }));
    assert.equal(result.ok, true);
    const raw = await fs.readFile(result.filePath!, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    assert.ok(!fm.source.includes("alice@example.com"), "邮箱不应原样落盘");
    assert.match(fm.source, /<email-redacted>/);
  });

  it("title/source 命中 Token 类内容时同样 blocked（不能只检查正文绕过脱敏）", async () => {
    const result = await upsertExperience(
      candidate({ title: "泄露 sk-abcdefghijklmnopqrstuvwxyz123456 的经验" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked");
  });

  it("project_scope 含 .. 路径穿越时被拒绝，不在仓库外创建目录", async () => {
    const result = await upsertExperience(candidate({ projectScope: "../../etc" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_project_scope");
    await assert.rejects(() => fs.stat(path.join(tmpDir, "..", "..", "etc")));
  });

  it("project_scope 是裸 .. 时被拒绝", async () => {
    const result = await upsertExperience(candidate({ projectScope: ".." }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_project_scope");
  });

  it("project_scope 含路径分隔符时被拒绝", async () => {
    const result = await upsertExperience(candidate({ projectScope: "foo/bar" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_project_scope");
  });

  it("project_scope 是绝对路径时被拒绝", async () => {
    const result = await upsertExperience(candidate({ projectScope: "/etc/passwd" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_project_scope");
  });

  it("project_scope 对应目录已存在且是指向根目录之外的符号链接时被拒绝", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-outside-"));
    const linkPath = path.join(tmpDir, "sneaky-scope");
    await fs.symlink(outsideDir, linkPath, "dir");

    try {
      await assert.rejects(() => upsertExperience(candidate({ projectScope: "sneaky-scope" })));
      const outsideEntries = await fs.readdir(outsideDir);
      assert.deepEqual(outsideEntries, [], "不应在符号链接指向的仓库外目录里创建任何文件");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it(".superseded 目录被替换为指向根目录之外的符号链接时，归档写入被拒绝（Codex Review 第十六轮）", async () => {
    const first = await upsertExperience(candidate({ projectScope: "symlink-superseded" }));
    assert.equal(first.ok, true);

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-outside-superseded-"));
    const supersededLink = path.join(tmpDir, "symlink-superseded", ".superseded");
    await fs.symlink(outsideDir, supersededLink, "dir");

    try {
      const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n试图逃逸的更新");
      await assert.rejects(() =>
        upsertExperience(candidate({ projectScope: "symlink-superseded", body: updatedBody })),
      );
      const outsideEntries = await fs.readdir(outsideDir);
      assert.deepEqual(outsideEntries, [], "不应在符号链接指向的仓库外目录里创建任何归档文件");

      const scopeEntries = await fs.readdir(path.join(tmpDir, "symlink-superseded"));
      assert.ok(!scopeEntries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
    } finally {
      await fs.unlink(supersededLink).catch(() => {});
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("归档文件路径本身（而非其父目录）是符号链接时，归档写入被拒绝，不覆盖外部文件（第十七轮 Codex Review）", async () => {
    const first = await upsertExperience(candidate({ projectScope: "symlink-archive-file" }));
    assert.equal(first.ok, true);

    // 目录层面完全正常（不像上一条用例那样把 .superseded 整个换成符号
    // 链接）——真正的攻击面是目录*里*那个具体归档文件路径本身。
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-outside-archive-file-"));
    const outsideTarget = path.join(outsideDir, "victim.md");
    const originalOutsideContent = "外部文件的原始内容，不应被覆盖";
    await fs.writeFile(outsideTarget, originalOutsideContent, "utf-8");

    const supersededDir = path.join(tmpDir, "symlink-archive-file", ".superseded");
    await fs.mkdir(supersededDir, { recursive: true });
    const archiveLinkPath = path.join(supersededDir, `${first.documentId}@v1.md`);
    await fs.symlink(outsideTarget, archiveLinkPath, "file");

    try {
      const updatedBody = VALID_BODY.replace(
        "## 根因\n描述",
        "## 根因\n试图通过归档文件符号链接逃逸的更新",
      );
      await assert.rejects(() =>
        upsertExperience(candidate({ projectScope: "symlink-archive-file", body: updatedBody })),
      );

      // 核心断言：外部文件内容必须原封不动——writeArchiveFile() 的
      // O_NOFOLLOW 必须在 open 阶段就拒绝，不能像默认的 fs.writeFile()
      // 那样跟随符号链接把新内容写进这个仓库之外的文件里。
      assert.equal(
        await fs.readFile(outsideTarget, "utf-8"),
        originalOutsideContent,
        "归档写入不应跟随符号链接覆盖 experienceRoot 之外的文件",
      );
      // 符号链接本身应原样保留（拒绝写入，不是先删链接再报错这种旁路）。
      const linkStat = await fs.lstat(archiveLinkPath);
      assert.ok(linkStat.isSymbolicLink(), "符号链接本身不应被移除/替换");

      const scopeEntries = await fs.readdir(path.join(tmpDir, "symlink-archive-file"));
      assert.ok(!scopeEntries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
    } finally {
      await fs.unlink(archiveLinkPath).catch(() => {});
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("归档写入原子失败（rename 失败）时不损坏已存在的旧归档文件，不留孤儿 tmp 文件（第二十八轮 Codex Review）", async () => {
    const projectScope = "archive-atomic-rename-fail";
    const first = await upsertExperience(candidate({ projectScope }));
    assert.equal(first.ok, true);

    const scopeDir = path.join(tmpDir, projectScope);
    const supersededDir = path.join(scopeDir, ".superseded");
    await fs.mkdir(supersededDir, { recursive: true });
    // 手工预先放置一份"上一次尝试遗留"的合法归档文件——模拟崩溃后重试
    // 场景（旧实现的 O_TRUNC 直接原地写就是为了兼容这个场景，见改动前
    // 的注释），验证新的 tmp+rename 实现在这种场景下同样安全：这份
    // 遗留内容必须在归档 rename 失败时保持完全不变，不能被截断或
    // 部分覆盖。
    const priorArchivePath = path.join(supersededDir, `${first.documentId}@v1.md`);
    const priorArchiveContent = "上一次尝试遗留的合法归档内容，不应被本次失败的写入损坏\n";
    await fs.writeFile(priorArchivePath, priorArchiveContent, "utf-8");

    const originalRename = fs.rename;
    const renameError = new Error("模拟磁盘写满导致归档 rename 失败");
    fs.rename = (async () => {
      throw renameError;
    }) as typeof fs.rename;

    try {
      const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n触发归档 rename 失败的更新");
      await assert.rejects(
        () => upsertExperience(candidate({ projectScope, body: updatedBody })),
        (err: unknown) => err === renameError,
        "必须原样抛出底层错误，清理动作不能掩盖它",
      );

      // 核心断言：旧归档文件必须完全未被触碰——不是被截断成空文件，
      // 也不是被替换成半截内容，这正是本轮 Codex Review 指出的 F-006
      // 违规场景（进程崩溃/写入失败可能销毁本该保留的唯一旧版本）。
      assert.equal(
        await fs.readFile(priorArchivePath, "utf-8"),
        priorArchiveContent,
        "归档 rename 失败时不应损坏已存在的旧归档文件",
      );

      const entries = await fs.readdir(supersededDir);
      assert.ok(!entries.some((e) => e.includes(".tmp-")), "rename 失败后不应残留归档 tmp 文件");
    } finally {
      fs.rename = originalRename;
    }
  });

  it("经验文件规范路径本身（{document_id}.md）是符号链接时，写入被拒绝，不跟随读取外部文件（第二十二轮 Codex Review）", async () => {
    const projectScope = "symlink-active-file";
    const documentId = generateDocumentId({
      projectScope,
      taskType: "backend",
      stage: "execute",
      title: "锁竞态修复经验",
    });
    const scopeDir = path.join(tmpDir, projectScope);
    await fs.mkdir(scopeDir, { recursive: true });

    // 攻击者预先在这个确切路径放一个指向 experienceRoot 之外的符号
    // 链接——这一步先于任何 upsertExperience() 调用，模拟"文件在被
    // 首次访问之前就已经不是一个普通文件"这个具体场景。
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-outside-active-file-"));
    const outsideTarget = path.join(outsideDir, "victim.md");
    const originalOutsideContent = "外部文件的原始内容，不应被读取或覆盖";
    await fs.writeFile(outsideTarget, originalOutsideContent, "utf-8");

    const targetPath = path.join(scopeDir, `${documentId}.md`);
    await fs.symlink(outsideTarget, targetPath, "file");

    try {
      await assert.rejects(
        () => upsertExperience(candidate({ projectScope })),
        /符号链接/,
        "readActiveFileNoFollow 应当在 open 阶段就以 ELOOP 拒绝跟随",
      );

      // 核心断言：外部文件内容必须原封不动——不能因为跟随了符号链接
      // 而把它的内容当作"现存版本"读入，也不能在后续任何步骤覆盖它。
      assert.equal(
        await fs.readFile(outsideTarget, "utf-8"),
        originalOutsideContent,
        "不应跟随符号链接读取或覆盖 experienceRoot 之外的文件",
      );
      // 符号链接本身应原样保留（拒绝写入，不是先删链接再报错这种旁路）。
      const linkStat = await fs.lstat(targetPath);
      assert.ok(linkStat.isSymbolicLink(), "符号链接本身不应被移除/替换");

      // 由于读取阶段就已中止，不应该发生任何归档动作。
      await assert.rejects(() => fs.stat(path.join(scopeDir, ".superseded")));

      const scopeEntries = await fs.readdir(scopeDir);
      assert.ok(!scopeEntries.some((e) => e.endsWith(".lock")), "不应残留锁文件");
    } finally {
      await fs.unlink(targetPath).catch(() => {});
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("experienceRoot 本身是符号链接时被拒绝，不在符号链接指向的外部目录里创建任何文件（第三十一轮 Codex Review）", async () => {
    // 真实的"外部目录"——如果 experienceRoot 本身是符号链接却没有被
    // 拦截，project 目录/锁文件/归档/Markdown 最终都会被操作系统解析
    // 到这里，而不是调用方以为的那个 experienceRoot。
    const realExternalDir = await fs.mkdtemp(path.join(os.tmpdir(), "experience-root-external-"));
    // 符号链接路径本身不能是 tmpDir（那是本文件其余用例默认使用的
    // 真实 experienceRoot），必须是一个独立的新路径。
    const symlinkRootPath = path.join(os.tmpdir(), `experience-root-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.symlink(realExternalDir, symlinkRootPath, "dir");

    try {
      await assert.rejects(
        () => upsertExperience(candidate({ experienceRoot: symlinkRootPath })),
        /符号链接/,
        "experienceRoot 本身是符号链接时应当在触碰文件系统之前就拒绝",
      );

      // 核心断言：符号链接实际指向的外部目录里不应该出现任何文件——
      // 不是 project 目录、不是锁文件、不是 Markdown，一个都不应该有。
      assert.deepEqual(
        await fs.readdir(realExternalDir),
        [],
        "不应在 experienceRoot 符号链接指向的外部目录里创建任何文件",
      );
      // 符号链接本身应原样保留（拒绝写入，不是先删链接再报错这种旁路）。
      const linkStat = await fs.lstat(symlinkRootPath);
      assert.ok(linkStat.isSymbolicLink(), "符号链接本身不应被移除/替换");
    } finally {
      await fs.unlink(symlinkRootPath).catch(() => {});
      await fs.rm(realExternalDir, { recursive: true, force: true });
    }
  });
});

describe("upsertExperience — AC-004 版本递增与 supersedes", () => {
  it("内容变化时 document_version 递增，旧版本归档到 .superseded/", async () => {
    const first = await upsertExperience(candidate());
    assert.equal(first.documentVersion, 1);

    const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n更新后的根因描述");
    const second = await upsertExperience(candidate({ body: updatedBody }));
    assert.equal(second.ok, true);
    assert.equal(second.documentId, first.documentId);
    assert.equal(second.documentVersion, 2);
    assert.equal(second.occurrenceCount, 1);

    const raw = await fs.readFile(second.filePath!, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    assert.equal(fm.supersedes, `${first.documentId}@v1`);

    const supersededPath = path.join(
      tmpDir,
      "ai-kefu-test",
      ".superseded",
      `${first.documentId}@v1.md`,
    );
    const archived = await fs.readFile(supersededPath, "utf-8");
    assert.ok(archived.includes("触发场景"));
  });

  it("内容变化时新版本必须重置为 candidate，不得沿用旧版本的 verified/deprecated 状态（第二十五轮 Codex Review）", async () => {
    const first = await upsertExperience(candidate({ projectScope: "status-reset-scope" }));
    assert.equal(first.ok, true);

    // 直接在磁盘上把 v1 标记为 verified，模拟"这份内容已经通过审核"
    // ——不经过 lifecycle.ts 的 transition()，因为这里只关心 write.ts
    // 在"内容发生实质变化"这条分支上是否正确处理已有的 status 字段，
    // 与 lifecycle 状态机本身的迁移规则是两回事。
    const raw = await fs.readFile(first.filePath!, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    const verifiedContent = serializeExperienceFile(
      { ...fm, status: "verified" },
      parseExperienceFile(raw).body,
    );
    await fs.writeFile(first.filePath!, verifiedContent, "utf-8");

    const updatedBody = VALID_BODY.replace("## 根因\n描述", "## 根因\n内容发生了实质变化");
    const second = await upsertExperience(
      candidate({ projectScope: "status-reset-scope", body: updatedBody }),
    );
    assert.equal(second.ok, true);
    assert.equal(second.documentVersion, 2, "内容变化应当递增版本号");

    const secondRaw = await fs.readFile(second.filePath!, "utf-8");
    const secondFm = coerceFrontmatter(parseExperienceFile(secondRaw).frontmatter);
    assert.equal(
      secondFm.status,
      "candidate",
      "内容实质变化的新版本必须重新从 candidate 起步，不能沿用旧版本已经 verified 的状态",
    );
  });

  it("仅前导/多余尾随空白不同、归一化后字节完全一致的正文必须走去重路径，不得凭空生成新版本（第三十轮 Codex Review）", async () => {
    const first = await upsertExperience(candidate({ projectScope: "hash-normalize-scope" }));
    assert.equal(first.ok, true);
    assert.equal(first.documentVersion, 1);
    assert.equal(first.occurrenceCount, 1);

    // 语义上与首次提交完全相同的正文，只是前面多了空行、后面多了几个
    // 换行——`serializeExperienceFile()` 落盘时会用 `body.trim() + "\n"`
    // 把两者归一化成字节完全一致的文件内容，content_hash 的计算必须
    // 基于同一份归一化结果，否则会把这次提交误判成"内容变化"。
    const whitespaceVariedBody = `\n\n${VALID_BODY}\n\n\n`;
    const second = await upsertExperience(
      candidate({ projectScope: "hash-normalize-scope", body: whitespaceVariedBody }),
    );

    assert.equal(second.ok, true);
    assert.equal(second.documentId, first.documentId);
    assert.equal(
      second.documentVersion,
      1,
      "仅空白差异、归一化后内容相同时不应递增 document_version",
    );
    assert.equal(
      second.occurrenceCount,
      2,
      "应当走去重路径，occurrence_count 从 1 累加到 2",
    );

    // 不应该产生任何归档——版本号从未递增，说明从未触发过归档分支。
    await assert.rejects(() =>
      fs.stat(path.join(tmpDir, "hash-normalize-scope", ".superseded")),
    );
  });
});

describe("upsertExperience — AC-007 并发写入相同内容", () => {
  it("两个并发请求写入完全相同内容，occurrence_count 正确累加为 2，只有一份文件", async () => {
    const [a, b] = await Promise.all([upsertExperience(candidate()), upsertExperience(candidate())]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.documentId, b.documentId);

    const raw = await fs.readFile(a.filePath!, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
    assert.equal(fm.occurrence_count, 2);
    assert.equal(fm.document_version, 1);
  });
});

describe("upsertExperience — AC-007c 并发写入不同内容，不发生更新丢失", () => {
  it("两个并发请求写入不同内容，最终两次更新都真实生效，不产生静默覆盖", async () => {
    const bodyA = VALID_BODY.replace("## 根因\n描述", "## 根因\n版本 A 的根因");
    const bodyB = VALID_BODY.replace("## 根因\n描述", "## 根因\n版本 B 的根因");

    const [a, b] = await Promise.all([
      upsertExperience(candidate({ body: bodyA })),
      upsertExperience(candidate({ body: bodyB })),
    ]);

    // 两次请求内容不同、场景相同（同一 document_id）——按 AC-007c 的
    // 口径：真正串行执行的两次合法更新都必须生效，不允许"其中一次基于
    // 旧状态计算的结果覆盖另一次"。lock 是纯 fs.open("wx") 排他创建，
    // 没有人为注入陈旧锁，因此两个请求会被序列化（各自拿到锁、写入、
    // 释放），不会真的触发 LockLostError 分支——那个分支只在锁被误判
    // 陈旧时触发，见 AC-007b/d 测试。
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.documentId, b.documentId);

    const documentId = a.documentId!;
    const targetPath = path.join(tmpDir, "ai-kefu-test", `${documentId}.md`);
    const raw = await fs.readFile(targetPath, "utf-8");
    const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);

    // 最终状态必须体现"第二个执行的请求确实基于第一个的结果继续演进"：
    // document_version=2（两次不同内容依次生效），occurrence_count=1
    // （最新一次是"新版本"的第一次观察，不是重复内容的累加）。
    assert.equal(fm.document_version, 2);
    assert.equal(fm.occurrence_count, 1);

    const supersededDir = path.join(tmpDir, "ai-kefu-test", ".superseded");
    const archivedFiles = await fs.readdir(supersededDir);
    assert.equal(archivedFiles.length, 1, "应恰好归档一份被取代的版本");
  });
});
