/**
 * 根骨架（需求文档 §4.0）：Header + LeftSidebar（feature 4）、MainChat（feature 5）、
 * RightPanel（feature 6）均已落地。
 */
import { useCallback, useState } from "react";

import { ClientProvider } from "./client-context.tsx";
import { Header } from "./components/Header.tsx";
import { LeftSidebar } from "./components/LeftSidebar.tsx";
import { MainChat } from "./components/MainChat.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import type { Message } from "./chat-types.ts";
import { useChatStream } from "./hooks/use-chat-stream.ts";
import { useServiceStatus } from "./hooks/use-service-status.ts";
import { createSession, titleFromContent, DEFAULT_TITLE, type Session } from "./session.ts";
import type { CustomerServiceClient } from "../client.ts";

function Workbench() {
  const { data: status, refresh: refreshStatus } = useServiceStatus();
  const [sessions, setSessions] = useState<Session[]>(() => [createSession()]);
  const [activeId, setActiveId] = useState(() => sessions[0].id);

  // 按 sessionId 定向写回——与"当前展示哪个会话"解耦，见 use-chat-stream.ts 顶部注释。
  const setSessionMessages = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? { ...session, messages: updater(session.messages) } : session)),
    );
  }, []);

  const activeSession = sessions.find((session) => session.id === activeId) ?? sessions[0]!;
  const lastMessage = activeSession.messages.at(-1);
  const lastAssistantTurn = lastMessage?.role === "assistant" ? lastMessage.turn : undefined;

  const chat = useChatStream({
    sessionId: activeSession.id,
    messages: activeSession.messages,
    onMessagesChange: setSessionMessages,
    onSettled: refreshStatus,
  });

  const handleNewSession = useCallback(() => {
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
  }, []);

  // F-009：清空当前会话的消息，不影响其他会话（design.md 模块 5）。若当前会话
  // 正在流式生成，先取消请求再清空——否则请求继续跑、composer 也会一直锁在
  // 发送中，直到那个已经没有消息可写的 turn 自然结束才解锁（Codex Review P2）。
  const handleClearSession = useCallback(() => {
    chat.cancel();
    setSessionMessages(activeSession.id, () => []);
  }, [activeSession.id, chat, setSessionMessages]);

  const handleSend = useCallback(
    (content: string) => {
      // 首条消息落地前用它派生会话标题（需求：左栏标题取首条用户消息截断文本）。
      if (activeSession.messages.length === 0 && activeSession.title === DEFAULT_TITLE) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === activeSession.id ? { ...session, title: titleFromContent(content) } : session,
          ),
        );
      }
      void chat.sendMessage(content);
    },
    [activeSession.id, activeSession.messages.length, activeSession.title, chat],
  );

  return (
    <div className="bg-page-bg font-body-md text-text-primary antialiased h-screen flex flex-col overflow-hidden">
      <Header status={status} onClearSession={handleClearSession} onRetryStatus={() => void refreshStatus()} />
      <div className="flex-1 mt-16 flex overflow-hidden w-full max-w-[1920px] mx-auto">
        <LeftSidebar
          sessions={sessions}
          activeId={activeSession.id}
          onSelect={setActiveId}
          onNewSession={handleNewSession}
        />
        <MainChat
          messages={activeSession.messages}
          isStreaming={chat.isStreaming}
          onSend={handleSend}
          onStop={chat.cancel}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text).catch(() => {});
          }}
          onRegenerate={() => void chat.regenerate()}
        />
        <RightPanel turn={lastAssistantTurn} messageId={lastAssistantTurn ? lastMessage?.id : undefined} />
      </div>
    </div>
  );
}

export interface AppProps {
  /** 测试专用：透传给 ClientProvider，避免测试触发真实网络请求 */
  client?: CustomerServiceClient;
}

export function App({ client }: AppProps = {}) {
  return (
    <ClientProvider client={client}>
      <Workbench />
    </ClientProvider>
  );
}
