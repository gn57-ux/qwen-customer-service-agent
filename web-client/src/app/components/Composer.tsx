/**
 * 输入区（F-006～F-010）。快捷 chip 只填入输入框，不自动发送（F-007/AC-008）。
 */
import { useState } from "react";

const QUICK_PROMPTS = ["冰箱不制冷", "电视开机黑屏", "显示器无信号", "查询ORD1001"];

export interface ComposerProps {
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

export function Composer({ isStreaming, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <div className="absolute bottom-0 left-0 w-full bg-content-bg border-t border-border-color p-4 md:px-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-3">
        <div className="flex gap-2 mb-1 overflow-x-auto no-scrollbar">
          {QUICK_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setValue(prompt)}
              className="border border-border-color text-text-secondary text-[12px] px-3 py-1
                         hover:bg-brand-light-bg transition whitespace-nowrap"
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="relative border border-input-border bg-content-bg focus-within:border-brand-primary transition-colors">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            placeholder="请输入维修问题或订单号，例如：查询订单ORD1001"
            className="w-full bg-transparent border-none focus:ring-0 resize-none p-4 pb-12
                       text-text-primary font-body-md placeholder-text-muted no-scrollbar"
          />
          <div className="absolute bottom-3 right-3">
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="停止生成"
                className="bg-brand-primary text-content-bg p-2 hover:bg-brand-primary-hover
                           transition-colors flex items-center justify-center"
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  stop
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!value.trim()}
                aria-label="发送"
                className="bg-brand-primary text-content-bg p-2 hover:bg-brand-primary-hover
                           transition-colors flex items-center justify-center disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  arrow_upward
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="text-center text-[12px] text-text-muted">
          AI建议仅供初步排查，不可替代专业维修诊断。
        </div>
      </div>
    </div>
  );
}
