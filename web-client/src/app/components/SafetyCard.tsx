/**
 * 安全提示卡（F-004）。⛔ 话术全部来自服务端正文（`text` 参数即 body.reply），
 * 前端不硬编码任何安全建议——避免前端话术与服务端安全策略不一致。
 */
export interface SafetyCardProps {
  text: string;
}

export function SafetyCard({ text }: SafetyCardProps) {
  return (
    <div className="border border-safety-border bg-safety-bg my-4 p-3">
      <div className="flex items-center gap-2 mb-1 text-safety-text">
        <span className="material-symbols-outlined" aria-hidden="true">
          warning
        </span>
        <span className="font-bold">安全提示</span>
      </div>
      <p className="text-safety-text text-[14px] leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}
