/**
 * contract.ts 与 web-client/src/types.ts 的镜像一致性（8.T-006/AC-013）。
 *
 * web-client 是独立的最小包，不与 mastra-agent 共享 TS 编译单元（见 contract.ts
 * 顶部注释），字段镜像目前靠人工 diff 保证一致——本测试把这个"手工比对"自动化：
 * 逐个接口提取"字段名 + 可选标记 + 类型表达式"三元组（忽略注释/空行），并把
 * 类型表达式里引用的别名/接口（`RouteCategory`、`ServiceState`、
 * `ToolCallRecord`）**解析成它们的真实定义**再比较，而不是只比较引用名本身。
 *
 * ⛔ 只比字段名不够（Codex Review 第一轮）：一侧把 `retrievedCount: number`
 * 改成 `retrievedCount?: string` 而漏改另一侧，两个包各自都能编译通过。
 * ⛔ 比了字段名+类型字面量也不够（Codex Review 第二轮）：如果类型写的是一个
 * 别名引用（如 `route: RouteCategory`），两侧字段签名的文本"RouteCategory"
 * 完全相同，但 `RouteCategory` 的真实定义可能已经在某一侧漂移——服务端
 * `RouteCategory` 定义在 `orchestration.ts`（`contract.ts` 里只是 import
 * 类型），必须把这类被引用的别名/接口也解析展开后再比较。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CONTRACT_PATH = fileURLToPath(new URL("./contract.ts", import.meta.url));
const ORCHESTRATION_PATH = fileURLToPath(new URL("./orchestration.ts", import.meta.url));
const TYPES_PATH = fileURLToPath(new URL("../../../web-client/src/types.ts", import.meta.url));

interface FieldSignature {
  name: string;
  optional: boolean;
  type: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * 按"顶层分号"切分成一条条字段声明语句，而不是按换行切分——字段的类型表达式
 * 允许跨多行书写（例如 union 类型从下一行开始），按行切分会让这类合法写法
 * 要么被截断成半个类型、要么整条声明因为首行匹配不上字段名正则而被静默丢弃
 * （Codex Review P2）。这里在方括号/花括号/圆括号/尖括号深度为 0 时才把 `;`
 * 当作语句分隔符，嵌套结构（如 `Record<string, unknown>` 或数组/对象字面量
 * 类型）内部的分号/逗号不会被误切。
 *
 * ⛔ `=>`（箭头函数类型，如 `handler: () => void;`）的 `>` 不是泛型收尾——
 * 如果无差别地把每个 `>` 都当成尖括号深度 -1，这个 `>` 会把深度减到负数，
 * 导致后面所有字段的分号都不再被识别为"深度 0"，多个字段被错误合并成一条
 * （Codex Review P2 第二轮）。修法：`>` 前一个字符是 `=` 时，视为箭头的一
 * 部分，不参与深度计算。
 */
