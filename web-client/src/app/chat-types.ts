/**
 * design.md 模块 1：text（流式累积）与 body（结构化真源）分开存储——
 * done 到达后正文以 body.reply 为准覆盖，右栏（feature 6）一律读 body，
 * ⛔ 不得从 text 反推任何状态（安全提示/引用来源等）。
 */
import type { ChatResponseBody, ToolCallRecord } from "../types.ts";

export type TurnPhase = "idle" | "streaming" | "done" | "error" | "aborted";

export interface AssistantTurn {
  phase: TurnPhase;
  traceId?: string;
  text: string;
  toolCalls: ToolCallRecord[];
  body?: ChatResponseBody;
  errorMessage?: string;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
}

export interface AssistantMessageEntry {
  id: string;
  role: "assistant";
  turn: AssistantTurn;
}

export type Message = UserMessage | AssistantMessageEntry;

export function createIdleTurn(): AssistantTurn {
  return { phase: "idle", text: "", toolCalls: [] };
}
