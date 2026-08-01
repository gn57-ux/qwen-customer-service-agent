/**
 * 根骨架（需求文档 §4.0）：Header + LeftSidebar（feature 4）、MainChat（feature 5）、
 * RightPanel（feature 6）均已落地。
 */
import { useCallback, useState } from "react";

import { ClientProvider } from "./client-context.tsx";
import { Drawer } from "./components/Drawer.tsx";
import { Header } from "./components/Header.tsx";
import { LeftSidebar, SessionListContent } from "./components/LeftSidebar.tsx";
import { MainChat } from "./components/MainChat.tsx";
import { EvidencePanelContent, RightPanel } from "./components/RightPanel.tsx";
import type { Message } from "./chat-types.ts";
import { useChatStream } from "./hooks/use-chat-stream.ts";
import { useIconFontReady } from "./hooks/use-icon-font-ready.ts";
import { useServiceStatus } from "./hooks/use-service-status.ts";
import { createSession, titleFromContent, DEFAULT_TITLE, type Session } from "./session.ts";
import type { CustomerServiceClient } from "../client.ts";

function Workbench() {
  useIconFontReady();
  const { data: status, refresh: refreshStatus } = useServiceStatus();
  const [sessions, setSessions] = useState<Session[]>(() => [createSession()]);
  const [activeId, setActiveId] = useState(() => sessions[0].id);
  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
  const [sessionsDrawerOpen, setSessionsDrawerOpen] = useState(false);

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
    setSessionsDrawerOpen(false);
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveId(sessionId);
    setSessionsDrawerOpen(false);
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
    <div className="bg-gradient-page font-body-md text-text-primary antialiased h-screen flex flex-col overflow-hidden relative">
      {/* Stitch v2「全局背景与主容器质感」：两个装饰性光晕，纯视觉、不承载交互，
          pointer-events-none 避免遮挡下方内容的点击/hover。 */}
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 w-96 h-96 bg-brand-light-bg rounded-full mix-blend-multiply filter blur-3xl opacity-50 pointer-events-none -translate-x-1/2 -translate-y-1/2"
      />
      <div
        aria-hidden="true"
        className="absolute bottom-0 right-0 w-96 h-96 bg-brand-light-bg rounded-full mix-blend-multiply filter blur-3xl opacity-50 pointer-events-none translate-x-1/2 translate-y-1/2"
      />
      {/* 主容器：悬浮卡片化（居中留白 + 圆角 + 双层阴影），Header 与三栏
          都在这个容器的 flex 流内部，不再用 fixed 顶栏 + margin-top 模拟。

          ⛔ Codex Review 指出：`w-full` + `m-4`/`mx-auto` 会冲突——
          `w-full` 把宽度显式钉死在父容器 100%，再叠加 margin 会让总
          占用宽度超出父容器（100% + 2×margin），被外层 overflow-hidden
          裁掉，看不出对称留白；而 `mx-auto` 和 `m-4`/`lg:m-8` 同时写在
          class 里时，Tailwind 按内部 utility 定义顺序（不是 JSX 里的书写
          顺序）生成样式表，`mx-auto` 会赢过 `m-4` 的水平分量，导致
          16px 留白在小于 lg 断点时直接消失。
          改用显式 `calc()` 宽度直接减去留白值，不再用 `w-full` + margin
          这种依赖浏览器/工具链内部顺序才能算对的组合——
          `w-[calc(100%-2rem)]` 已经把两侧各 16px 留白算进宽度本身，
          `mx-auto` 此时只负责在超过 max-w 时把多余空间对称分配到两侧，
          不再与任何 margin 工具类竞争同一属性。 */}
      <div className="flex-1 flex flex-col overflow-hidden w-[calc(100%-2rem)] lg:w-[calc(100%-4rem)] max-w-[1920px] mx-auto my-4 lg:my-8 bg-content-bg rounded-lg border border-border-color shadow-main-with-inner relative z-10">
        <Header
          status={status}
          onClearSession={handleClearSession}
          onRetryStatus={() => void refreshStatus()}
          onOpenSessions={() => setSessionsDrawerOpen(true)}
        />
        <div className="flex-1 flex overflow-hidden w-full relative min-h-0">
          <LeftSidebar
            sessions={sessions}
            activeId={activeSession.id}
            onSelect={handleSelectSession}
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
            onOpenEvidence={() => setEvidenceDrawerOpen(true)}
          />
          <RightPanel turn={lastAssistantTurn} messageId={lastAssistantTurn ? lastMessage?.id : undefined} />
        </div>
      </div>

      {/* F-012：<1100px 右栏隐藏，右抽屉 100% 复用 EvidencePanelContent（不复制） */}
      <Drawer
        open={evidenceDrawerOpen}
        onClose={() => setEvidenceDrawerOpen(false)}
        side="right"
        bgClassName="bg-sidebar-right-bg"
        widthClassName="w-[300px]"
      >
        <EvidencePanelContent turn={lastAssistantTurn} messageId={lastAssistantTurn ? lastMessage?.id : undefined} />
      </Drawer>

      {/* F-013：<768px 左栏隐藏，左抽屉 100% 复用 SessionListContent（不复制） */}
      <Drawer
        open={sessionsDrawerOpen}
        onClose={() => setSessionsDrawerOpen(false)}
        side="left"
        bgClassName="bg-sidebar-left-bg"
        widthClassName="w-[220px]"
      >
        <div className="flex-1 flex flex-col justify-between p-4">
          <SessionListContent
            sessions={sessions}
            activeId={activeSession.id}
            onSelect={handleSelectSession}
            onNewSession={handleNewSession}
          />
        </div>
      </Drawer>
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
