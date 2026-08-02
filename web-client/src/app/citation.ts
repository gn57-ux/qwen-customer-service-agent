/**
 * 引用角标 id 的唯一生成规则，供 AssistantMessage（渲染角标）与 SourceList
 * （右栏点击滚动定位）共用——集中一处，避免两边各写一份格式字符串导致漂移。
 */
export function citationElementId(messageId: string, index: number): string {
  return `citation-${messageId}-${index}`;
}
