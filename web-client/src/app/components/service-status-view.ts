/**
 * F-006 四态映射。degraded/error 同色（safety-text，需求 §3.1 无独立 error 色），
 * 文字标签是二者唯一区分手段——引用方必须同时渲染 STATE_LABEL，不能只画状态点。
 */
import type { ServiceState } from "../../types.ts";

export const STATE_LABEL: Record<ServiceState, string> = {
  unknown: "未知",
  online: "在线",
  degraded: "降级",
  error: "异常",
};

export const STATE_DOT_CLASS: Record<ServiceState, string> = {
  unknown: "bg-text-muted",
  online: "bg-success-green",
  degraded: "bg-safety-text",
  error: "bg-safety-text",
};

/** Stitch v2 顶栏状态点辉光：只有"在线"态才有柔和辉光（`.glow-green`，
 * styles.css 定义），unknown/degraded/error 三态是纯色硬点——辉光本身
 * 语义上是"一切正常"的强调，不该用在异常/未知状态上。 */
export const STATE_GLOW_CLASS: Record<ServiceState, string> = {
  unknown: "",
  online: "glow-green",
  degraded: "",
  error: "",
};
