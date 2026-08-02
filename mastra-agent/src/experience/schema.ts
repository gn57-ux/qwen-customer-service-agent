/**
 * 工作流经验 Markdown 的 frontmatter schema、正文分节解析与校验。
 *
 * 独立于 rag/markdown.ts 实现（不复用其内部解析函数——那个函数未导出，
 * 且客服知识库的 frontmatter 字段集合与本模块不同，独立实现避免任何一边
 * 修复 bug 时意外影响另一边）。
 */

import { createHash } from "node:crypto";

export interface ExperienceFrontmatter {
  document_id: string;
  document_version: number;
  title: string;
  domain: "workflow-experience";
  stage: "execute" | "review" | "qa" | "finish";
  task_type: "frontend" | "backend" | "rag" | "model" | "data" | "git" | "docs" | "workflow";
  project_scope: string;
  source: string;
  created_at: string;
  updated_at: string;
  risk_level: "low" | "medium" | "high";
  status: "candidate" | "verified" | "deprecated";
  occurrence_count: number;
  content_hash: string;
  /** 被取代的具体版本，格式 "{document_id}@v{N}"——不能是裸 document_id */
  supersedes?: string;
}

export const REQUIRED_SECTIONS = [
  "触发场景",
  "问题表现",
  "错误做法",
  "根因",
  "正确处理",
  "验证方法",
  "适用范围",
  "不适用范围",
  "可提升为稳定规则的条件",
] as const;

export type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

const STAGES = ["execute", "review", "qa", "finish"] as const;
const TASK_TYPES = [
  "frontend",
  "backend",
  "rag",
  "model",
  "data",
  "git",
  "docs",
  "workflow",
] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const STATUSES = ["candidate", "verified", "deprecated"] as const;

export interface DocumentIdInput {
  projectScope: string;
  taskType: string;
  stage: string;
  title: string;
}

/**
 * 稳定、不含时间戳的场景哈希——同一场景（project_scope+task_type+stage+
 * 归一化标题）重复提交必须算出相同 ID，这是 occurrence_count 累加机制
 * 的前提（见 design.md 技术决策：内容哈希会让措辞不同的同一场景被判成
 * 不同经验，场景哈希不会）。
 */
export function generateDocumentId(input: DocumentIdInput): string {
  const normalizedTitle = input.title.trim().toLowerCase().replace(/\s+/g, " ");
  const seed = `${input.projectScope}|${input.taskType}|${input.stage}|${normalizedTitle}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * 按 9 个固定二级标题切分正文。缺失的节在返回的 Map 里直接不存在该
 * key（不是空字符串）——区分"节存在但为空"与"节缺失"，供 validate 与
 * Feature 2 检索侧文档级组装共用（不在 validateExperience 内部私有
 * 实现，见 design.md 第十一轮 Codex Review 修正记录）。
 */
export function parseExperienceSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) sections.set(current, buffer.join("\n").trim());
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = match[1]!;
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * F-002 要求正文结构是 `# 标题` 在前、9 个二级标题在后——只检查第一条
 * 非空行是否为合法的一级标题（`#` 后至少一个空白再跟非空白标题文字），
 * 不要求标题文字是字面的"标题"二字，测试夹具里的 "# 标题" 只是示例
 * 标题文本。`\s+` 紧跟在唯一的 `#` 之后天然排除了 "##" 这类更深层
 * 标题——第二次出现的 "#" 会让 `\s+` 匹配失败，不需要额外判断层级。
 */
function hasTopLevelTitle(body: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return /^#\s+\S/.test(trimmed);
  }
  return false;
}

