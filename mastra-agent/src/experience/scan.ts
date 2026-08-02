/**
 * 递归扫描 `experienceRoot` 下的全部经验 Markdown 文件——供
 * `experience:status`（按 status 统计）与 `experience:audit`
 * （frontmatter 校验/脱敏扫描/孤儿文件检测）共用，避免两条命令各自
 * 实现一遍目录遍历逻辑。跳过 `.superseded/` 归档目录——统计与巡检
 * 针对的是当前活跃文档，不包含历史版本副本。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { coerceFrontmatter, parseExperienceFile, type ExperienceFrontmatter } from "./schema.ts";

export interface ScannedExperienceFile {
  /** 绝对路径 */
  path: string;
  /** 相对 experienceRoot 的路径，不含绝对用户目录 */
  relativePath: string;
  raw: string;
  frontmatter: ExperienceFrontmatter | null;
  body: string;
  /** frontmatter 块本身解析失败（不是必需字段校验失败，是连 `---` 块都没有） */
  parseError?: string;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".superseded") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, root, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(fullPath);
    }
  }
}

export async function scanExperienceFiles(experienceRoot: string): Promise<ScannedExperienceFile[]> {
  const paths: string[] = [];
  await walk(experienceRoot, experienceRoot, paths);

  const results: ScannedExperienceFile[] = [];
  for (const filePath of paths) {
    const raw = await fs.readFile(filePath, "utf-8");
    const relativePath = path.relative(experienceRoot, filePath);
    try {
      const { frontmatter, body } = parseExperienceFile(raw);
      results.push({ path: filePath, relativePath, raw, frontmatter: coerceFrontmatter(frontmatter), body });
    } catch (e) {
      results.push({
        path: filePath,
        relativePath,
        raw,
        frontmatter: null,
        body: "",
        parseError: (e as Error).message,
      });
    }
  }
  return results;
}
