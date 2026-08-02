/**
 * 独立成单文件的原因与 atomic-write.ts 相同：write.test.ts 需要用
 * node:test 的 mock.module() 模拟"落盘前一刻，目标文件的状态已经不是
 * 本次更新所依据的基线"这一具体场景（内容级围栏检查失败的场景），而
 * mock.module() 只能拦截跨文件 import。
 *
 * 围栏比对的是 `{ contentHash, occurrenceCount }` 这一对字段，**不能只
 * 比对 content_hash**（第十九轮 Codex Review 指出的真实 bug）：两个
 * 并发的"完全相同内容"提交（去重路径，见 write.ts 的
 * `existing.content_hash === contentHash` 分支）都不会改变
 * content_hash，只会各自独立地把 `occurrence_count` 从同一个基线值
 * +1——如果锁机制的残余竞态窗口（见 acquireLock() 顶部说明）恰好让两者
 * 都通过了获取锁阶段，仅比对 content_hash 的围栏检查对这种"内容相同、
 * 只有计数字段变化"的并发写入完全失明：两者的围栏检查都会看到
 * content_hash 未变而误判"没有冲突"，其中一次的 occurrence_count 增量
 * 会被另一次无声覆盖丢失，而两者都会报告 ok:true。加入
 * `occurrenceCount` 后，任何一次真正成功的写入（无论是否改变内容）都会
 * 让基线状态失配，围栏检查才能捕捉到全部会触发 frontmatter 变化的并发
 * 写入路径，不只是"内容变化"这一种。
 */

import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";

import { coerceFrontmatter, parseExperienceFile } from "./schema.ts";

export interface FenceState {
  contentHash: string;
  occurrenceCount: number;
}

/**
 * 经验文件的规范路径 `{document_id}.md` 本身也是符号链接逃逸的攻击面
 * ——如果它已经被预先替换成指向 experienceRoot 之外的符号链接，
 * `fs.readFile()` 默认会跟随写入并读到外部文件的内容，write.ts 会把
 * 这份内容当作"已存在的旧版本"归档进 `.superseded/`（Codex Review
 * 指出的真实漏洞：此前只保护了 project 目录、`.superseded` 目录、
 * `.superseded` 归档文件本身与原子写入 tmp 路径这几层，唯独遗漏了
 * 活跃文件路径本身，而它偏偏是每次更新都会先读一次的入口）。用
 * `O_NOFOLLOW` 在 open 阶段本身拒绝跟随符号链接，不用"先 lstat 检查、
 * 再 readFile"——后者在检查和读取之间仍有 TOCTOU 窗口，与本项目其余
 * 读写路径（tmp 路径、归档文件）的一贯做法一致。返回 `null` 表示路径
 * 不存在（正常的"首次创建"场景）；路径存在且是符号链接则直接抛错，
 * 不静默跳过。
 */
export async function readActiveFileNoFollow(targetPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(targetPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(
        `经验文件路径已存在且是符号链接，可能指向 experienceRoot 之外，拒绝读取：${targetPath}`,
      );
    }
    throw e;
  }
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/** 读取目标文件当前的围栏状态（content_hash + occurrence_count）；文件不存在返回 null */
export async function readCurrentFenceState(targetPath: string): Promise<FenceState | null> {
  const raw = await readActiveFileNoFollow(targetPath);
  if (raw === null) return null;
  const fm = coerceFrontmatter(parseExperienceFile(raw).frontmatter);
  return { contentHash: fm.content_hash, occurrenceCount: fm.occurrence_count };
}

/** 两次围栏状态是否等价（null 视为"文件不存在"这一确定状态，与非 null 不等价） */
export function fenceStatesEqual(a: FenceState | null, b: FenceState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.contentHash === b.contentHash && a.occurrenceCount === b.occurrenceCount;
}
