/**
 * 写入经验前的强制脱敏——白名单式拦截，宁可误拦不可漏放（见需求 NFR）。
 * 8 类规则，其中 Token/Key/Cookie 与原始聊天内容片段两类命中即
 * `blocked: true`（没有"脱敏后仍安全"的中间态，直接拒绝写入），其余
 * 类别替换为占位符后仍允许写入。
 */

import os from "node:os";

export interface RedactResult {
  text: string;
  redactedCount: number;
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// 1. 绝对用户目录
// ---------------------------------------------------------------------------
const ABS_PATH_RE = /\/Users\/[^/\s]+/g;

// ---------------------------------------------------------------------------
// 2. Token/Key/Cookie（blocked）
// ---------------------------------------------------------------------------
const TOKEN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  // 通用高熵启发式：32~80 位、同时包含大写/小写/数字的 alnum 串
  // （API Key/JWT 分段的典型形态；纯小写 hex 哈希不会命中，避免把
  // content_hash 这类正常字段误判）。
  /\b(?=[A-Za-z0-9_-]{32,80}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,80}\b/g,
  // Cookie 请求/响应头——普通 Cookie（如 "Cookie: session_id=abc123"）
  // 值往往是短小写字母数字串，不满足上面的高熵启发式，之前会漏放
  // （Codex Review 指出的真实漏洞：F-004/AC-005 明确要求 Token/Key/
  // Cookie 三类都必须 blocked，Cookie 不能只靠"碰巧高熵"才被拦住）。
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
  // 不带 "Cookie:" 前缀、但值本身是已知会话 cookie 名称的赋值形式
  // （日志片段/代码示例里常见，如 "PHPSESSID=..." "connect.sid=..."）。
  /\b(?:session_?id|sessionid|phpsessid|jsessionid|connect\.sid|auth[_-]?token|csrf[_-]?token|xsrf[_-]?token)\s*=\s*[^\s;,"'&]+/gi,
  // 带标注名称的密钥/密码赋值——不依赖值本身的熵（第十六轮 Cookie 修复
  // 是同一类问题：高熵启发式只能拦住"看起来随机"的长字符串，拦不住
  // "API_KEY=abc123"/"client_secret=secret" 这种值本身很短、很像普通
  // 单词的场景；但字段名已经明确标注"这是一个凭据"，命中即应整段
  // blocked，不管值长什么样——Codex Review 指出的真实漏洞：F-004/AC-005
  // 明确要求 Token/Key 类不能靠"碰巧高熵"才被拦住，与 Cookie 那次是
  // 同一条要求下的不同具体表现）。标签后允许一个可选的收尾引号
  // （`"?`，兼容 `{"api_key": "..."}` 这种 JSON 写法里字段名本身也带
  // 引号的情况）；值支持双引号/单引号/裸字符串三种写法（JSON/YAML/.env
  // 三种常见格式）；只收录明确是凭据语义的复合标签（api_key/
  // client_secret/password 等），不收录裸 "key"/"secret"/"token" 这类
  // 会在正常技术散文里大量出现、容易产生误伤的通用词。
  /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?key|access[_-]?token|private[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key|password|passwd|pwd)"?\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s;,&]+)/gi,
];

// ---------------------------------------------------------------------------
// 3. 邮箱
// ---------------------------------------------------------------------------
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// ---------------------------------------------------------------------------
// 4. 内网/私有 IP（127.0.0.1/localhost 不拦截）
// ---------------------------------------------------------------------------
const INTERNAL_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

// ---------------------------------------------------------------------------
// 6. Git 远程地址里的账号/组织信息
// ---------------------------------------------------------------------------
const GIT_HOST = "(?:github\\.com|gitlab\\.com|bitbucket\\.org|git\\.[\\w.-]+|code\\.[\\w.-]+)";
const GIT_REMOTE_RE = new RegExp(
  `((?:git@${GIT_HOST}:|https?://${GIT_HOST}/))([\\w.-]+)/([\\w.-]+?)(\\.git)?(?=[\\s)\\]"'\`]|$)`,
  "g",
);

// 社交/协作平台 handle——已知会误伤 Python 装饰器/npm scope 包名，
// 允许误伤（宁可误拦），audit 报告需单独标注人工确认（Feature 3 职责）。
// 负向后顾排除 "git@host" 这类 SSH 语法里的 "@"（前一个字符是单词字符）。
const HANDLE_RE = /(?<!\w)@([A-Za-z0-9_-]{2,39})\b/g;

// ---------------------------------------------------------------------------
// 7. 远程主机（非本机服务地址）
// ---------------------------------------------------------------------------
const HOST_WHITELIST = new Set([
  "localhost",
  "127.0.0.1",
  "fonts.googleapis.com",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "registry.npmjs.org",
  "www.npmjs.com",
]);

// 常见源码/文档文件扩展名——两段式 "word.ext" 命中这些后缀时判定为
// 文件名而非主机名（否则 "schema.ts"/"package.json" 这类几乎出现在
// 每篇技术经验里的内容会被整体判成远程主机，破坏可读性；这是实现
// 阶段发现 design.md 原始正则過于宽泛后的必要收紧，规则收紧方向仍是
// "宁可漏放这一类明显是文件名的 case，不放宽到误拦所有技术文档"）。
const CODE_FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "json", "md", "py", "go", "rs", "java", "kt",
  "yml", "yaml", "css", "scss", "html", "sh", "txt", "csv", "png", "jpg",
  "jpeg", "svg", "lock", "toml", "ini", "env", "test", "gitignore", "vue",
  "mjs", "cjs", "d",
]);

