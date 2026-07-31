/**
 * AI 消息（F-004/F-005）。安全提示卡、订单卡由 feature 7 通过 `children` 插槽
 * 注入——本组件只负责身份行、正文、引用角标、操作行、错误态展示。
 *
 * ⛔ 正文渲染禁止 dangerouslySetInnerHTML（design.md 安全考虑）：用
 * `whitespace-pre-wrap` 让 `\n` 自然换行，不解析设计稿里的 `<br>`。
 *
 * 引用角标（feature 6 F-009 的开放问题resolution）：右栏「引用来源」列表点击
 * 需要滚动定位到这里渲染的角标，双方共用 `citationElementId(messageId, index)`
 * 生成同一个 id，不能各写一份格式字符串。
 */
import type { ReactNode } from "react";

import type { AssistantTurn } from "../chat-types.ts";
import { citationElementId } from "../citation.ts";

export interface AssistantMessageProps {
  /** 本消息的稳定 id——用于生成引用角标锚点，供右栏 SourceList 点击滚动定位 */
  messageId: string;
  turn: AssistantTurn;
  onCopy?: (text: string) => void;
  onRegenerate?: () => void;
  onFeedback?: (value: "up" | "down") => void;
  children?: ReactNode;
}

const ACTIONS = [
  { key: "copy", icon: "content_copy", label: "复制" },
  { key: "regenerate", icon: "refresh", label: "重新生成" },
  { key: "up", icon: "thumb_up", label: "有帮助" },
  { key: "down", icon: "thumb_down", label: "没有帮助" },
] as const;

export function AssistantMessage({ messageId, turn, onCopy, onRegenerate, onFeedback, children }: AssistantMessageProps) {
  // done 后以结构化 body.reply 为真源；未 done（含 streaming/error/aborted）展示流式累积的 text，
  // 保证取消/错误后已生成内容不丢失（AC-003/AC-004）。
  const text = turn.phase === "done" ? (turn.body?.reply ?? turn.text) : turn.text;
  const settled = turn.phase === "done" || turn.phase === "error" || turn.phase === "aborted";
  const sources = turn.phase === "done" ? turn.body?.sources : undefined;

  const handleAction = (key: (typeof ACTIONS)[number]["key"]) => {
    if (key === "copy") onCopy?.(text);
    else if (key === "regenerate") onRegenerate?.();
    else if (key === "up") onFeedback?.("up");
    else onFeedback?.("down");
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-brand-primary text-[20px]" aria-hidden="true">
            smart_toy
          </span>
          <span className="font-label-sm text-label-sm text-text-primary font-bold">智修客服</span>
        </div>

        <p className="text-text-secondary leading-[1.6] md:leading-[1.7] whitespace-pre-wrap">{text}</p>

        {turn.phase === "error" && (
          <p className="text-safety-text text-[13px]">
            {turn.errorMessage ?? "回答生成失败，请重试。"}
          </p>
        )}

        {sources && sources.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            {sources.map((source, index) => (
              <span
                key={citationElementId(messageId, index)}
                id={citationElementId(messageId, index)}
                className="bg-citation-bg text-citation-text text-[12px] px-3 py-1.5 flex items-center gap-1 scroll-mt-20"
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  description
                </span>
                [{index + 1}] {source.title} · {source.section}
              </span>
            ))}
          </div>
        )}

        {children}

        {settled && (
          <div className="flex gap-4 mt-2 text-text-muted">
            {ACTIONS
              // 「重新生成」只在调用方明确传入 onRegenerate 时渲染——MessageList 只把
              // 它交给最后一条 AI 消息，历史消息不应出现一个点了没反应的按钮。
              .filter(({ key }) => key !== "regenerate" || onRegenerate)
              .map(({ key, icon, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleAction(key)}
                  className="hover:text-text-primary transition flex items-center gap-1 text-[12px]"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    {icon}
                  </span>
                  {label}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
