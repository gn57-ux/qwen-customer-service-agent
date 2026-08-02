/**
 * 处理依据底部栏（F-012/F-013）。traceId/耗时无数据时显示「—」。
 */
export interface EvidenceFooterProps {
  traceId?: string;
  latencyText?: string;
}

export function EvidenceFooter({ traceId, latencyText }: EvidenceFooterProps) {
  return (
    <div className="p-4 border-t border-border-color bg-sidebar-right-bg flex justify-between items-center font-code text-[12px] text-text-muted">
      <span>{traceId ?? "—"}</span>
      <span>{latencyText ?? "—"}</span>
    </div>
  );
}
