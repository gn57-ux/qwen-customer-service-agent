/**
 * 逐字移植自 Stitch screen「智修客服 - 专业版工作台」内联的 <script id="tailwind-config">
 * （frontend-workbench/docs/assets/workbench-stitch.html），这是设计令牌的唯一权威来源。
 * ⛔ 明确不采用项目级 designTheme 的灰阶配色——见需求文档 §1.4 裁定。
 *
 * 逐字段照抄，不做"优化归并"：spacing.md=6rem 等看似冗余的值是模板遗留
 * （本页面实际未用到 md/lg/section-gap-*），照抄即可，改写反而制造与设计稿的偏差。
 */
import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "page-bg": "#F5F7FA",
        "content-bg": "#FCFDFE",
        "sidebar-left-bg": "#EEF2F6",
        "sidebar-right-bg": "#F7F9FB",
        "text-primary": "#243142",
        "text-secondary": "#667085",
        "text-muted": "#8A94A3",
        "border-color": "#DCE3EA",
        "brand-primary": "#4F6F8F",
        "brand-primary-hover": "#405F7D",
        "brand-light-bg": "#E8F0F7",
        "success-green": "#3F7C5F",
        "success-bg": "#E9F4EE",
        "safety-text": "#A14D45",
        "safety-bg": "#FBEDEA",
        "safety-border": "#E7B8B2",
        "citation-bg": "#E7F3F1",
        "citation-text": "#3F7C78",
        "input-border": "#CBD5DF",
      },
      borderRadius: {
        DEFAULT: "0px",
        lg: "0px",
        xl: "0px",
        full: "0px",
      },
      spacing: {
        "section-gap-sm": "4rem",
        md: "6.0rem",
        base: "0.5rem",
        sm: "3.0rem",
        lg: "12.0rem",
        "max-width": "1280px",
        gutter: "1.5rem",
        "margin-page": "1.5rem",
      },
      fontFamily: {
        h2: ["Inter", "sans-serif"],
        code: ["JetBrains Mono", "monospace"],
        "display-hero-mobile": ["Inter", "sans-serif"],
        h1: ["Inter", "sans-serif"],
        "display-hero": ["Inter", "sans-serif"],
        "label-sm": ["Inter", "sans-serif"],
        "body-md": ["Inter", "sans-serif"],
      },
      fontSize: {
        h2: ["24px", { lineHeight: "1.3", fontWeight: "600" }],
        code: ["14px", { lineHeight: "1.5", fontWeight: "400" }],
        "display-hero-mobile": ["40px", { lineHeight: "1.1", letterSpacing: "-0.01em", fontWeight: "700" }],
        h1: ["2.5rem", { lineHeight: "1.2", fontWeight: "700" }],
        "display-hero": ["64px", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "700" }],
        "label-sm": ["14px", { lineHeight: "1.4", letterSpacing: "0.01em", fontWeight: "500" }],
        "body-md": ["1rem", { lineHeight: "1.6", fontWeight: "400" }],
      },
    },
  },
} satisfies Config;
