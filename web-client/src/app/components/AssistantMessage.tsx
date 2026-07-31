/**
 * AI 消息（F-001~F-008）。按 `resolveSlots()` 决定安全卡/订单卡/引用角标是否
 * 渲染——不是靠外部 children 注入（feature 5 预留的插槽在 feature 6/7 落地时
 * 改为组件内部按结构化字段判定，理由见 scenarios/render-slots.ts）。
 *
 * ⛔ 正文渲染禁止 dangerouslySetInnerHTML（design.md 安全考虑）：用
 * `whitespace-pre-wrap` 让 `\n` 自然换行，不解析设计稿里的 `<br>`。
 *
 * 引用角标（feature 6 F-009 的开放问题resolution）：右栏「引用来源」列表点击
 * 需要滚动定位到这里渲染的角标，双方共用 `citationElementId(messageId, index)`
 * 生成同一个 id，不能各写一份格式字符串。图标按 route 区分：safety 用
 * `security`，其余（含 repair）用 `description`（F-003/F-004）。
 */
import { citationElementId } from "../citation.ts";
import { resolveSlots } from "../scenarios/render-slots.ts";
import type { AssistantTurn } from "../chat-types.ts";
import { OrderCard } from "./OrderCard.tsx";
import { SafetyCard } from "./SafetyCard.tsx";

export interface AssistantMessageProps {
  /** 本消息的稳定 id——用于生成引用角标锚点，供右栏 SourceList 点击滚动定位 */
  messageId: string;
  turn: AssistantTurn;
  onCopy?: (text: string) => void;
  onRegenerate?: () => void;
  onFeedback?: (value: "up" | "down") => void;
}

const ACTIONS = [
  { key: "copy", icon: "content_copy", label: "复制" },
  { key: "regenerate", icon: "refresh", label: "重新生成" },
  { key: "up", icon: "thumb_up", label: "有帮助" },
  { key: "down", icon: "thumb_down", label: "没有帮助" },
] as const;

export function AssistantMessage({ messageId, turn, onCopy, onRegenerate, onFeedback }: AssistantMessageProps) {
  // done 后以结构化 body.reply 为真源；未 done（含 streaming/error/aborted）展示流式累积的 text，
  // 保证取消/错误后已生成内容不丢失（AC-003/AC-004）。
  const body = turn.phase === "done" ? turn.body : undefined;
  const text = body?.reply ?? turn.text;
  const settled = turn.phase === "done" || turn.phase === "error" || turn.phase === "aborted";
  const slots = body ? resolveSlots(body) : { safetyCard: false, orderCard: false, citations: false };
  const citationIcon = body?.route === "safety" ? "security" : "description";

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

        {/* F-004：safety 场景正文必须以安全卡呈现，话术就是服务端 reply 本身，不额外硬编码 */}
        {slots.safetyCard ? (
          <SafetyCard text={text} />
        ) : (
          <p className="text-text-secondary text-[15px] md:text-[16px] leading-[1.6] md:leading-[1.7] whitespace-pre-wrap">
            {text}
          </p>
        )}

        {/* F-008：error 卡追加在（可能不完整的）正文之后，不替换正文 */}
        {turn.phase === "error" && (
          <div className="border border-safety-border bg-safety-bg p-3">
            <div className="flex items-center gap-2 text-safety-text font-bold">
              <span className="material-symbols-outlined" aria-hidden="true">
                warning
              </span>
              回复生成失败
            </div>
            <p className="text-[14px] text-safety-text mt-1">{turn.errorMessage ?? "未知错误"}</p>
            {turn.traceId && <p className="text-[12px] text-text-muted mt-1">{turn.traceId}</p>}
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="mt-2 flex items-center gap-1 text-[12px] text-safety-text hover:opacity-80 transition"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  refresh
                </span>
                重试
              </button>
            )}
          </div>
        )}

        {slots.orderCard && body?.order && <OrderCard order={body.order} onRetry={onRegenerate} />}

        {slots.citations && (
          <div className="flex flex-wrap gap-2 mt-4">
            {body!.sources!.map((source, index) => (
              <span
                key={citationElementId(messageId, index)}
                id={citationElementId(messageId, index)}
                className="bg-citation-bg text-citation-text text-[12px] px-3 py-1.5 flex items-center gap-1 scroll-mt-20"
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  {citationIcon}
                </span>
                [{index + 1}] {source.title} · {source.section}
              </span>
            ))}
          </div>
        )}

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
