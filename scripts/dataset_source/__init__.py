"""电商家电售后客服正式训练数据源。

每个类别一个模块，模块内以 ``I(...)`` 声明单条样本，样本自带 split 归属，
保证同一场景不会被改写后同时进入 train / validation / test。
"""

from . import (
    complaint_escalation,
    injection_degradation,
    monitor,
    order_logistics,
    refrigerator,
    return_refund,
    safety_refusal,
    television,
    warranty_service,
)

# 声明顺序即为审计报告中的类别顺序。
MODULES = (
    refrigerator,
    television,
    monitor,
    order_logistics,
    return_refund,
    warranty_service,
    complaint_escalation,
    safety_refusal,
    injection_degradation,
)


def all_items():
    """按类别顺序返回全部样本。"""
    items = []
    for module in MODULES:
        items.extend(module.ITEMS)
    return items
