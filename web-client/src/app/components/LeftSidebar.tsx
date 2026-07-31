/**
 * 左栏（需求 §4.0 / design.md 模块 5）。220px 固定宽 + flex-shrink-0 防止被
 * 主网格 flex 容器压缩（LESSONS 风险点：flex 容器中固定宽度会被内容挤压）。
 */
import type { Session } from "../session.ts";

export interface LeftSidebarProps {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

export function LeftSidebar({ sessions, activeId, onSelect, onNewSession }: LeftSidebarProps) {
  return (
    <aside
      className="hidden md:flex w-[220px] bg-sidebar-left-bg border-r border-border-color
                 flex-col justify-between p-4 flex-shrink-0 h-full overflow-y-auto no-scrollbar"
    >
      <div>
        <button
          type="button"
          onClick={onNewSession}
          className="w-full bg-brand-primary text-content-bg font-label-sm text-label-sm py-3 px-4
                     flex items-center justify-center gap-2 hover:bg-brand-primary-hover
                     transition-colors mb-6"
        >
          <span className="material-symbols-outlined">add</span>
          新建会话
        </button>

        <h3 className="text-label-sm font-label-sm text-text-muted mb-4 tracking-wider">最近对话</h3>
        <ul className="space-y-1">
          {sessions.map((session) => {
            const active = session.id === activeId;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  aria-current={active ? "true" : undefined}
                  className={`w-full text-left px-3 py-2 text-[14px] truncate transition-colors duration-200 ${
                    active
                      ? "bg-brand-light-bg text-text-primary border-l-2 border-brand-primary font-bold"
                      : "text-text-secondary hover:bg-brand-light-bg"
                  }`}
                >
                  {session.title}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="text-[12px] text-text-muted mt-8 text-center pt-4">
        本地运行 · 数据不会离开当前设备
      </div>
    </aside>
  );
}
