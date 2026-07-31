/**
 * 会话状态机（design.md 模块 1/2/3）。text（流式累积）与 body（结构化真源）分开
 * 存储；done 后一律以 body 为真源。取消/错误/提前结束三种非正常收尾都归一到
 * 确定的 phase，且都会触发 onSettled（供 feature 4 的 refresh() 在 done/error 后
 * 刷新顶栏——这里对 aborted 同样触发，属于保守选择：用户主动取消不代表服务状态
 * 一定健康，让顶栏借机重新探测没有坏处）。
 *
 * 受控 + 会话定向写入（Codex Review P1 修复）：本 hook 不再自己持有 `messages`，
 * 而是接收调用方（App.tsx）当前展示的会话 `messages`，写回时用 `onMessagesChange`
 * 显式指定目标会话 id——写入目标在 sendMessage/regenerate 发起的那一刻就已固定
 * （闭包捕获调用时的 sessionId），之后即使用户切换到别的会话，这个 turn 的后续
 * 事件仍然精确写回它本来所属的会话，不会因为"当前显示的是哪个会话"而串味或丢失。
 *
 * 同步收尾（Codex Review P2 修复 ×2）：`abortActiveTurn()` 是切换会话 / 用户点击
 * 停止 / 清空会话三处共用的唯一收尾入口——它不等 streamChat() 的 promise 真正
 * reject，而是立刻中断 turnToken、abort 底层请求、把消息 phase 同步落成
 * aborted、并把 isStreaming 拨回 false。这样：
 *   1. 切走会话时旧 turn 不会因为"新会话又立刻发了一条消息、token 已经前进"而
 *      永远卡在 streaming（此前的 bug：只 abort controller，指望异步 catch 里
 *      的 token 比对去补一个 aborted patch，但 token 早被新 turn 占用，异步
 *      catch 一进来就直接 return，patch 永远没发生）。
 *   2. 用户清空当前会话时，请求立刻释放、Composer 立刻解锁，不必等底层
 *      fetch/reader 的 abort 真正落地。
 * 真正的 streamChat() catch 分支仍然可能在这之后才触发，但那时 token 早已
 * 失效，catch 里的 token 比对会让它安全地什么都不做，不会覆盖这里已经写好的
 * 状态。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useClient } from "../client-context.tsx";
import { createIdleTurn, type AssistantMessageEntry, type Message, type UserMessage } from "../chat-types.ts";
import type { ChatHistoryTurn, StreamEvent } from "../../types.ts";

export type MessagesUpdater = (prev: Message[]) => Message[];

export interface UseChatStreamOptions {
  /** 当前展示的会话 id */
  sessionId: string;
  /** 当前展示的会话的消息（受控） */
  messages: Message[];
  /** 定向写回：调用方按 sessionId 更新对应会话的 messages，不依赖"当前哪个会话在展示" */
  onMessagesChange: (sessionId: string, updater: MessagesUpdater) => void;
  /** F-008 收尾：done/error（以及 aborted）之后触发，用于刷新顶栏服务状态 */
  onSettled?: () => void;
}

export interface UseChatStreamResult {
  /** 当前是否有流式请求在途——Composer 据此切换发送/停止态（F-013） */
  isStreaming: boolean;
  sendMessage: (content: string) => Promise<void>;
  /** 以最近一条用户消息为入参重新发起（AssistantMessage「重新生成」按钮） */
  regenerate: () => Promise<void>;
  cancel: () => void;
}

interface ActiveTurn {
  sessionId: string;
  assistantId: string;
}

function toHistory(messages: Message[]): ChatHistoryTurn[] {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : { role: "assistant", content: message.turn.body?.reply ?? message.turn.text },
  );
}

