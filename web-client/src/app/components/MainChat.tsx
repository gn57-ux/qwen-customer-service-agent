/**
 * 中间对话区（design.md 模块 5）。纯展示组件——流式状态由 `useChatStream()`
 * 在父组件（App）持有，这里只接线，方便 App 在新建/清空会话时统一 reset()。
 */
import type { Message } from "../chat-types.ts";
import { ChatHeader } from "./ChatHeader.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";

export interface MainChatProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  onCopy?: (text: string) => void;
  onRegenerate?: () => void;
  onFeedback?: (value: "up" | "down") => void;
  onOpenEvidence?: () => void;
}

export function MainChat({
  messages,
  isStreaming,
  onSend,
  onStop,
  onCopy,
  onRegenerate,
  onFeedback,
  onOpenEvidence,
}: MainChatProps) {
  return (
    <main className="flex-1 flex flex-col h-full bg-content-bg relative min-w-0">
      <ChatHeader onOpenEvidence={onOpenEvidence} />
      <MessageList messages={messages} onCopy={onCopy} onRegenerate={onRegenerate} onFeedback={onFeedback} />
      <Composer isStreaming={isStreaming} onSend={onSend} onStop={onStop} />
    </main>
  );
}
