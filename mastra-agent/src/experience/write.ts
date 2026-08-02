/**
 * 原子写入 + 并发锁 + upsertExperience 主流程。
 *
 * 并发锁不引入第三方依赖（`proper-lockfile` 等），用标准库
 * `fs.open(path, "wx")` 排他创建自制——纯 POSIX 文件 API 无法让"获取锁"
 * 这一步本身做到完全无竞态的 compare-and-swap（经过多轮验证：先 stat
 * 判陈旧再 unlink 是 TOCTOU；改成 rename 到墓碑再按需归还，归还本身又是
 * 一次无条件覆盖式 rename，一样有竞态）。真正的互斥保证从"谁能拿到锁"
 * 移到"谁能被允许提交最终写入"：允许极小概率的获取阶段短暂多方持有，
 * 但落盘前必须用 assertStillHeld() 重新校验所有权凭证，失效则安全中止、
 * 不写入任何数据——这样无论获取锁阶段发生怎样的竞态，最终只会有一个
 * 进程真正完成写入。心跳（60s）远小于陈旧阈值（5min），把"持有者正常
 * 处理但被误判陈旧"的窗口压缩到"停顿到连一次心跳都发不出"这个量级；
 * 这与 Redis Redlock/etcd lease 面对"进程长时间挂起"场景时的理论边界
 * 是同一类问题，本地单机场景下的残余风险可接受。
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  type ExperienceFrontmatter,
  coerceFrontmatter,
  generateDocumentId,
  parseExperienceFile,
  serializeExperienceFile,
  validateExperience,
} from "./schema.ts";
import { redact } from "./redact.ts";
import { atomicWriteExperience } from "./atomic-write.ts";
import {
  type FenceState,
  fenceStatesEqual,
  readActiveFileNoFollow,
  readCurrentFenceState,
} from "./read-content-hash.ts";

export { atomicWriteExperience } from "./atomic-write.ts";

export function lockPathFor(documentId: string, experienceDir: string): string {
  return path.join(experienceDir, `${documentId}.lock`);
}

// 均可被 acquireLock() 的 opts 参数或环境变量覆盖——AC-007d 需要用远小于
// 5 分钟的阈值加速测试，不必真的等待，见 tasks.md T-004。
export const DEFAULT_STALE_LOCK_MS = Number(process.env.EXPERIENCE_LOCK_STALE_MS) || 5 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env.EXPERIENCE_LOCK_HEARTBEAT_MS) || 60 * 1000;

function newOwnerToken(): string {
  return `${process.pid}-${Date.now()}-${randomUUID()}`;
}

/**
 * 返回打开的 `FileHandle` 而不是简单的成功布尔值——心跳需要基于这个 fd
 * 做 `utimes()`，而不是按路径（见 acquireLock() 里的用法说明，第二十三
 * 轮 Codex Review 修复）。
 */
async function tryCreateFresh(lockPath: string, token: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try {
    await handle.writeFile(token, "utf-8");
  } catch (e) {
    // 排他创建已经成功，但写入所有权凭证本身失败（磁盘耗尽/瞬时 I/O
    // 错误等）——此时磁盘上已经留下一个空的 `.lock` 文件，如果不清理，
    // 后续任何进程都会把它当作"别人持有的活跃锁"，需要等满一整个
    // staleLockMs 才能判定陈旧并回收，把一次瞬时故障放大成一次长时间
    // 阻塞，还掩盖了真正的失败原因（Codex Review 指出的真实 bug）。
    // 必须关闭 fd 并删除这个刚创建、内容还是空的锁文件，再把原始错误
    // 原样抛出——不能让清理动作本身掩盖需要让调用方看到的错误。
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    throw e;
  }
  return handle;
}

export class LockLostError extends Error {}

export interface LockHandle {
  /** 落盘前必须调用；锁已被回收/重新持有则抛 LockLostError，调用方必须中止写入 */
  assertStillHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  staleLockMs?: number;
  heartbeatIntervalMs?: number;
}

