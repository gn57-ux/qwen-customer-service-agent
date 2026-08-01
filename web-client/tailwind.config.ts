/**
 * 逐字移植自 Stitch screen「智修客服 - 高级视觉版工作台」内联的
 * <script>（frontend-workbench/docs/assets/stitch-v2/
 * workbench-stitch-v2.html，Feature 9 视觉还原），这是设计令牌的唯一
 * 权威来源；颜色 19 项与旧稿逐值相同（未改动），圆角/boxShadow/
 * body-md 行高是本轮新增/变更项，详见
 * frontend-workbench/specs/9.stitch-v2-visual-restoration/design.md。
 *
 * 逐字段照抄，不做"优化归并"：spacing.md=6rem 等看似冗余的值是模板遗留
 * （本页面实际未用到 md/lg/section-gap-*），照抄即可，改写反而制造与设计稿的偏差。
 *
 * ⛔ 圆角不再是全 0——旧版"全局 0 圆角"决策已被用户明确推翻（见
 * requirements.md「已裁定的设计冲突」），改回 0 前必须先跟用户确认。
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
        DEFAULT: "12px",
        lg: "16px",
        xl: "24px",
        full: "9999px",
      },
      boxShadow: {
        main: "0 24px 60px rgba(36, 54, 78, 0.14), 0 4px 16px rgba(36, 54, 78, 0.08)",
        soft: "0 2px 8px rgba(36, 54, 78, 0.06)",
        "inner-top": "inset 0 1px 0 rgba(255, 255, 255, 0.6)",
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
        "body-md": ["1rem", { lineHeight: "1.7", fontWeight: "400" }],
      },
    },
  },
} satisfies Config;
