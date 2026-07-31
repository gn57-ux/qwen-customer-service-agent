/**
 * 右栏「处理依据」推导层（design.md 模块 1）。⛔ 铁律：这里是唯一允许从
 * ChatResponseBody 推导展示内容的地方，函数签名只接受结构化对象，不接受
 * 正文字符串——从类型层面阻断"顺手对 reply 做正则"这条路（需求 §5.3）。
 */
import type { ChatResponseBody, RouteCategory, ToolCallRecord } from "../../types.ts";

export type StepTone = "success" | "brand" | "safety";
export type ModeTone = "neutral" | "safety";
export type SourceTone = "brand" | "safety";

export interface EvidenceStep {
  label: string;
  tone: StepTone;
  bold?: boolean;
}

export interface EvidenceMode {
  label: string;
  tone: ModeTone;
  icon?: string;
}

export interface EvidenceSource {
  title: string;
  meta: string;
  highlighted: boolean;
  tone: SourceTone;
}

export interface EvidenceView {
  steps: EvidenceStep[];
  modes: EvidenceMode[];
  degradedReason?: string;
  sources: EvidenceSource[];
  traceId: string;
  latencyText: string;
}

const ROUTE_LABEL: Record<RouteCategory, string> = {
  safety: "安全咨询",
  order: "订单查询",
  repair: "维修排查",
  general: "一般咨询",
};

const TOOL_LABEL: Record<string, string> = {
  searchKnowledgeBase: "维修知识库",
  queryOrderTool: "订单服务",
};

function toolLabel(name: ToolCallRecord["name"]): string {
  return TOOL_LABEL[name] ?? name;
}

function deriveSteps(body: ChatResponseBody): EvidenceStep[] {
  const steps: EvidenceStep[] = [];
  steps.push({ label: `已识别 · ${ROUTE_LABEL[body.route]}`, tone: "success" });
  for (const call of body.toolCalls) {
    steps.push({ label: `已调用 · ${toolLabel(call.name)}`, tone: "success" });
  }
  // ⛔ 禁止硬编码 20——只认 retrievedCount 字段，且 0 时不渲染该节点（AC-005）
  if (body.retrievedCount > 0) {
    steps.push({ label: `已召回 · ${body.retrievedCount} 个候选片段`, tone: "brand" });
  }
  // ⛔ 禁止硬编码 5——只认 returnedCount 字段，且须 reranked === true（AC-004）
  if (body.reranked === true) {
    steps.push({ label: `重排完成 · Top ${body.returnedCount}`, tone: "brand" });
  }
  steps.push({ label: "已生成", tone: "brand" });
  if (body.route === "safety") {
    steps.push({ label: "已触发 · 安全策略", tone: "safety", bold: true });
  }
  return steps;
}

function deriveModes(body: ChatResponseBody): EvidenceMode[] {
  const modes: EvidenceMode[] = [{ label: "本地QLoRA", tone: "neutral" }];
  if (body.sources && body.sources.length > 0) {
    modes.push({ label: "RAG知识增强", tone: "neutral" });
  }
  if (body.route === "safety") {
    modes.push({ label: "安全策略介入", tone: "safety", icon: "gpp_maybe" });
  }
  if (body.degraded === true) {
    modes.push({ label: "降级运行", tone: "safety", icon: "gpp_maybe" });
  }
  return modes;
}

function deriveSources(body: ChatResponseBody): EvidenceSource[] {
  const sources = body.sources ?? [];
  // reranked !== true 时 rerankScore 全为 null，maxRerank 恒为 -Infinity，
  // 不会有任何一项被判定为高优——不需要单独分支处理这个边界（AC-007）。
  // 「高优」是 rank-1 语义，只能有唯一一项——rerankScore 并列时，取第一个
  // 达到最大值的下标作为确定性 tie-break，不能让所有并列项都判高优。
  let topIndex = -1;
  if (body.reranked === true) {
    let maxRerank = Number.NEGATIVE_INFINITY;
    sources.forEach((source, index) => {
      if (source.rerankScore !== null && source.rerankScore > maxRerank) {
        maxRerank = source.rerankScore;
        topIndex = index;
      }
    });
  }

  return sources.map((source, index) => {
    const highlighted = index === topIndex;
    // F-011：安全场景下 rank-1（高优）用 safety 边框色，其余一律 brand
    const tone: SourceTone = body.route === "safety" && highlighted ? "safety" : "brand";
    return {
      title: source.title,
      meta: `${source.sourceFile} · ${source.documentVersion}`,
      highlighted,
      tone,
    };
  });
}

function formatLatency(latencyMs: number): string {
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

/**
 * 流式期间的临时链路视图（design.md 模块 3）：只有 tool-result 事件能实时追加
 * 节点——route/retrievedCount/reranked/sources 这些字段只在 done 的结构化
 * body 里才存在，流式阶段拿不到，不能猜。done 到达后由 deriveEvidence() 全量
 * 覆盖，稳定 key（label）让 React 复用 DOM，不产生闪烁。
 */
export function deriveInterimSteps(toolCalls: ToolCallRecord[]): EvidenceStep[] {
  return toolCalls.map((call) => ({ label: `已调用 · ${toolLabel(call.name)}`, tone: "success" as const }));
}

export function deriveEvidence(body: ChatResponseBody): EvidenceView {
  return {
    steps: deriveSteps(body),
    modes: deriveModes(body),
    degradedReason: body.degraded === true ? (body.degradedReason ?? "未提供降级原因") : undefined,
    sources: deriveSources(body),
    traceId: body.traceId,
    latencyText: formatLatency(body.latencyMs),
  };
}
