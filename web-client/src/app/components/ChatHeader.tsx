/**
 * 对话区头部（需求 F-001 / design.md 模块 5）。<1100px 时右栏隐藏，改为提供
 * `memory` 图标入口，点击以右侧抽屉展示完整处理依据（F-012）——按钮可见性与
 * `RightPanel` 的 `min-[1100px]:flex` 互补：`flex min-[1100px]:hidden`。
 */
const BADGES = ["QLoRA", "RAG", "Tools"];

export interface ChatHeaderProps {
  onOpenEvidence?: () => void;
}

export function ChatHeader({ onOpenEvidence }: ChatHeaderProps) {
  return (
    <div
      className="px-8 py-6 border-b border-border-color bg-content-bg flex flex-col md:flex-row
                 justify-between items-start md:items-center gap-4 flex-shrink-0"
    >
      <div>
        <h2 className="text-[22px] md:text-[24px] font-bold text-text-primary">家电售后智能客服</h2>
        <p className="text-text-secondary text-[15px] md:text-[16px] mt-1">
          可咨询冰箱、彩电、显示器维修问题
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex gap-2 text-[12px] text-brand-primary">
          {BADGES.map((badge) => (
            <span key={badge} className="bg-brand-light-bg px-3 py-1 text-[13px]">
              {badge}
            </span>
          ))}
        </div>
        {onOpenEvidence && (
          <button
            type="button"
            onClick={onOpenEvidence}
            aria-label="查看处理依据"
            className="flex min-[1100px]:hidden text-text-secondary hover:text-brand-primary transition-colors"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              memory
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
