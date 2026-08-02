/**
 * 独立成单文件是为了可测试性：write.test.ts 需要用 node:test 的
 * mock.module() 模拟"归档已完成、原子写入尚未完成时进程崩溃"这一具体
 * 时间点（AC-006），而 mock.module() 只能拦截跨文件 import，无法拦截
 * 同一文件内的函数调用。
 */

import { randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";

/**
 * tmp 路径必须用 `O_CREAT|O_EXCL|O_NOFOLLOW` 排他创建，不能用
 * `fs.writeFile()`（Codex Review 指出的真实漏洞）——`.tmp-{pid}-
 * {timestamp}` 这个路径在真正创建之前是可预测的，如果 experience
 * 目录对本机其他进程可写，攻击者可以预先在这个确切路径放一个指向
 * `experienceRoot` 之外的符号链接；`fs.writeFile()` 默认会跟随符号
 * 链接写入并截断链接指向的外部文件，绕开了 write.ts 里已经为
 * project/archive 路径加上的符号链接防护——tmp 路径是同一类攻击面，
 * 只是之前遗漏了。`O_NOFOLLOW` 让 open 阶段本身在目标是符号链接时以
 * `ELOOP` 失败；`O_EXCL` 确保这个路径此刻确实不存在任何东西（不管是
 * 符号链接还是普通文件），排除"目标已存在的普通文件被截断复用"这另一
 * 种意外覆盖。文件名额外加一段 `randomUUID()`（不只是 pid+时间戳）
 * 降低被提前猜中并预放符号链接的概率，属于纵深防御的第二层，不是唯一
 * 防线——真正的安全边界是 `O_NOFOLLOW`/`O_EXCL` 这两个标志本身。
 *
 * `fs.rename(tmpPath, targetPath)` 不需要同样的防护：POSIX `rename()`
 * 语义是替换目标路径的目录项本身（若目标已是符号链接，链接本身被
 * 替换掉），不会跟随目标符号链接写穿到它指向的位置，这与 `open`/
 * `writeFile` 跟随符号链接的行为不同。
 */
export async function atomicWriteExperience(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const handle = await fs.open(
    tmpPath,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW,
  );
  // 一旦 tmp 文件被成功创建，写入/rename 任一步失败都必须清理它，否则
  // 磁盘耗尽、权限问题等瞬时故障会在每次失败重试后留下一份包含完整
  // 经验内容的孤儿 .tmp- 文件（Codex Review 指出的真实问题——这些路径
  // 文档里一直被当作"transient"，实际上从未被回收）。unlink 失败本身
  // 静默吞掉（.catch），不能让清理动作掩盖真正需要抛给调用方的原始
  // 错误。
  try {
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, targetPath); // 同文件系统内 rename 是原子操作
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
}
