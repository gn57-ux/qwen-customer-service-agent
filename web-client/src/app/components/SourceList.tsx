/**
 * 引用来源列表（F-009/F-010/F-011）。点击行为解析开放问题：点击滚动定位到
 * AssistantMessage 里对应的引用角标——两边共用 `citationElementId()` 生成同一个
 * id，本组件不猜测格式（Codex Review P2：之前只有 cursor-pointer/hover 视觉，
 * 没有真实点击行为，是误导性的可交互外观）。
 */
import { citationElementId } from "../citation.ts";
import type { EvidenceSource } from "../evidence/derive.ts";

/** Stitch v2 高优先级左边框改用与 SafetyCard 一致的 #C55B51（不是旧的
 * safety-text token）——两处颜色本轮统一切换到新稿的独立配色。 */
const BORDER_CLASS: Record<EvidenceSource["tone"], string> = {
  brand: "border-l-brand-primary",
  safety: "border-l-[#C55B51]",
};

export interface SourceListProps {
  sources: EvidenceSource[];
  emptyText: string;
  /** 引用角标所在的 AI 消息 id；不存在时（如仍在流式中）点击无目标可跳，退化为纯展示 */
  messageId?: string;
}

export function SourceList({ sources, emptyText, messageId }: SourceListProps) {
  const handleClick = (index: number) => {
    if (!messageId) return;
    const target = document.getElementById(citationElementId(messageId, index));
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div>
      <h4 className="text-text-muted mb-3 text-[12px] uppercase tracking-wider">引用来源</h4>
      {sources.length === 0 ? (
        <p className="text-text-muted text-[13px]">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {sources.map((source, index) => (
            <li key={`${source.title}-${index}`}>
              <button
                type="button"
                onClick={() => handleClick(index)}
                disabled={!messageId}
                className={`w-full text-left bg-white rounded-[12px] border border-[#E2E8F0] p-3 shadow-soft
                           hover:shadow-md transition-shadow cursor-pointer border-l-[3px]
                           disabled:cursor-default disabled:hover:shadow-soft
                           ${BORDER_CLASS[source.tone]}`}
              >
                <div className="text-[13px] text-text-primary truncate">{source.title}</div>
                <div className="text-[10px] text-text-muted mt-1 opacity-60">
                  {source.meta}
                  {source.highlighted ? "（高优）" : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