export async function acquireLock(
  lockPath: string,
  timeoutMs = 5000,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const myToken = newOwnerToken();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const handle = await tryCreateFresh(lockPath, myToken);
    if (handle) {
      // 心跳必须基于已经打开的 fd 用 `handle.utimes()`，不能按路径用
      // `fs.utimes(lockPath, ...)`（第二十三轮 Codex Review 指出的真实
      // bug）：如果本进程在心跳间隔期间停顿过久（超过 staleLockMs 却
      // 没能发出下一次心跳），另一进程会判定这把锁陈旧、`unlink` 掉、
      // 在同一路径重新创建一把属于它自己的新锁；本进程恢复后，若心跳仍
      // 按路径操作，会不加区分地刷新"此刻这个路径上无论是谁的锁"的
      // mtime——把新 owner 的锁误刷新成"看起来很新鲜"，即使新 owner
      // 随后真的崩溃，陈旧检测也会被这个僵尸心跳永久蒙蔽，探测不到。
      // fd 天然没有这个问题：`unlink` 只是移除目录项，我们持有的 fd
      // 仍然引用着原来那个（此刻已从目录中摘除的）inode，`handle.
      // utimes()` 只会作用在这个"幽灵" inode 上，不会影响同一路径上
      // 新创建的文件——不需要额外的"心跳前先校验归属"这类本身仍有
      // TOCTOU 窗口的补丁，直接从机制上避免了这个问题。
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle.utimes(now, now).catch(() => {});
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      return {
        async assertStillHeld() {
          let current: string | null = null;
          try {
            current = await fs.readFile(lockPath, "utf-8");
          } catch {
            /* 文件不存在 → current 保持 null */
          }
          if (current !== myToken) {
            throw new LockLostError(`锁已被其他进程回收/重新持有：${lockPath}（本次写入必须中止，可重试）`);
          }
        },
        async release() {
          clearInterval(heartbeat);
          try {
            const current = await fs.readFile(lockPath, "utf-8");
            if (current === myToken) await fs.unlink(lockPath);
          } catch {
            /* 已不存在/读取失败，视为无需再处理 */
          } finally {
            await handle.close().catch(() => {});
          }
        },
      };
    }

    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > staleLockMs) {
        // 紧贴在 unlink 之前再读一次内容+mtime，只有两次读到的结果完全
        // 一致才回收——单纯"stat 一次就直接 unlink"会把"陈旧锁被判定"
        // 到"真正删除"之间的任意时长窗口都暴露给竞态：另一个进程可能
        // 已经在这段时间内回收并重新持有了这把锁，我们的 unlink 会
        // 无差别删除"当前实际存在的文件"，不管它是不是我们最初判定为
        // 陈旧的那一份（Codex Review 指出的真实 bug）。这个 recheck
        // 不能把窗口彻底消灭（两次 await 之间仍有极短间隙，POSIX 文件
        // API 做不到真正的内容级 CAS），但能把"误抢一把其实已经不陈旧
        // 的锁"这类情况从"stat 到 unlink 之间的任意时长"压缩到"两次
        // 背靠背系统调用之间的极短间隔"。真正防止"两个进程都完成写入"
        // 的保证不在这里，而在 upsertExperience() 落盘前的
        // content_hash 围栏检查——即使这里的回收判断出错，围栏检查仍
        // 会在数据层面挡住覆盖。
        const staleToken = await fs.readFile(lockPath, "utf-8").catch(() => null);
        const recheck = await fs.stat(lockPath).catch(() => null);
        const stillStale = recheck !== null && Date.now() - recheck.mtimeMs > staleLockMs;
        let reclaimed = false;
        if (stillStale) {
          const recheckToken = await fs.readFile(lockPath, "utf-8").catch(() => null);
          if (recheckToken === staleToken) {
            reclaimed = await fs.unlink(lockPath).then(
              () => true,
              () => false,
            );
          }
        }
        // 只有确认真的删掉了陈旧锁，状态才发生了变化，值得立即重试
        // 创建。**不能无条件 continue**（第十七轮 Codex Review 指出的
        // 真实 bug）：如果 unlink 持续失败（EACCES、只读文件系统等）
        // 或这次没有真的判定为可回收，无条件 continue 会跳过下面的
        // 超时检查和 50ms 退避，整个循环变成忽略 timeoutMs 的忙等待，
        // 占满 CPU 且永不超时。未能回收时落到下面统一的超时检查/退避
        // 分支。
        if (reclaimed) continue;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    if (Date.now() > deadline) throw new Error(`获取经验写入锁超时：${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// upsertExperience 主流程
// ---------------------------------------------------------------------------

export interface UpsertCandidate {
  /** knowledge/experience 根目录（绝对路径） */
  experienceRoot: string;
  title: string;
  stage: ExperienceFrontmatter["stage"];
  taskType: ExperienceFrontmatter["task_type"];
  projectScope: string;
  source: string;
  riskLevel: ExperienceFrontmatter["risk_level"];
  /** 未脱敏的原始正文——脱敏在函数内部执行，调用方不得自行脱敏后传入 */
  body: string;
}

export interface UpsertResult {
  ok: boolean;
  documentId?: string;
  documentVersion?: number;
  occurrenceCount?: number;
  filePath?: string;
  /** 失败原因：blocked / validation_failed / lock_lost */
  reason?: string;
  errors?: string[];
}

function targetPathFor(experienceRoot: string, projectScope: string, documentId: string): string {
  return path.join(experienceRoot, projectScope, `${documentId}.md`);
}

function supersededPathFor(
  experienceRoot: string,
  projectScope: string,
  documentId: string,
  oldVersion: number,
): string {
  return path.join(experienceRoot, projectScope, ".superseded", `${documentId}@v${oldVersion}.md`);
}

/**
 * project_scope 必须是单层安全路径片段——不含路径分隔符、不是 "."/".."，
 * 否则 `path.join(experienceRoot, projectScope)` 能被 "../../etc" 这类
 * 值带出 experienceRoot 之外，在任意位置创建锁/归档/Markdown 文件
 * （Codex Review 指出的真实路径穿越漏洞）。
 */
function isSafeProjectScope(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (/[\\/]/.test(value)) return false;
  if (value.includes("\0")) return false;
  return true;
}

/** 双保险：即使安全片段校验有遗漏，也用解析后的真实路径兜底拒绝越界 */
function assertWithinRoot(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return;
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`project_scope 解析后的路径越界：${resolvedTarget}（必须位于 ${resolvedRoot} 内）`);
  }
}

/**
 * `assertWithinRoot()` 只做词法（lexical）路径比较，不会跟随符号链接——
 * 如果某个路径条目已经存在且是符号链接、指向根目录之外的位置，词法
 * 检查会误判为"在根目录内"，但实际的锁/归档/Markdown 写入会跟随符号
 * 链接真正落到根目录之外（Codex Review 指出的真实漏洞）。这里用
 * `lstat`（不跟随符号链接）显式检查该项：不存在 → 安全，后续 `mkdir`
 * 会创建一个我们自己拥有的真实目录；存在且不是符号链接 → 安全，正常
 * 复用；存在且是符号链接 → 直接拒绝，不做任何后续文件系统操作。
 *
 * **不只检查 `projectDir` 本身**——第十六轮 Codex Review 指出：
 * `projectDir` 下固定名为 `.superseded` 的归档子目录同样是攻击面，
 * 如果它已经被预先替换成指向根目录之外的符号链接，归档写入会跟随
 * 符号链接逃逸，之前的实现只检查了 `projectDir` 这一层。调用方必须在
 * 每个我们即将写入的目录条目（`projectDir` 与 `.superseded` 目录）
 * 上都调用本函数。
 */
async function assertNotSymlink(targetDir: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(targetDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`目录条目已存在且是符号链接，可能指向 experienceRoot 之外，拒绝写入：${targetDir}`);
  }
}

/**
 * `assertNotSymlink()` 只检查了归档**目录**（`.superseded/`）本身不是
 * 符号链接——但归档目标是目录*里*的一个具体文件
 * （`{document_id}@v{N}.md`），目录本身干净不代表这个文件路径也干净：
 * 攻击者可以预先在这个确切路径放一个指向 experienceRoot 之外的符号
 * 链接，`fs.writeFile()` 默认会跟随文件级符号链接写入，绕过了目录层
 * 的检查（Codex Review 指出的真实漏洞，第十六轮只堵了目录这一层）。
 * AC-014 明确要求遇到符号链接时必须拒绝写入，且**符号链接本身不得被
 * 移除或替换**——这条约束排除了直接复用 `atomicWriteExperience()`
 * 的可能：`fs.rename()` 替换目标目录项本身（不跟随符号链接）虽然不会
 * 写穿到符号链接指向的外部文件，但会把符号链接*本身*静默替换成归档
 * 文件，违反"不得移除或替换"这一明确要求，必须先显式 `lstat` 检查、
 * 发现是符号链接就直接拒绝，不做任何后续操作。
 *
 * **同时，归档写入本身必须是原子的（tmp + rename），不能像早期实现
 * 那样用 `O_TRUNC` 原地截断写入**（第二十八轮 Codex Review 指出的
 * 真实 bug）：进程崩溃或 `handle.writeFile()` 失败会让归档文件残留为
 * 空文件或半截内容，可能销毁这个 feature 本该保留的唯一旧版本，违反
 * F-006"崩溃不得留下半截 Markdown"的要求。修复：写入一个用
 * `O_EXCL|O_NOFOLLOW` 排他创建的 tmp 文件（与 `atomic-write.ts` 完全
 * 相同的模式——tmp 路径本身也是符号链接逃逸的攻击面，需要同样的防护，
 * 见其顶部说明），成功后再 `rename` 到归档路径；写入/rename 任一步
 * 失败都清理 tmp 文件，不掩盖原始错误。紧贴在 `rename` 之前再核实一次
 * 目标不是符号链接——第一次检查到这里之间仍有窗口（纯 POSIX 无法把
 * 这个窗口彻底消灭到零，与本文件其余同类检查是一致的理论边界），但
 * 能把窗口从"整个 tmp 写入耗时"压缩到"一次系统调用到下一次系统调用
 * 之间"，与本文件"能用一次系统调用堵住就不留检查-写入两步窗口"的
 * 一贯原则一致。
 */
async function assertArchiveTargetNotSymlink(targetPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`归档目标路径已存在且是符号链接，可能指向 experienceRoot 之外，拒绝写入：${targetPath}`);
  }
}

async function writeArchiveFile(targetPath: string, content: string): Promise<void> {
  await assertArchiveTargetNotSymlink(targetPath);

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const handle = await fs.open(
    tmpPath,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
  );
  try {
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
    await assertArchiveTargetNotSymlink(targetPath);
    await fs.rename(tmpPath, targetPath);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
}


export async function upsertExperience(candidate: UpsertCandidate): Promise<UpsertResult> {
  if (!isSafeProjectScope(candidate.projectScope)) {
    return {
      ok: false,
      reason: "invalid_project_scope",
      errors: [`project_scope 必须是不含路径分隔符/上级引用的单层安全标识，收到：${JSON.stringify(candidate.projectScope)}`],
    };
  }

  // 强制脱敏不能只覆盖正文——title/source/project_scope 同样是
  // candidate 可控的自由文本，绕过脱敏直接写入 frontmatter 会让密钥/
  // 邮箱等敏感信息原样落盘（Codex Review 指出的真实漏洞）。
  const redactedBody = redact(candidate.body);
  const redactedTitle = redact(candidate.title);
  const redactedSource = redact(candidate.source);
  const redactedProjectScope = redact(candidate.projectScope);

  if (
    redactedBody.blocked ||
    redactedTitle.blocked ||
    redactedSource.blocked ||
    redactedProjectScope.blocked
  ) {
    return {
      ok: false,
      reason: "blocked",
      errors: ["脱敏拦截：title/source/project_scope/正文中至少一处命中密钥/原始聊天内容片段类规则，拒绝写入"],
    };
  }

  const title = redactedTitle.text;
  const source = redactedSource.text;
  const projectScope = redactedProjectScope.text;

  const documentId = generateDocumentId({
    projectScope,
    taskType: candidate.taskType,
    stage: candidate.stage,
    title,
  });
  // 必须先归一化正文，再用同一份归一化结果去算哈希、校验、序列化——
  // `serializeExperienceFile()` 最终落盘的是 `body.trim() + "\n"`，如果
  // content_hash 却是对 `redactedBody.text`（未归一化）算出来的，两次
  // 语义完全相同、只是前导/尾随空白不同的提交会序列化出字节完全一致的
  // 文件，却因为归一化前的原始文本不同而算出不同的 content_hash——把
  // 本该走 F-005 去重路径（只 +1 occurrence_count）的重复提交误判成
  // "内容变化"，凭空生成一个新版本（Codex Review 指出的真实 bug）。
  const normalizedBody = redactedBody.text.trim();
  const contentHash = createHash("sha256").update(normalizedBody).digest("hex").slice(0, 16);

  // `experienceRoot` 本身如果已经是符号链接、指向配置的经验树之外，
  // 后续所有检查都会在错误的地方失效（第三十一轮 Codex Review 指出的
  // 真实 bug）：`assertWithinRoot()` 只做词法路径比较，`experienceRoot`
  // 是不是符号链接根本不影响这个纯字符串计算的结果，仍然会判定为
  // "在根目录内"；`assertNotSymlink(projectDir)` 的 `lstat` 只对路径的
  // 最后一段不跟随符号链接，但操作系统解析 `projectDir` 时仍会先跟随
  // `experienceRoot` 这个中间路径段找到它实际指向的外部目录，再在那
  // 个外部目录里对 `projectScope` 这个此刻多半还不存在的新名字做
  // `lstat`（返回 `ENOENT`，不是符号链接），检查因此形同虚设，随后的
  // `mkdir`/锁/归档/Markdown 写入全部会真实发生在 `experienceRoot`
  // 之外。修复：在触碰文件系统之前，先对 `experienceRoot` 本身做一次
  // 相同的符号链接拒绝检查——只检查配置根这一层，不递归检查它之上的
  // 每一级祖先目录：更上层目录若被替换成符号链接，属于"本机其他进程
  // 拥有能修改本应用配置根之外目录的能力"这一更强的攻击面，超出了本
  // 模块"本机进程可以在 experienceRoot 内部写入"这一贯的威胁模型，
  // 与本文件其余"没有外部协调服务/操作系统级隔离就无法从数学上完全
  // 消除"的已记录理论边界是同一类问题。
  await assertNotSymlink(candidate.experienceRoot);

  const projectDir = path.join(candidate.experienceRoot, projectScope);
  assertWithinRoot(candidate.experienceRoot, projectDir);
  await assertNotSymlink(projectDir);
  await fs.mkdir(projectDir, { recursive: true }); // 锁文件与目标文件同目录，必须先存在

  const targetPath = targetPathFor(candidate.experienceRoot, projectScope, documentId);
  const lockPath = lockPathFor(documentId, projectDir);
  const lock = await acquireLock(lockPath);

  try {
    const now = new Date().toISOString();
    // `readActiveFileNoFollow` 在 open 阶段就用 O_NOFOLLOW 拒绝跟随
    // 符号链接——`{document_id}.md` 这个规范路径本身也是符号链接逃逸
    // 的攻击面，不能直接 fs.readFile()（Codex Review 指出的真实漏洞，
    // 详见 read-content-hash.ts 顶部说明）。
    let existing: ExperienceFrontmatter | null = null;
    const existingRaw = await readActiveFileNoFollow(targetPath);
    if (existingRaw !== null) {
      existing = coerceFrontmatter(parseExperienceFile(existingRaw).frontmatter);
    }
    // 本次计算的所有更新决策（去重/版本递增）都基于这个基线快照——
    // 落盘前必须确认磁盘上的实际状态没有变化，见下方"内容级围栏检查"。
    // **必须同时记录 occurrence_count，不能只记录 content_hash**（第
    // 十九轮 Codex Review 指出：去重路径下两次并发的相同内容提交都不
    // 改变 content_hash，只靠 content_hash 比对会对这种并发写入完全
    // 失明，见 read-content-hash.ts 顶部说明）。
    const baselineFence: FenceState | null = existing
      ? { contentHash: existing.content_hash, occurrenceCount: existing.occurrence_count }
      : null;

    let frontmatter: ExperienceFrontmatter;
    let archiveOldVersion: number | null = null;

    if (!existing) {
      frontmatter = {
        document_id: documentId,
        document_version: 1,
        title,
        domain: "workflow-experience",
        stage: candidate.stage,
        task_type: candidate.taskType,
        project_scope: projectScope,
        source,
        created_at: now,
        updated_at: now,
        risk_level: candidate.riskLevel,
        status: "candidate",
        occurrence_count: 1,
        content_hash: contentHash,
      };
    } else if (existing.content_hash === contentHash) {
      frontmatter = { ...existing, occurrence_count: existing.occurrence_count + 1, updated_at: now };
    } else {
      const oldVersion = existing.document_version;
      archiveOldVersion = oldVersion;
      frontmatter = {
        ...existing,
        document_version: oldVersion + 1,
        // 内容实质变化必须重置为 candidate，不能沿用旧版本的
        // verified/deprecated 状态（Codex Review 指出的真实 bug）：
        // status 表达的是"这份具体内容有没有经过审核"，spread
        // `existing` 会把上一版的审核结论原样带到新内容上——旧版本被
        // 验证过不代表新内容也经过了同样的审核（绕过 candidate→
        // verified 必须走 canVerify() 的生命周期约束），旧版本被标记
        // deprecated 也不该让全新的内容永久带着这个标记、再也无法被
        // 正常验证。新版本必须重新从 candidate 起步，独立走一遍生命
        // 周期。
        status: "candidate",
        occurrence_count: 1,
        updated_at: now,
        content_hash: contentHash,
        supersedes: `${documentId}@v${oldVersion}`,
      };
    }

    const validation = validateExperience(frontmatter, normalizedBody);
    if (!validation.ok) {
      return { ok: false, reason: "validation_failed", errors: validation.errors };
    }

    await lock.assertStillHeld();

    // 内容级乐观并发围栏——独立于锁 token 比对的第二道防线：不管锁本身
    // 经历了怎样的竞态（陈旧回收误判、心跳错过节拍等，见 acquireLock()
    // 顶部的说明），只要目标文件此刻的围栏状态（content_hash **加上**
    // occurrence_count——第十九轮 Codex Review 指出：只比 content_hash
    // 会漏掉"两次并发的相同内容提交，只有 occurrence_count 各自独立
    // +1"这种不改变 content_hash 的并发写入，见 read-content-hash.ts
    // 顶部说明）已经不是本次计算更新所依据的基线，就说明期间已经有人
    // 成功提交了别的更新——必须中止，不能盲目覆盖。**必须在归档写入
    // 之前做这次检查**（Codex
    // Review 第十五轮指出的真实 bug：上一版把这次检查放在归档之后，
    // 若冲突恰好在归档时才被发现，函数已经在 `.superseded/` 下留了一份
    // 文件才返回 conflict，违反"冲突时不写入任何文件"的承诺，还可能把
    // 竞争对手的内容错误归档到我们计算出的旧版本号下）。
    const earlyCurrentFence = await readCurrentFenceState(targetPath);
    if (!fenceStatesEqual(earlyCurrentFence, baselineFence)) {
      return {
        ok: false,
        reason: "conflict",
        errors: [
          `目标文件在写入前已被其他进程修改（基线 content_hash=${baselineFence?.contentHash ?? "不存在"} ` +
            `occurrence_count=${baselineFence?.occurrenceCount ?? "不存在"}，当前 content_hash=` +
            `${earlyCurrentFence?.contentHash ?? "不存在"} occurrence_count=` +
            `${earlyCurrentFence?.occurrenceCount ?? "不存在"}），本次写入已中止以避免覆盖，可重试`,
        ],
      };
    }

    if (archiveOldVersion !== null) {
      const supersededPath = supersededPathFor(
        candidate.experienceRoot,
        projectScope,
        documentId,
        archiveOldVersion,
      );
      const supersededDir = path.dirname(supersededPath);
      // `.superseded` 是固定名称的子目录，同样是符号链接逃逸的攻击面——
      // 如果它已经被预先替换成指向 experienceRoot 之外的符号链接，
      // 归档写入会跟随符号链接逃逸（Codex Review 第十六轮指出：之前只
      // 检查了 projectDir 本身，没检查这一层）。
      await assertNotSymlink(supersededDir);
      await fs.mkdir(supersededDir, { recursive: true });
      // 归档源同样必须用 O_NOFOLLOW 读取——targetPath 从上面初次读取
      // 到这里之间理论上仍可能被替换成符号链接，不能假设只在函数入口
      // 检查一次就够（与本文件其余"能用一次系统调用堵住就不留检查-
      // 写入两步窗口"的原则一致，见 readActiveFileNoFollow 顶部说明）。
      const oldRaw = await readActiveFileNoFollow(targetPath);
      if (oldRaw === null) {
        throw new Error(`归档源文件意外消失：${targetPath}（写入流程内部状态不一致，需要人工排查）`);
      }
      // 归档前必须核实刚读到的这份内容确实是 archiveOldVersion 所依据
      // 的那个基线版本，不能假设"早期围栏检查通过"到"这里真正读到内容"
      // 之间磁盘状态没有变化（第二十六轮 Codex Review 指出的真实 bug）：
      // 如果另一个写入者恰好在这段窗口内完成了自己完整的一轮更新
      // （读到旧内容→写入新内容→rename），这里读到的 oldRaw 已经是
      // 对方刚写入的新内容，若不加校验直接写进按本进程自己（此刻已
      // 陈旧）的 archiveOldVersion 算出的归档路径，就会把错误版本的
      // 内容永久写进历史归档——即使下面的第二次围栏检查随后发现冲突
      // 并中止整个写入，归档文件已经被污染，无法撤销。用刚读到的
      // oldRaw 自己算一次围栏状态（不需要额外一次磁盘读取），与开始时
      // 记录的 baselineFence 比对，不一致就必须在写入归档文件之前中止。
      const oldRawFence: FenceState = (() => {
        const fm = coerceFrontmatter(parseExperienceFile(oldRaw).frontmatter);
        return { contentHash: fm.content_hash, occurrenceCount: fm.occurrence_count };
      })();
      if (!fenceStatesEqual(oldRawFence, baselineFence)) {
        return {
          ok: false,
          reason: "conflict",
          errors: [
            `归档前核实发现目标文件已被其他进程修改（基线 content_hash=${baselineFence?.contentHash ?? "不存在"} ` +
              `occurrence_count=${baselineFence?.occurrenceCount ?? "不存在"}，当前 content_hash=` +
              `${oldRawFence.contentHash} occurrence_count=${oldRawFence.occurrenceCount}），` +
              `本次写入已中止以避免用错误版本的内容污染历史归档，可重试`,
          ],
        };
      }
      // 目录本身不是符号链接不代表这个具体归档文件路径也干净——第十七轮
      // Codex Review 指出：攻击者可以预先在 {document_id}@v{N}.md 这个
      // 确切路径放一个文件级符号链接，`fs.writeFile()` 默认会跟随写入
      // 目标之外的位置，绕开了上面对目录的检查。writeArchiveFile() 用
      // O_NOFOLLOW 在 open 阶段本身拒绝跟随符号链接。
      await writeArchiveFile(supersededPath, oldRaw); // 先复制归档，再覆盖——顺序不能反
    }

    const fileContent = serializeExperienceFile(frontmatter, normalizedBody);

    // 归档这一步本身有真实 I/O 耗时，上面那次围栏检查到这里之间仍存在
    // 窗口——如果所有权恰好在这段时间内丢失（心跳错过节拍/被判陈旧
    // 抢占）且抢占者已经提交了新内容，这里必须能重新发现（Codex Review
    // 第十二轮指出的真实 bug：保证"最终只有一个进程完成写入"必须紧贴在
    // 真正的 rename 之前再校验一次，不能只在归档之前校验一次就假定
    // 归档期间不会丢失所有权）。
    await lock.assertStillHeld();
    const lateCurrentFence = await readCurrentFenceState(targetPath);
    if (!fenceStatesEqual(lateCurrentFence, baselineFence)) {
      return {
        ok: false,
        reason: "conflict",
        errors: [
          `目标文件在归档期间被其他进程修改（基线 content_hash=${baselineFence?.contentHash ?? "不存在"} ` +
            `occurrence_count=${baselineFence?.occurrenceCount ?? "不存在"}，当前 content_hash=` +
            `${lateCurrentFence?.contentHash ?? "不存在"} occurrence_count=` +
            `${lateCurrentFence?.occurrenceCount ?? "不存在"}），本次写入已中止以避免覆盖，可重试`,
        ],
      };
    }

    // 紧贴在 atomicWriteExperience() 之前再校验一次所有权（第二十三轮
    // Codex Review 指出的真实 bug）：上面那次 assertStillHeld() 与这里
    // 的 rename 之间仍隔着一次围栏检查的真实 I/O——如果所有权恰好在这
    // 段窗口内丢失（本进程停顿过久未发出心跳，另一进程判定陈旧并回收、
    // 抢占者也走到了它自己的 rename），双方会各自对着自己刚写入的内容
    // 验证成功、都报告 `ok: true`，其中一次的更新被静默覆盖丢失——写入
    // 后读回校验只能发现"自己写完之后又被别人覆盖"，无法发现"自己的
    // rename 覆盖了别人已经报告成功的写入"这种镜像情形，"最终只有一个
    // 进程完成写入"这条保证因此被打破。把这次校验挪到紧邻 rename 之前，
    // 让"最后一次所有权校验"和"真正落盘"之间不再夹着任何额外的 I/O，
    // 把窗口从"一次围栏检查的 I/O 耗时"压缩到"一次 Promise resolve 到
    // 下一次 await 之间"这个量级。纯 POSIX 文件 API 无法把这个窗口彻底
    // 消灭到零（与模块顶部锁获取阶段、写入后读回校验说明的是同一类
    // "没有外部协调服务就无法从数学上完全消除"的理论边界），但这是
    // 目前能做到的最强保证。
    await lock.assertStillHeld();

    await atomicWriteExperience(targetPath, fileContent);

    // 写入后立即读回校验——纯 POSIX 文件 API 无法让"围栏检查→rename"
    // 这两步本身做到完全无竞态的原子操作（Codex Review 第十五轮指出：
    // 理论上仍存在"另一个进程恰好在围栏检查通过之后、我们的 rename
    // 完成之前也完成了自己的 rename"这个极窄窗口，与本模块顶部说明的
    // 锁获取阶段理论边界是同一类问题，没有外部协调服务无法从数学上
    // 完全消除）。这里作为最后一道检测手段：读回刚写入的文件，确认
    // document_version/occurrence_count/content_hash 确实是我们刚才
    // 写入的那份——不一致说明有人紧跟着我们的 rename 之后又完成了一次
    // 覆盖，我们的更新已经不是磁盘上的最终状态，此时必须如实报告
    // conflict 而不是谎称 ok:true，避免调用方误以为自己的更新已经安全
    // 生效（这不能撤销已经发生的写入，但确保不会有调用方在更新被覆盖后
    // 仍然收到成功假象——真正生效的那一方会在自己的读回校验里看到自己
    // 的内容，从而正确报告成功）。**必须用 readActiveFileNoFollow()，
    // 不能用 fs.readFile()**（第二十九轮 Codex Review 指出的真实
    // bug）：本文件其余每一处读取活跃文件路径的地方（步骤 4 的初次
    // 读取、归档源读取、readCurrentFenceState 内部）都已经统一改用
    // 这个不跟随符号链接的安全读取，唯独这里的最终读回校验遗漏了——
    // 如果另一个本机进程恰好在 atomicWriteExperience() rename 完成
    // 之后，把规范路径替换成指向一份"版本/计数/哈希都精心构造成匹配"
    // 的外部文件的符号链接，`fs.readFile()` 会跟随写入并读到这份
    // 伪造内容，让本次写入被误判为"确实生效"而返回 `ok: true`——
    // 但真正落盘的是我们自己 rename 过去的内容，规范路径此刻实际上
    // 已经被替换成了符号链接，调用方却收到虚假的成功结果，还读到了
    // experienceRoot 之外的数据。之前的实现用 `.catch(() => null)`
    // 把所有错误（含符号链接导致的 `ELOOP`）都吞成"未生效"，反而
    // 掩盖了这个本该报警的异常情形——`readActiveFileNoFollow()` 只
    // 把"文件不存在"这一个确定状态映射为 `null`，符号链接会像别处
    // 一样直接抛出描述性错误，不静默吞掉。
    const verifyRaw = await readActiveFileNoFollow(targetPath);
    const verifyFm = verifyRaw ? coerceFrontmatter(parseExperienceFile(verifyRaw).frontmatter) : null;
    const writeSurvived =
      verifyFm !== null &&
      verifyFm.document_version === frontmatter.document_version &&
      verifyFm.occurrence_count === frontmatter.occurrence_count &&
      verifyFm.content_hash === frontmatter.content_hash;
    if (!writeSurvived) {
      return {
        ok: false,
        reason: "conflict",
        errors: ["写入后读回校验发现内容已被其他进程覆盖，本次更新未能生效，可重试"],
      };
    }

    return {
      ok: true,
      documentId,
      documentVersion: frontmatter.document_version,
      occurrenceCount: frontmatter.occurrence_count,
      filePath: targetPath,
    };
  } catch (e) {
    if (e instanceof LockLostError) {
      return { ok: false, reason: "lock_lost", errors: [e.message] };
    }
    throw e;
  } finally {
    await lock.release();
  }
}
