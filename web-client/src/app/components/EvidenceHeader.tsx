/**
 * 处理依据面板头部（F-002）。
 */
export function EvidenceHeader() {
  return (
    <div className="p-6 border-b border-border-color">
      <h3 className="font-h2 text-[18px] text-text-primary flex items-center gap-2">
        <span className="material-symbols-outlined text-brand-primary" aria-hidden="true">
          memory
        </span>
        处理依据
      </h3>
      <p className="text-text-muted text-[12px] mt-1">本次回答的可验证执行记录</p>
    </div>
  );
}
