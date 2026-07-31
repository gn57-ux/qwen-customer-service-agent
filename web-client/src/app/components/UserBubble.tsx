/**
 * 用户消息气泡（F-003）。
 */
export interface UserBubbleProps {
  content: string;
}

export function UserBubble({ content }: UserBubbleProps) {
  return (
    <div className="flex justify-end">
      <div className="bg-brand-light-bg px-6 py-4 max-w-2xl">
        <p className="text-text-primary text-[15px] md:text-[16px] whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
}
