/** 经验生命周期状态机：candidate → verified → deprecated（单向，不可复活）。 */

export type Status = "candidate" | "verified" | "deprecated";

const ALLOWED_TRANSITIONS: Record<Status, Status[]> = {
  candidate: ["verified", "deprecated"],
  verified: ["deprecated"],
  deprecated: [],
};

export function transition(current: Status, target: Status): Status {
  if (!ALLOWED_TRANSITIONS[current].includes(target)) {
    throw new Error(`非法状态转换：${current} → ${target}`);
  }
  return target;
}

/**
 * 幂等包装：current === target 时直接返回 current，不调用 transition()、
 * 不抛错——供 Feature 3 的 experience:finalize 处理并发 finalize 收敛
 * （第二个请求读到的 current 可能已经是目标状态，这是正常收敛不是错误；
 * ⛔ 不通过给 ALLOWED_TRANSITIONS 加自环解决，那会让底层状态机允许
 * "原地打转"，掩盖真正的非法转换）。
 */
export function transitionIdempotent(current: Status, target: Status): Status {
  if (current === target) return current;
  return transition(current, target);
}

export interface VerifyEvidence {
  /** Stop Hook / Codex Review 最终裁定 */
  codexVerdict: "ALLOW" | "BLOCK" | "ERROR";
  /** 本任务要求的自动测试是否通过 */
  testsPassed: boolean;
  /** 修复前问题描述 */
  before: string;
  /** 修复后验证描述 */
  after: string;
  /** 隐私/密钥扫描是否命中（true = 命中，不允许晋升） */
  privacyOrSecretHit: boolean;
}

/**
 * candidate → verified 的前置条件校验，只检查证据对象字段是否齐全、
 * 结论是否满足——不感知 Stop Hook 本身，实际证据采集由 Feature 5 的
 * N8 集成流程负责。
 */
export function canVerify(evidence: VerifyEvidence): boolean {
  if (evidence.codexVerdict !== "ALLOW") return false;
  if (!evidence.testsPassed) return false;
  if (evidence.privacyOrSecretHit) return false;
  if (!evidence.before.trim() || !evidence.after.trim()) return false;
  return true;
}