function splitFieldStatements(body: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    const prev = body[i - 1];

    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === ">" && prev !== "=") depth -= 1;

    if (ch === ";" && depth === 0) {
      statements.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/** 从一段 TS 源码里提取指定 interface 的顶层字段签名（名字 + 可选标记 + 原始类型文本），按字段名排序。 */
function extractInterfaceFields(source: string, interfaceName: string): FieldSignature[] {
  const marker = new RegExp(`interface\\s+${interfaceName}\\s*\\{`);
  const match = marker.exec(source);
  if (!match) throw new Error(`未在源码中找到 interface ${interfaceName}`);

  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let i = bodyStart;
  while (depth > 0 && i < source.length) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") depth -= 1;
    i += 1;
  }
  const body = stripComments(source.slice(bodyStart, i - 1));

  const fields: FieldSignature[] = [];
  for (const rawStatement of splitFieldStatements(body)) {
    // 多行字段声明折叠成单行——正则不需要关心换行落在哪里
    const statement = rawStatement.replace(/\s+/g, " ").trim();
    if (!statement) continue;
    const fieldMatch = /^([a-zA-Z0-9_]+)(\?)?\s*:\s*(.+)$/.exec(statement);
    if (!fieldMatch) continue;
    const [, name, optionalMarker, rawType] = fieldMatch;
    const type = rawType!.replace(/,\s*$/, "").trim();
    fields.push({ name: name!, optional: Boolean(optionalMarker), type });
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

/** 提取单行 `type Name = ...;` 别名定义的右侧字面量（本仓库里的别名都是单行 union）。 */
function extractTypeAlias(source: string, aliasName: string): string | null {
  const re = new RegExp(`type\\s+${aliasName}\\s*=\\s*([^;]+);`);
  const match = re.exec(stripComments(source));
  return match ? match[1]!.replace(/\s+/g, " ").trim() : null;
}

/**
 * 把类型文本里"裸引用一个本地别名/接口"的情况解析展开成真实定义，
 * 未知类型（内置类型、字面量联合等）原样返回。只处理 `Name` / `Name[]` 这两种
 * 形状——契约里目前没有更复杂的引用嵌套。
 */
function resolveType(rawType: string, source: string, interfaceNames: string[]): string {
  const match = /^([A-Za-z0-9_]+)(\[\])?$/.exec(rawType.trim());
  if (!match) return rawType;
  const [, baseName, arraySuffix = ""] = match;

  const alias = extractTypeAlias(source, baseName!);
  if (alias) return `${alias}${arraySuffix}`;

  if (interfaceNames.includes(baseName!)) {
    const fields = extractInterfaceFields(source, baseName!);
    return `{ ${fields.map(formatSignature).join("; ")} }${arraySuffix}`;
  }

  return rawType;
}

function formatSignature(field: FieldSignature): string {
  return `${field.name}${field.optional ? "?" : ""}: ${field.type}`;
}

function resolvedSignatures(source: string, interfaceName: string, interfaceNames: string[]): string[] {
  return extractInterfaceFields(source, interfaceName).map((field) => {
    const resolvedType = resolveType(field.type, source, interfaceNames);
    return formatSignature({ ...field, type: resolvedType });
  });
}

// 服务端的 RouteCategory/ToolCallRecord 定义在 orchestration.ts（contract.ts 只
// import 类型），拼接两个文件的源码作为服务端一侧的解析范围；ServiceState 本身
// 定义在 contract.ts。客户端 types.ts 是单文件，三者都在同一份源码里。
const serverSource = [readFileSync(CONTRACT_PATH, "utf-8"), readFileSync(ORCHESTRATION_PATH, "utf-8")].join("\n");
const clientSource = readFileSync(TYPES_PATH, "utf-8");

const INTERFACE_NAMES = ["ChatResponseBody", "OrderStatus", "OrderDetails", "KnowledgeSourceItem", "ServiceStatusBody", "ToolCallRecord"];

describe("contract.ts ↔ web-client/types.ts 字段镜像一致性（AC-013）", () => {
  const CHECKED_INTERFACES = ["ChatResponseBody", "OrderStatus", "OrderDetails", "KnowledgeSourceItem", "ServiceStatusBody"];

  for (const name of CHECKED_INTERFACES) {
    it(`${name} 字段签名（含引用别名/接口解析展开后）完全一致`, () => {
      const serverFields = resolvedSignatures(serverSource, name, INTERFACE_NAMES);
      const clientFields = resolvedSignatures(clientSource, name, INTERFACE_NAMES);
      assert.deepEqual(
        clientFields,
        serverFields,
        `${name} 镜像不一致：\n  server=[${serverFields.join(", ")}]\n  client=[${clientFields.join(", ")}]`,
      );
    });
  }

  it("RouteCategory 别名定义本身两侧一致（不只是引用名相同）", () => {
    const serverAlias = extractTypeAlias(serverSource, "RouteCategory");
    const clientAlias = extractTypeAlias(clientSource, "RouteCategory");
    assert.equal(clientAlias, serverAlias);
  });

  it("ServiceState 别名定义本身两侧一致（不只是引用名相同）", () => {
    const serverAlias = extractTypeAlias(serverSource, "ServiceState");
    const clientAlias = extractTypeAlias(clientSource, "ServiceState");
    assert.equal(clientAlias, serverAlias);
  });
});

describe("extractInterfaceFields — 跨多行的字段声明不能被静默丢弃（Codex Review P2）", () => {
  it("类型表达式从下一行开始的 union 字段，仍能被完整提取", () => {
    const source = `
      interface Foo {
        bar:
          | "a"
          | "b";
        baz: string;
      }
    `;
    const fields = extractInterfaceFields(source, "Foo");
    assert.deepEqual(
      fields.map(formatSignature),
      ['bar: | "a" | "b"', "baz: string"],
    );
  });

  it("两侧都用同一种「下一行开始」的多行写法时，类型不同仍能被判定为不一致（回归防护：不能两边都被静默丢弃而看起来一致）", () => {
    const serverLike = `
      interface Foo {
        bar:
          | "a"
          | "b";
      }
    `;
    const clientLike = `
      interface Foo {
        bar:
          | "a"
          | "c";
      }
    `;
    const serverFields = extractInterfaceFields(serverLike, "Foo").map(formatSignature);
    const clientFields = extractInterfaceFields(clientLike, "Foo").map(formatSignature);
    assert.notDeepEqual(clientFields, serverFields);
  });

  it("箭头函数类型字段（=> 的 > 不是泛型收尾）不会把后续字段合并成一条（Codex Review P2 第二轮）", () => {
    const source = `
      interface Foo {
        handler: () => void;
        after: string;
      }
    `;
    const fields = extractInterfaceFields(source, "Foo");
    assert.deepEqual(
      fields.map(formatSignature),
      ["after: string", "handler: () => void"],
    );
  });

  it("泛型类型（Record<string, unknown>）内部的逗号/分号不会把字段切错，且后续字段独立可见", () => {
    const source = `
      interface Foo {
        meta: Record<string, unknown>;
        after: string;
      }
    `;
    const fields = extractInterfaceFields(source, "Foo");
    assert.deepEqual(
      fields.map(formatSignature),
      ["after: string", "meta: Record<string, unknown>"],
    );
  });
});
