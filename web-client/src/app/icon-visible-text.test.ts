/**
 * Feature 9 任务 1 的回归防护："Material Symbols 显示为名称文字必须判
 * FAIL"（frontend-workbench/specs/9.stitch-v2-visual-restoration/
 * requirements.md 的验收标准 2）。
 *
 * jsdom 测试环境不加载/不应用外部 CSS 文件（vitest.config.ts 未配置
 * `css: true`），无法在运行时真实断言 computed opacity——因此改为对
 * styles.css **源码**做静态扫描：只要防闪烁的 CSS 规则（图标默认透明 +
 * icons-ready 后才可见）还在源文件里，就能保证真实浏览器渲染时不会
 * 出现裸露的图标名称文字；这条规则一旦被误删或改写，本测试立刻失败，
 * 不依赖能否在 jsdom 里跑起真实字体加载时序。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vitest 的模块转换会让 import.meta.url 不是标准 file:// URL，
// 用 vitest 进程自身的 cwd（web-client 目录）拼接更可靠。
const stylesPath = resolve(process.cwd(), "src/app/styles.css");
const stylesSource = readFileSync(stylesPath, "utf-8");

describe("图标可见文本回归防护（styles.css 静态扫描）", () => {
  it("material-symbols-outlined 默认透明，避免 fallback 字体把图标名称当文字显示", () => {
    expect(stylesSource).toMatch(/\.material-symbols-outlined\s*\{[^}]*opacity:\s*0/);
  });

  it("icons-ready class 存在，且把图标透明度切回可见", () => {
    expect(stylesSource).toMatch(/html\.icons-ready\s+\.material-symbols-outlined\s*\{[^}]*opacity:\s*1/);
  });
});
