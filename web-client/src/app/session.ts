/**
 * 会话本期为前端本地状态，无持久化（design.md 模块 5）。messages 的具体消息形状
 * 由 feature 5 定义并填充，这里先留 unknown[]，避免抢先定义尚未落地的聊天契约。
 */
export interface Session {
  id: string;
  title: string;
  messages: unknown[];
}

export function createSession(title = "新会话"): Session {
  return { id: crypto.randomUUID(), title, messages: [] };
}