/** 检查 14 个必需字段类型/枚举合法性 + 9 个必需二级标题是否存在，不抛异常 */
export function validateExperience(
  frontmatter: ExperienceFrontmatter,
  body: string,
): ValidationResult {
  const errors: string[] = [];
  const fm = frontmatter as Partial<ExperienceFrontmatter>;

  if (typeof fm.document_id !== "string" || !fm.document_id) errors.push("document_id 缺失或类型错误");
  if (typeof fm.document_version !== "number" || !Number.isInteger(fm.document_version) || fm.document_version < 1) {
    errors.push("document_version 缺失或类型错误（必须是 >=1 的整数）");
  }
  if (typeof fm.title !== "string" || !fm.title.trim()) errors.push("title 缺失或类型错误");
  if (fm.domain !== "workflow-experience") errors.push('domain 必须固定为 "workflow-experience"');
  if (!STAGES.includes(fm.stage as (typeof STAGES)[number])) {
    errors.push(`stage 必须是以下之一：${STAGES.join("/")}`);
  }
  if (!TASK_TYPES.includes(fm.task_type as (typeof TASK_TYPES)[number])) {
    errors.push(`task_type 必须是以下之一：${TASK_TYPES.join("/")}`);
  }
  if (typeof fm.project_scope !== "string" || !fm.project_scope.trim()) errors.push("project_scope 缺失或类型错误");
  if (typeof fm.source !== "string" || !fm.source.trim()) errors.push("source 缺失或类型错误");
  if (typeof fm.created_at !== "string" || Number.isNaN(Date.parse(fm.created_at))) {
    errors.push("created_at 缺失或不是合法 ISO 8601 时间");
  }
  if (typeof fm.updated_at !== "string" || Number.isNaN(Date.parse(fm.updated_at))) {
    errors.push("updated_at 缺失或不是合法 ISO 8601 时间");
  }
  if (!RISK_LEVELS.includes(fm.risk_level as (typeof RISK_LEVELS)[number])) {
    errors.push(`risk_level 必须是以下之一：${RISK_LEVELS.join("/")}`);
  }
  if (!STATUSES.includes(fm.status as (typeof STATUSES)[number])) {
    errors.push(`status 必须是以下之一：${STATUSES.join("/")}`);
  }
  if (
    typeof fm.occurrence_count !== "number" ||
    !Number.isInteger(fm.occurrence_count) ||
    fm.occurrence_count < 1
  ) {
    errors.push("occurrence_count 缺失或类型错误（必须是 >=1 的整数）");
  }
  if (typeof fm.content_hash !== "string" || !fm.content_hash) errors.push("content_hash 缺失或类型错误");
  if (fm.supersedes !== undefined) {
    if (typeof fm.supersedes !== "string" || !/^.+@v\d+$/.test(fm.supersedes)) {
      errors.push('supersedes 格式必须是 "{document_id}@v{N}"，不能是裸 document_id');
    }
  }

  // F-002 明确要求正文结构是 `# 标题` 在前、9 个二级标题在后——旧实现
  // 只检查了二级标题是否齐全，完全没有校验一级标题本身是否存在
  // （Codex Review 指出的真实 bug）：没有一级标题、或一级标题前有任意
  // 无关文字的正文都会通过校验并被持久化，违反了文档化的 schema。
  if (!hasTopLevelTitle(body)) {
    errors.push("正文缺少必需的一级标题（# 标题），且必须出现在所有二级标题之前");
  }

  const sections = parseExperienceSections(body);
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) errors.push(`正文缺少必需二级标题：## ${name}`);
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 YAML 标量解析（同 rag/markdown.ts 的解析思路，独立实现不共享） */
export function parseExperienceFile(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) throw new Error("经验文件缺少 frontmatter 块（必须以 --- 开头）");
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = unescapeDoubleQuoted(value.slice(1, -1));
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'"); // YAML 单引号转义：'' → '
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

/** 双引号 YAML 标量的反转义，与 escapeDoubleQuoted() 的编码规则一一对应 */
function unescapeDoubleQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      const mapped = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" }[next as string];
      if (mapped !== undefined) {
        out += mapped;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\") // 反斜杠必须最先转义，否则会重复转义后续插入的反斜杠
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * 是否需要加引号——candidate 可控的 title/source 等字段可能含冒号、井号、
 * 前导特殊字符或换行，原样拼接会产出对标准 YAML 消费者无效或被误解析的
 * frontmatter（Codex Review 指出的真实 bug）。宁可多引号也不要漏引。
 */
function needsYamlQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/[:#]/.test(value)) return true;
  if (/[\r\n]/.test(value)) return true;
  if (/^[-?:,[\]{}&*!|>'"%@`]/.test(value)) return true;
  if (/^(true|false|null|~|yes|no)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

function serializeYamlScalar(value: string): string {
  return needsYamlQuoting(value) ? `"${escapeDoubleQuoted(value)}"` : value;
}

export function coerceFrontmatter(raw: Record<string, string>): ExperienceFrontmatter {
  return {
    document_id: raw.document_id ?? "",
    document_version: Number(raw.document_version ?? "0"),
    title: raw.title ?? "",
    domain: "workflow-experience",
    stage: raw.stage as ExperienceFrontmatter["stage"],
    task_type: raw.task_type as ExperienceFrontmatter["task_type"],
    project_scope: raw.project_scope ?? "",
    source: raw.source ?? "",
    created_at: raw.created_at ?? "",
    updated_at: raw.updated_at ?? "",
    risk_level: raw.risk_level as ExperienceFrontmatter["risk_level"],
    status: raw.status as ExperienceFrontmatter["status"],
    occurrence_count: Number(raw.occurrence_count ?? "0"),
    content_hash: raw.content_hash ?? "",
    supersedes: raw.supersedes || undefined,
  };
}

/** frontmatter 字段固定输出顺序，保证同一内容每次序列化字节一致（便于 diff/审计） */
const FRONTMATTER_FIELD_ORDER: (keyof ExperienceFrontmatter)[] = [
  "document_id",
  "document_version",
  "title",
  "domain",
  "stage",
  "task_type",
  "project_scope",
  "source",
  "created_at",
  "updated_at",
  "risk_level",
  "status",
  "occurrence_count",
  "content_hash",
  "supersedes",
];

export function serializeExperienceFile(frontmatter: ExperienceFrontmatter, body: string): string {
  const lines = ["---"];
  for (const key of FRONTMATTER_FIELD_ORDER) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    const serialized = typeof value === "number" ? String(value) : serializeYamlScalar(String(value));
    lines.push(`${key}: ${serialized}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${body.trim()}\n`;
}
