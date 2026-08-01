/**
 * 处理依据右栏（design.md 模块 2/3/4）。固定 320px（Stitch v2 起不再有
 * xl 断点前的 300px 中间态），断点 `min-[1100px]`（⛔ 不是 lg/1024，见
 * LESSONS 风险点）。
 *
 * 三态：
 *   1. 当前会话还没有任何 AI 消息 → 整体空状态（F-013）。
 *   2. 有消息但还没 done（streaming/error/aborted 且无 body）→ 只展示
 *      tool-result 累积出的临时链路节点，模式卡/引用来源不出现（design.md
 *      模块 3：这些字段只在结构化 body 里才有，流式阶段没有就是没有，不能猜）。
 *      error 收尾额外追加一个红色「已中断 · 生成失败」节点（F-008）。
 *   3. done 且有 body → deriveEvidence(body) 全量覆盖重建。
 *
 * `EvidencePanelContent` 单独导出——feature 7 的右侧抽屉（<1100px）复用同一份
 * 内容组件，只是外层容器不同，避免抽屉与右栏两份实现逐渐不一致（design.md
 * 模块 4："关键：复用而非复制"）。
 */
import type { AssistantTurn } from "../chat-types.ts";
import { deriveEvidence, deriveInterimSteps, type EvidenceView } from "../evidence/derive.ts";
import { EvidenceFooter } from "./EvidenceFooter.tsx";
import { EvidenceHeader } from "./EvidenceHeader.tsx";
import { ModeCard } from "./ModeCard.tsx";
import { SourceList } from "./SourceList.tsx";
import { StepTimeline } from "./StepTimeline.tsx";

const EMPTY_STEPS_TEXT = "暂无处理记录，发送问题后展示执行链路";
const EMPTY_SOURCES_TEXT = "本次回答未引用知识库";

export interface RightPanelProps {
  /** 当前会话最近一条 AI 消息的 turn；没有任何 AI 消息时传 undefined */
  turn?: AssistantTurn;
  /** 该 turn 所属消息的 id——供「引用来源」点击滚动定位到正文角标 */
  messageId?: string;
}

export function EvidencePanelContent({ turn, messageId }: RightPanelProps) {
  return (
    <>
      <EvidenceHeader />
      {!turn ? (
        <>
          <div className="flex-1 overflow-y-auto p-6 font-code text-code no-scrollbar">
            <p className="text-text-muted text-[13px]">{EMPTY_STEPS_TEXT}</p>
          </div>
          <EvidenceFooter />
        </>
      ) : turn.phase === "done" && turn.body ? (
        <PanelBody view={deriveEvidence(turn.body)} messageId={messageId} />
      ) : (
        <PanelBody
          view={{
            steps:
              turn.phase === "error"
                ? [
                    ...deriveInterimSteps(turn.toolCalls),
                    { label: "已中断 · 生成失败", tone: "safety", bold: true },
                  ]
                : deriveInterimSteps(turn.toolCalls),
            modes: [],
            sources: [],
            traceId: turn.traceId ?? "",
            latencyText: "",
          }}
          interim
        />
      )}
    </>
  );
}

export function RightPanel({ turn, messageId }: RightPanelProps) {
  return (
    <aside
      className="hidden min-[1100px]:flex w-[320px] bg-sidebar-right-bg
                 border-l border-border-color/60 flex-col h-full flex-shrink-0"
    >
      <EvidencePanelContent turn={turn} messageId={messageId} />
    </aside>
  );
}

interface PanelBodyProps {
  view: EvidenceView;
  interim?: boolean;
  messageId?: string;
}

function PanelBody({ view, interim = false, messageId }: PanelBodyProps) {
  return (
    <>
      <div className="flex-1 overflow-y-auto p-6 space-y-8 font-code text-code no-scrollbar">
        <StepTimeline steps={view.steps} emptyText={EMPTY_STEPS_TEXT} />
        {!interim && (
          <>
            <ModeCard modes={view.modes} degradedReason={view.degradedReason} />
            <SourceList sources={view.sources} emptyText={EMPTY_SOURCES_TEXT} messageId={messageId} />
          </>
        )}
      </div>
      <EvidenceFooter traceId={interim ? view.traceId || undefined : view.traceId} latencyText={interim ? undefined : view.latencyText} />
    </>
  );
}
