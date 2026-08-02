/**
 * 执行链路时间轴（F-004/F-006）。竖线 + 节点圆点，圆点 0 圆角由全局样式保证。
 * key 用 label 而不是数组下标——done 覆盖重建时（feature 6 T-007）React 才能按
 * 内容复用已有 DOM 节点，避免整体卸载重建产生可见闪烁（design.md 模块 3）。
 *
 * 同一工具被重复调用（重试/多次查订单）时，多个节点 label 完全相同——单纯用
 * label 当 key 会撞车。按"这个 label 是第几次出现"生成 key 后缀：只要调用顺序
 * 不变，interim（仅 tool-result）与 done（全量覆盖）两次渲染里同一次调用算出
 * 的出现次序相同，key 依然稳定，不影响 DOM 复用（Codex Review P2）。
 */
import type { EvidenceStep } from "../evidence/derive.ts";

function withOccurrenceKeys(steps: EvidenceStep[]): Array<EvidenceStep & { key: string }> {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = (seen.get(step.label) ?? 0) + 1;
    seen.set(step.label, occurrence);
    return { ...step, key: `${step.label}#${occurrence}` };
  });
}

const DOT_CLASS: Record<EvidenceStep["tone"], string> = {
  success: "bg-success-green",
  brand: "bg-brand-primary",
  safety: "bg-safety-text",
};

const TEXT_CLASS: Record<EvidenceStep["tone"], string> = {
  success: "text-text-primary",
  brand: "text-text-primary",
  safety: "text-safety-text",
};

export interface StepTimelineProps {
  steps: EvidenceStep[];
  emptyText: string;
}

export function StepTimeline({ steps, emptyText }: StepTimelineProps) {
  return (
    <div>
      <h4 className="text-text-muted mb-3 text-[12px] uppercase tracking-wider">执行链路</h4>
      {steps.length === 0 ? (
        <p className="text-text-muted text-[13px]">{emptyText}</p>
      ) : (
        <ul className="space-y-4 border-l border-border-color ml-2 pl-4 py-1">
          {withOccurrenceKeys(steps).map((step) => (
            <li key={step.key} className="relative">
              <span className={`absolute -left-[21px] top-1 w-2 h-2 block ${DOT_CLASS[step.tone]}`} />
              <span className={`${TEXT_CLASS[step.tone]} ${step.bold ? "font-bold" : ""}`}>{step.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
