/**
 * 会话本期为前端本地状态，无持久化（design.md 模块 5）：每个会话持有各自独立的
 * `messages`，切换会话只切换"当前展示哪个会话的消息"，不清空任何一方的历史
 * （Codex Review P1：此前误用全局 `chat.reset()`，会在切换时丢弃其他会话内容）。
 */
import type { Message } from "./chat-types.ts";

export interface Session {
  id: string;
  title: string;
  messages: Message[];
}

export const DEFAULT_TITLE = "新会话";

export function createSession(title = DEFAULT_TITLE): Session {
  return { id: crypto.randomUUID(), title, messages: [] };
}

/** 会话标题取首条用户消息的截断文本（需求：设计稿左栏即为问题摘要）。 */
export function titleFromContent(content: string, maxLength = 20): string {
  const trimmed = content.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
