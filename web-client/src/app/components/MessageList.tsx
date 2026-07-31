/**
 * 消息流容器（F-002 / design.md 模块 4）。`pb-40`(160px) 是为底部绝对定位的
 * 输入区避让——⛔ 不可省略，否则最后一条消息会被输入区遮挡（AC-007）。
 *
 * 滚动贴底策略：只有"渲染前用户已经在底部附近（<80px）"才自动跟随滚到底，
 * 用户手动上滚查看历史后不会被强行拉回（AC-006）。
 *
 * Codex Review P2 修复：不能在 messages 变化后的 useLayoutEffect 里现测
 * nearBottom——此时新内容已经撑高了 scrollHeight，哪怕用户本来就贴底，测出来
 * 也会因为新增内容 ≥80px 而被误判成"不在底部"，导致该跟随时没跟随。改为用
 * onScroll 持续记录"用户上一次滚动后是否在底部附近"，这个值不受本次消息新增
 * 影响，程序化滚到底之后浏览器仍会派发 scroll 事件把状态刷新回"在底部"。
 */
import { useLayoutEffect, useRef } from "react";

import type { Message } from "../chat-types.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { UserBubble } from "./UserBubble.tsx";

const NEAR_BOTTOM_THRESHOLD_PX = 80;

export interface MessageListProps {
  messages: Message[];
  onCopy?: (text: string) => void;
  onRegenerate?: () => void;
  onFeedback?: (value: "up" | "down") => void;
}

function isNearBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
}

export function MessageList({ messages, onCopy, onRegenerate, onFeedback }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");

  const handleScroll = () => {
    const el = containerRef.current;
    if (el) wasNearBottomRef.current = isNearBottom(el);
  };

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-8 no-scrollbar pb-40"
    >
      {messages.map((message, index) =>
        message.role === "user" ? (
          <UserBubble key={message.id} content={message.content} />
        ) : (
          <AssistantMessage
            key={message.id}
            turn={message.turn}
            onCopy={onCopy}
            onRegenerate={index === lastAssistantIndex ? onRegenerate : undefined}
            onFeedback={onFeedback}
          />
        ),
      )}
    </div>
  );
}
