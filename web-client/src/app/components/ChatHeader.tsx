/**
 * 对话区头部（需求 F-001 / design.md 模块 5）。
 */
const BADGES = ["QLoRA", "RAG", "Tools"];

export function ChatHeader() {
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
      <div className="flex gap-2 text-[12px] text-brand-primary">
        {BADGES.map((badge) => (
          <span key={badge} className="bg-brand-light-bg px-3 py-1 text-[13px]">
            {badge}
          </span>
        ))}
      </div>
    </div>
  );
}
