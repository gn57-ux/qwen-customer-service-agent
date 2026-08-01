/**
 * 用户消息气泡（F-003）。
 */
export interface UserBubbleProps {
  content: string;
}

export function UserBubble({ content }: UserBubbleProps) {
  return (
    <div className="flex justify-end">
      <div className="bg-gradient-to-br from-[#EEF4FA] to-[#E2ECF6] border border-[#D9E6F2] rounded-[12px] rounded-tr-[4px] shadow-soft px-5 py-3.5 max-w-2xl">
        <p className="text-text-primary text-[15px] md:text-[16px] whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
}
