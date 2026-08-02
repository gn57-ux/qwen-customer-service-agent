/**
 * 顶栏（需求 §4.0 / design.md 模块 1）。三项服务状态只读渲染 useServiceStatus() 的
 * data——⛔ 不接受外部直接传入状态覆盖，刷新时机由 hook 自己的 useEffect/轮询决定，
 * 唯一的外部触发口是这里暴露的 refresh()（供 feature 5 在聊天 done/error 后调用）。
 */
import type { ServiceState, ServiceStatusBody } from "../../types.ts";
import { STATE_DOT_CLASS, STATE_GLOW_CLASS, STATE_LABEL } from "./service-status-view.ts";

const SERVICE_ITEMS: Array<{ key: keyof ServiceStatusBody; label: string }> = [
  { key: "localModel", label: "本地模型" },
  { key: "knowledgeBase", label: "知识库" },
  { key: "orderService", label: "订单服务" },
];

export interface HeaderProps {
  status: ServiceStatusBody;
  onClearSession: () => void;
  /** F-008 手动重试：点击状态区重新探测 client.status() */
  onRetryStatus: () => void;
  /** <768px 时左栏隐藏，改为提供菜单入口以左侧抽屉展示会话列表（F-013） */
  onOpenSessions?: () => void;
}

function StatusItem({ label, state }: { label: string; state: ServiceState }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 block rounded-full ${STATE_DOT_CLASS[state]} ${STATE_GLOW_CLASS[state]}`} />
      {label}: {STATE_LABEL[state]}
    </div>
  );
}

export function Header({ status, onClearSession, onRetryStatus, onOpenSessions }: HeaderProps) {
  return (
    <header
      className="bg-content-bg/80 backdrop-blur-md border-b border-border-color/60 w-full z-50
                 flex justify-between items-center px-gutter h-16
                 text-text-secondary font-body-md shrink-0"
    >
      <div className="flex items-center gap-4">
        {onOpenSessions && (
          <button
            type="button"
            onClick={onOpenSessions}
            aria-label="打开会话列表"
            className="flex md:hidden text-text-secondary hover:text-brand-primary transition-colors"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              menu
            </span>
          </button>
        )}
        <h1 className="font-h2 text-[22px] font-bold text-text-primary tracking-tight">智修客服</h1>
        <span className="text-text-muted font-code text-[13px] border-l border-border-color/60 pl-4 hidden md:inline tracking-wide">
          家电售后智能助手
        </span>
      </div>

      <button
        type="button"
        onClick={onRetryStatus}
        title="点击重新探测服务状态"
        aria-label="重新探测服务状态"
        className="hidden md:flex gap-6 text-label-sm font-label-sm items-center text-text-muted
                   cursor-pointer hover:text-text-secondary transition-colors duration-200"
      >
        {SERVICE_ITEMS.map(({ key, label }) => (
          <StatusItem key={key} label={label} state={status[key]} />
        ))}
      </button>

      <button
        type="button"
        onClick={onClearSession}
        aria-label="清空会话"
        className="hover:bg-brand-light-bg transition-colors duration-200 cursor-pointer
                   active:opacity-70 text-text-secondary font-label-sm flex items-center gap-2
                   p-2 rounded-md"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[20px]">
          delete
        </span>
        <span className="hidden md:inline">清空会话</span>
      </button>
    </header>
  );
}