export function useChatStream(options: UseChatStreamOptions): UseChatStreamResult {
  const { sessionId, messages, onMessagesChange, onSettled } = options;
  const client = useClient();
  const [isStreaming, setIsStreaming] = useState(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // 每次发起 turn 分配一个新 token；异步事件回调只在自己仍是"最新一次 turn"时
  // 才允许写 state——防止取消/切换会话后又立刻发起新一轮时，旧 turn 的迟到
  // 事件覆盖新 turn（同一并发防护模式见 use-service-status.ts）。
  const turnTokenRef = useRef(0);
  // 当前在途 turn 归属哪个会话、对应哪条 assistant 消息——供 abortActiveTurn()
  // 在"只知道要收尾，不知道 token 是否已经失效"的场景下也能精确定位要写哪条消息。
  const activeTurnRef = useRef<ActiveTurn | null>(null);

  const abortActiveTurn = useCallback(
    (markAborted: boolean) => {
      const active = activeTurnRef.current;
      if (!active) return; // 没有在途 turn，没什么可收尾的，也不必触发 onSettled
      turnTokenRef.current += 1; // 让任何仍在途的异步事件/catch 自认过期，安全地什么都不做
      abortRef.current?.abort();
      abortRef.current = null;
      activeTurnRef.current = null;
      if (mountedRef.current) setIsStreaming(false);
      if (markAborted) {
        onMessagesChange(active.sessionId, (prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.id === active.assistantId
              ? { ...message, turn: { ...message.turn, phase: "aborted" } }
              : message,
          ),
        );
      }
      // 同步收尾绕过了 runTurn() 的 finally——它自己发现 token 已经不是最新就
      // 直接跳过 onSettled 了。这里必须替它补上，否则 done/error/aborted 三种
      // 收尾都该触发的顶栏 refresh() 唯独在"手动停止/切换会话中断"这条路径上
      // 永远不会发生（Codex Review P2）。
      onSettled?.();
    },
    [onMessagesChange, onSettled],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // 切换到另一个会话：旧会话若有在途流式请求，视为放弃——同步中断并把旧 turn
  // 标记为 aborted（不等异步 catch，见文件顶部注释）。
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      abortActiveTurn(true);
    }
  }, [sessionId, abortActiveTurn]);

  const patchTurn = useCallback(
    (targetSessionId: string, assistantId: string, token: number, patch: Partial<AssistantMessageEntry["turn"]>) => {
      if (!mountedRef.current || token !== turnTokenRef.current) return;
      onMessagesChange(targetSessionId, (prev) =>
        prev.map((message) =>
          message.role === "assistant" && message.id === assistantId
            ? { ...message, turn: { ...message.turn, ...patch } }
            : message,
        ),
      );
    },
    [onMessagesChange],
  );

  const runTurn = useCallback(
    async (targetSessionId: string, content: string, history: ChatHistoryTurn[], reuseAssistantId?: string) => {
      const token = ++turnTokenRef.current;
      const assistantId = reuseAssistantId ?? crypto.randomUUID();
      const freshTurn: AssistantMessageEntry["turn"] = { ...createIdleTurn(), phase: "streaming" };
      activeTurnRef.current = { sessionId: targetSessionId, assistantId };

      if (reuseAssistantId) {
        // 重新生成：替换同一条消息的 turn，不追加新消息——避免出现"同一问题
        // 两个版本回答"并存（design.md 开放问题：本期不做多版本切换）。
        onMessagesChange(targetSessionId, (prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.id === assistantId
              ? { ...message, turn: freshTurn }
              : message,
          ),
        );
      } else {
        const assistantMessage: AssistantMessageEntry = { id: assistantId, role: "assistant", turn: freshTurn };
        onMessagesChange(targetSessionId, (prev) => [...prev, assistantMessage]);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      if (targetSessionId === sessionId) setIsStreaming(true);

      const onEvent = (event: StreamEvent) => {
        switch (event.event) {
          case "meta":
            patchTurn(targetSessionId, assistantId, token, { traceId: event.data.traceId });
            break;
          case "tool-result":
            if (token !== turnTokenRef.current || !mountedRef.current) break;
            onMessagesChange(targetSessionId, (prev) =>
              prev.map((message) =>
                message.role === "assistant" && message.id === assistantId
                  ? { ...message, turn: { ...message.turn, toolCalls: [...message.turn.toolCalls, event.data] } }
                  : message,
              ),
            );
            break;
          case "text-delta":
            if (token !== turnTokenRef.current || !mountedRef.current) break;
            onMessagesChange(targetSessionId, (prev) =>
              prev.map((message) =>
                message.role === "assistant" && message.id === assistantId
                  ? { ...message, turn: { ...message.turn, text: message.turn.text + event.data.delta } }
                  : message,
              ),
            );
            break;
          case "done":
            // done 到达即结构化真源，与流式 text 一并写入（AC-002）
            patchTurn(targetSessionId, assistantId, token, { phase: "done", body: event.data });
            break;
          case "error":
            // 客户端 streamChat() 内部会把 error 事件转成 throw，这里不会真正走到；
            // 保留分支是为了 StreamEvent 的判别式穷尽，避免遗漏未来新增事件类型。
            break;
        }
      };

      try {
        await client.streamChat(content, history, onEvent, { signal: controller.signal });
      } catch (err) {
        // token 已经不是最新——说明这个 turn 已经被 abortActiveTurn()（切换会话/
        // 取消/清空）同步收尾过了，这里只是那次收尾之后姗姗来迟的 promise
        // rejection，什么都不用做，避免覆盖已经写好的状态。
        if (token !== turnTokenRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") {
          patchTurn(targetSessionId, assistantId, token, { phase: "aborted" });
        } else {
          const message = err instanceof Error ? err.message : "未知错误";
          patchTurn(targetSessionId, assistantId, token, { phase: "error", errorMessage: message });
        }
      } finally {
        // 只有仍是当前 turn 才收尾——superseded 的旧 turn 不重复触发 onSettled。
        if (token === turnTokenRef.current) {
          abortRef.current = null;
          activeTurnRef.current = null;
          if (mountedRef.current) setIsStreaming(false);
          onSettled?.();
        }
      }
    },
    [client, sessionId, onMessagesChange, onSettled, patchTurn],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (isStreaming) return;
      const trimmed = content.trim();
      if (!trimmed) return;

      const targetSessionId = sessionId;
      const userMessage: UserMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
      const history = toHistory(messages);
      onMessagesChange(targetSessionId, (prev) => [...prev, userMessage]);
      await runTurn(targetSessionId, trimmed, history);
    },
    [isStreaming, sessionId, messages, onMessagesChange, runTurn],
  );

  const regenerate = useCallback(async () => {
    if (isStreaming) return;
    const lastUser = [...messages].reverse().find((m): m is UserMessage => m.role === "user");
    if (!lastUser) return;
    const index = messages.lastIndexOf(lastUser);
    const history = toHistory(messages.slice(0, index));
    const existingAssistant = messages[index + 1];
    const reuseAssistantId = existingAssistant?.role === "assistant" ? existingAssistant.id : undefined;
    await runTurn(sessionId, lastUser.content, history, reuseAssistantId);
  }, [isStreaming, sessionId, messages, runTurn]);

  // 用户点击「停止」（F-013）：同步收尾并标记 aborted，不等底层 promise 真正 reject。
  const cancel = useCallback(() => {
    abortActiveTurn(true);
  }, [abortActiveTurn]);

  return { isStreaming, sendMessage, regenerate, cancel };
}
