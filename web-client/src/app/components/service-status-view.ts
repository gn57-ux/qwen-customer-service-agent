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
