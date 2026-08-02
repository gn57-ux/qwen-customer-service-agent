/**
 * client.ts 单例注入点：全站唯一允许访问 Mastra 的通道经 useClient() 下发。
 * 组件层禁止绕过 useClient() 自行发起网络请求或直连其他后端服务，
 * 只能通过这里下发的实例访问 Mastra。
 *
 * baseUrl 只允许指向 Mastra（默认 :4111），不得配置任何其他被禁服务端口。
 */
import { createContext, useContext, type ReactNode } from "react";

import { createCustomerServiceClient, type CustomerServiceClient } from "../client.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:4111";

function resolveBaseUrl(): string {
  const configured = import.meta.env.VITE_MASTRA_BASE_URL;
  return configured && configured.trim().length > 0 ? configured : DEFAULT_BASE_URL;
}

// 模块级单例：只在真正需要时（未被测试注入 mock 时）惰性创建一次，
// 不随 ClientProvider 的每次渲染重建。
let singleton: CustomerServiceClient | null = null;

function getDefaultClient(): CustomerServiceClient {
  if (!singleton) {
    singleton = createCustomerServiceClient({ baseUrl: resolveBaseUrl() });
  }
  return singleton;
}

const ClientContext = createContext<CustomerServiceClient | null>(null);

export interface ClientProviderProps {
  children: ReactNode;
  /** 测试专用：注入 mock client，替代真实的 createCustomerServiceClient() 单例 */
  client?: CustomerServiceClient;
}

export function ClientProvider({ children, client }: ClientProviderProps) {
  const value = client ?? getDefaultClient();
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient(): CustomerServiceClient {
  const client = useContext(ClientContext);
  if (!client) {
    throw new Error("useClient() 必须在 <ClientProvider> 内部使用");
  }
  return client;
}
