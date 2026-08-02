/**
 * F-004/F-005：三项服务状态只能来自 client.status()，⛔ 不得根据聊天结果推断，
 * ⛔ 初始不得乐观预设 online——挂载完成前三项一律 unknown。
 * F-007：status() 失败时落为三项 error，catch 内不重新抛出，避免未捕获 rejection。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useClient } from "../client-context.tsx";
import type { ServiceStatusBody } from "../../types.ts";

const INITIAL: ServiceStatusBody = {
  localModel: "unknown",
  knowledgeBase: "unknown",
  orderService: "unknown",
};

const ERROR_STATE: ServiceStatusBody = {
  localModel: "error",
  knowledgeBase: "error",
  orderService: "error",
};

/** F-008 可选轮询间隔：≥30s，页面隐藏时暂停 */
const POLL_INTERVAL_MS = 30_000;

export interface UseServiceStatusResult {
  data: ServiceStatusBody;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useServiceStatus(): UseServiceStatusResult {
  const client = useClient();
  const [data, setData] = useState<ServiceStatusBody>(INITIAL);
  const [loading, setLoading] = useState(true);
  // 防止组件已卸载后异步 status() 返回时仍 setState
  const mountedRef = useRef(true);
  // 轮询与手动/聊天触发的 refresh() 可能并发：只有"最新一次发起的请求"
  // 的结果才允许写入 state，防止慢的旧请求在新请求之后落地，覆盖新状态
  // 或把 loading 提前置回 false。
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await client.status();
      if (mountedRef.current && requestId === requestIdRef.current) setData(result);
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) setData(ERROR_STATE);
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { data, loading, refresh };
}
