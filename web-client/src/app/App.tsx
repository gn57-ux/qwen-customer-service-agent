/**
 * 根骨架（需求文档 §4.0）：Header + LeftSidebar 已在 feature 4 落地；
 * MainChat（feature 5）与 RightPanel（feature 6）仍是占位，后续直接替换即可。
 */
import { useCallback, useState } from "react";

import { ClientProvider } from "./client-context.tsx";
import { Header } from "./components/Header.tsx";
import { LeftSidebar } from "./components/LeftSidebar.tsx";
import { useServiceStatus } from "./hooks/use-service-status.ts";
import { createSession, type Session } from "./session.ts";
import type { CustomerServiceClient } from "../client.ts";

function Workbench() {
  const { data: status, refresh: refreshStatus } = useServiceStatus();
  const [sessions, setSessions] = useState<Session[]>(() => [createSession("新会话")]);
  const [activeId, setActiveId] = useState(() => sessions[0].id);

  const handleNewSession = useCallback(() => {
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
  }, []);

  // F-009：清空的是当前会话的消息，不是整个会话列表（design.md 模块 5）。
  const handleClearSession = useCallback(() => {
    setSessions((prev) =>
      prev.map((session) => (session.id === activeId ? { ...session, messages: [] } : session)),
    );
  }, [activeId]);

  return (
    <div className="bg-page-bg font-body-md text-text-primary antialiased h-screen flex flex-col overflow-hidden">
      <Header status={status} onClearSession={handleClearSession} onRetryStatus={() => void refreshStatus()} />
      <div className="flex-1 mt-16 flex overflow-hidden w-full max-w-[1920px] mx-auto">
        <LeftSidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onNewSession={handleNewSession}
        />
        {/* TODO(feature 5): <MainChat /> */}
        <main className="flex-1 min-w-0" />
        {/* TODO(feature 6): <RightPanel /> */}
        <aside className="hidden min-[1100px]:flex w-[300px] xl:w-[320px] flex-shrink-0" />
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
