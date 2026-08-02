import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canVerify, transition, transitionIdempotent, type VerifyEvidence } from "./lifecycle.ts";

function evidence(overrides: Partial<VerifyEvidence> = {}): VerifyEvidence {
  return {
    codexVerdict: "ALLOW",
    testsPassed: true,
    before: "修复前问题描述",
    after: "修复后验证描述",
    privacyOrSecretHit: false,
    ...overrides,
  };
}

describe("transition — AC-008", () => {
  it("candidate → verified 合法", () => {
    assert.equal(transition("candidate", "verified"), "verified");
  });

  it("candidate → deprecated 合法", () => {
    assert.equal(transition("candidate", "deprecated"), "deprecated");
  });

  it("verified → deprecated 合法", () => {
    assert.equal(transition("verified", "deprecated"), "deprecated");
  });

  it("deprecated → verified 非法，抛错", () => {
    assert.throws(() => transition("deprecated", "verified"));
  });

  it("verified → candidate 非法，抛错", () => {
    assert.throws(() => transition("verified", "candidate"));
  });
});

describe("transitionIdempotent — AC-008", () => {
  it("current === target 时直接返回 current，不抛错", () => {
    assert.equal(transitionIdempotent("verified", "verified"), "verified");
    assert.equal(transitionIdempotent("candidate", "candidate"), "candidate");
  });

  it("非法转换仍然抛错（幂等只处理原地转换，不放宽其他非法转换）", () => {
    assert.throws(() => transitionIdempotent("deprecated", "verified"));
  });

  it("正常转换与 transition() 行为一致", () => {
    assert.equal(transitionIdempotent("candidate", "verified"), "verified");
  });
});

describe("canVerify", () => {
  it("全部条件满足时返回 true", () => {
    assert.equal(canVerify(evidence()), true);
  });

  it("codexVerdict 非 ALLOW 时返回 false", () => {
    assert.equal(canVerify(evidence({ codexVerdict: "BLOCK" })), false);
  });

  it("测试未通过时返回 false", () => {
    assert.equal(canVerify(evidence({ testsPassed: false })), false);
  });

  it("命中隐私/密钥扫描时返回 false", () => {
    assert.equal(canVerify(evidence({ privacyOrSecretHit: true })), false);
  });

  it("修复前后证据缺失时返回 false", () => {
    assert.equal(canVerify(evidence({ before: "" })), false);
    assert.equal(canVerify(evidence({ after: "   " })), false);
  });
});
