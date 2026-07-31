/**
 * 订单卡片（F-001/F-002a~d）。⛔ 只读 `order.details` 白名单，禁止解析
 * `toolCalls[].result`——本文件不导入 `ToolCallRecord`，从类型层面杜绝这条路。
 */
import { deriveOrderView } from "../scenarios/order-view.ts";
import type { OrderDetails, OrderStatus } from "../../types.ts";

export interface OrderCardProps {
  order: OrderStatus;
  onRetry?: () => void;
}

interface DetailRow {
  key: keyof OrderDetails;
  label: string;
  format?: (details: OrderDetails) => string | null;
}

// 10 个可空字段全部走这张表——任何一项为 null/undefined 就隐藏该行，
// ⛔ 不填默认值（编造订单信息会误导坐席与客户）。
const DETAIL_ROWS: DetailRow[] = [
  { key: "orderId", label: "订单号" },
  {
    key: "statusText",
    label: "状态",
    // 优先展示 statusText，两者皆空则该行由 format 返回 null 自动隐藏
    format: (d) => d.statusText ?? d.status ?? null,
  },
  { key: "createdAt", label: "下单时间" },
  { key: "carrier", label: "承运商" },
  { key: "trackingNumber", label: "运单号" },
  { key: "latestLogistics", label: "最新物流" },
  { key: "estimatedDelivery", label: "预计送达" },
  {
    key: "canCancel",
    label: "可取消",
    // null 表示"不确定"，不是"不能"——⛔ 不当作 false，直接隐藏该行
    format: (d) => (d.canCancel === null ? null : d.canCancel ? "是" : "否"),
  },
  { key: "customerTip", label: "坐席提示" },
];

function DetailList({ details }: { details: OrderDetails }) {
  return (
    <dl className="mt-3 space-y-1 text-[13px]">
      {DETAIL_ROWS.map(({ key, label, format }) => {
        const value = format ? format(details) : (details[key] as string | boolean | null);
        if (value === null || value === undefined || value === "") return null;
        return (
          <div key={key} className="flex gap-2">
            <dt className="text-text-muted">{label}</dt>
            <dd className="text-text-primary">{String(value)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function OrderCard({ order, onRetry }: OrderCardProps) {
  const view = deriveOrderView(order);

  if (view.kind === "error") {
    return (
      <div className="border border-safety-border bg-safety-bg p-4">
        <div className="flex items-center gap-2 text-safety-text font-bold">
          <span className="material-symbols-outlined" aria-hidden="true">
            warning
          </span>
          {view.text}
        </div>
        {view.retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 flex items-center gap-1 text-[12px] text-safety-text hover:opacity-80 transition"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              refresh
            </span>
            重试
          </button>
        )}
      </div>
    );
  }

  const borderClass = "border-l-2 border-l-success-green";

  return (
    <div className={`bg-content-bg border border-border-color p-4 ${borderClass}`}>
      {view.kind === "partial" && (
        <p className="text-[12px] text-safety-text">部分信息缺失：{view.missing.join("、")}</p>
      )}
      {/* F-002c：details 为 undefined（found:false 但无 error，理论边界）时只渲染状态卡，不渲染详情区 */}
      {order.details && <DetailList details={order.details} />}
    </div>
  );
}