// 只对"看起来真的像域名"的后缀放行：已知 TLD，或三段以上（带子域名）
const KNOWN_TLDS = new Set([
  "com", "net", "org", "io", "dev", "ai", "co", "app", "cloud", "info",
  "gov", "edu", "me", "xyz", "tech", "cn", "top", "site", "online",
]);

const HOST_CANDIDATE_RE =
  /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?){1,})(:[0-9]{2,5})?\b/g;

function isLikelyRemoteHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  const lastLabel = labels[labels.length - 1]!;
  // 纯数字点分串（"22.1.0"/"192.168.1.10"这类）不是主机名——真实主机的
  // 标签是字母数字混合，版本号/构建号才会每段都是纯数字。不排除这一类
  // 会把技术文档里随处可见的"Node 22.1.0"这类版本号整体误判成远程主机
  // （Codex Review 指出的真实 bug：三段式判定完全没看标签内容）。
  if (labels.every((label) => /^[0-9]+$/.test(label))) return false;
  if (labels.length >= 3) return true; // 带子域名，强 FQDN 信号
  if (CODE_FILE_EXTENSIONS.has(lastLabel)) return false; // 明显是文件名
  return KNOWN_TLDS.has(lastLabel);
}

// ---------------------------------------------------------------------------
// 8. 原始聊天内容片段（blocked）——连续 3 行以上、每行以对话角色前缀开头
// ---------------------------------------------------------------------------
const CHAT_ROLE_LINE_RE = /^\s*(User|Assistant|Human|AI|Claude|用户|助手)[:：]/;

function hasChatTranscript(text: string): boolean {
  let streak = 0;
  for (const line of text.split(/\r?\n/)) {
    if (CHAT_ROLE_LINE_RE.test(line)) {
      streak += 1;
      if (streak >= 3) return true;
    } else if (line.trim() !== "") {
      streak = 0;
    }
    // 空行不打断计数——对话记录里说话人之间常有空行分隔
  }
  return false;
}

export function redact(text: string): RedactResult {
  let result = text;
  let redactedCount = 0;
  let blocked = false;

  // 1. 绝对用户目录
  result = result.replace(ABS_PATH_RE, () => {
    redactedCount += 1;
    return "/Users/<redacted>";
  });

  // 2. Token/Key/Cookie —— 命中即 blocked，仍尽力打码（防御性，调用方
  //    不得依赖 blocked=true 时 .text 的安全性）。
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      redactedCount += 1;
      blocked = true;
      return "<token-redacted>";
    });
  }

  // 3. 邮箱
  result = result.replace(EMAIL_RE, () => {
    redactedCount += 1;
    return "<email-redacted>";
  });

  // 4. 内网/私有 IP
  result = result.replace(INTERNAL_IP_RE, () => {
    redactedCount += 1;
    return "<internal-ip-redacted>";
  });

  // 5. 当前用户名（补充手段，非唯一防线）
  const username = os.userInfo().username;
  if (username && username.length >= 2) {
    const usernameRe = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    result = result.replace(usernameRe, () => {
      redactedCount += 1;
      return "<user-redacted>";
    });
  }

  // 6. Git 远程地址里的账号/组织信息
  result = result.replace(GIT_REMOTE_RE, (_m, prefix: string, _org: string, _repo: string, gitSuffix?: string) => {
    redactedCount += 1;
    return `${prefix}<org-redacted>/<repo-redacted>${gitSuffix ?? ""}`;
  });

  // 社交/协作平台 handle
  result = result.replace(HANDLE_RE, () => {
    redactedCount += 1;
    return "<handle-redacted>";
  });

  // 7. 远程主机
  result = result.replace(HOST_CANDIDATE_RE, (m, hostname: string) => {
    if (HOST_WHITELIST.has(hostname.toLowerCase())) return m;
    if (!isLikelyRemoteHost(hostname)) return m;
    redactedCount += 1;
    return "<remote-host-redacted>";
  });

  // 8. 原始聊天内容片段 —— 不尝试脱敏后保留，直接判定 blocked
  if (hasChatTranscript(text)) {
    blocked = true;
  }

  return { text: result, redactedCount, blocked };
}
