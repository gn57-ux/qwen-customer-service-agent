from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException


app = FastAPI(
    title="Customer Service Mock Backend",
    version="0.1.0",
)


ORDERS = {
    "ORD1001": {
        "order_id": "ORD1001",
        "status": "paid",
        "status_text": "已付款，等待仓库发货",
        "created_at": "2026-07-21T10:30:00+08:00",
        "carrier": None,
        "tracking_number": None,
        "latest_logistics": None,
        "estimated_delivery": None,
        "can_cancel": True,
        "customer_tip": "订单尚未出库，可为客户登记催发货。",
    },
    "ORD1002": {
        "order_id": "ORD1002",
        "status": "shipped",
        "status_text": "已发货，运输中",
        "created_at": "2026-07-20T09:15:00+08:00",
        "carrier": "顺丰速运",
        "tracking_number": "SF1234567890",
        "latest_logistics": "2026-07-23 16:20 已到达上海转运中心",
        "estimated_delivery": "2026-07-25",
        "can_cancel": False,
        "customer_tip": "物流正在正常运输，建议客户耐心等待。",
    },
    "ORD1003": {
        "order_id": "ORD1003",
        "status": "delayed",
        "status_text": "物流延误",
        "created_at": "2026-07-18T14:00:00+08:00",
        "carrier": "中通快递",
        "tracking_number": "ZT9876543210",
        "latest_logistics": "2026-07-21 08:40 因天气原因运输延误",
        "estimated_delivery": "2026-07-26",
        "can_cancel": False,
        "customer_tip": "物流存在延误，可为客户登记物流催办。",
    },
}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "customer-service-mock-backend",
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/orders/{order_id}")
def get_order(order_id: str):
    normalized_id = order_id.strip().upper()
    order = ORDERS.get(normalized_id)
    if order is None:
        raise HTTPException(
            status_code=404,
            detail=f"未找到订单 {normalized_id}",
        )
    return {
        "success": True,
        "data": order,
    }
