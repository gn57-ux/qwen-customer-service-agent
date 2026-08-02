/**
 * 回答模式卡（F-007/F-008）。
 */
import type { EvidenceMode } from "../evidence/derive.ts";

const CHIP_CLASS: Record<EvidenceMode["tone"], string> = {
  neutral: "bg-page-bg border border-border-color text-text-primary",
  safety: "bg-safety-bg border border-safety-border text-safety-text",
};

export interface ModeCardProps {
  modes: EvidenceMode[];
  degradedReason?: string;
}

export function ModeCard({ modes, degradedReason }: ModeCardProps) {
  return (
    <div className="bg-content-bg border border-border-color p-4">
      <h4 className="text-text-muted mb-3 text-[12px] tracking-wider">回答模式</h4>
      <div className="flex flex-wrap gap-2 text-[12px]">
        {modes.map((mode) => (
          <span key={mode.label} className={`px-2 py-1 flex items-center gap-1 ${CHIP_CLASS[mode.tone]}`}>
            {mode.icon && (
              <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                {mode.icon}
              </span>
            )}
            {mode.label}
          </span>
        ))}
      </div>
      {degradedReason && <p className="text-safety-text text-[12px] mt-2">{degradedReason}</p>}
    </div>
  );
}
