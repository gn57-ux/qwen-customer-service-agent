/**
 * 安全提示卡（F-004）。⛔ 话术全部来自服务端正文（`text` 参数即 body.reply），
 * 前端不硬编码任何安全建议——避免前端话术与服务端安全策略不一致。
 *
 * Stitch v2 颜色不是 `safety-*` 三个具名 token（`#A14D45`/`#FBEDEA`/
 * `#E7B8B2`），而是新稿实际截图/HTML 里的独立任意值（`#F2C5BE`/
 * `#FDF5F3`/`#C55B51`）——design.md 已记录这个疑问并按"浏览器最终像素
 * 以新稿为准"裁定：这是新旧稿之间的颜色微调，不是需要保留的第二套配色，
 * 按新稿任意值实施。
 */
export interface SafetyCardProps {
  text: string;
}

export function SafetyCard({ text }: SafetyCardProps) {
  return (
    <div className="border border-[#F2C5BE] bg-[#FDF5F3] rounded-[12px] border-l-[3px] border-l-[#C55B51] shadow-soft my-5 p-4 flex gap-3 items-start">
      <span aria-hidden="true" className="material-symbols-outlined text-[#C55B51] text-[20px] shrink-0">
        warning
      </span>
      <div>
        <div className="font-bold text-[#C55B51] mb-1">安全提示</div>
        <p className="text-[#C55B51] text-[14px] leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}
