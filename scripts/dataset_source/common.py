"""样本声明结构与允许的 System Prompt 版本。"""

# ---------------------------------------------------------------------------
# 允许的 System Prompt 版本
# ---------------------------------------------------------------------------
# 正式数据集只允许使用 base / safety / tools 三个版本。
# legacy_smoke 是 20 条冒烟数据里使用的旧版本，仅用于兼容审计，不用于正式数据。

SYSTEM_PROMPTS = {
    "base": (
        "你是家电电商平台的售后客服助手。回答要简洁、准确、可执行："
        "先判断用户意图，缺少关键信息时先追问，再给出明确的下一步。"
        "订单、物流、退款等实时状态必须通过系统查询，维修方法与售后政策必须来自知识库，不得凭空编造。"
        "超出客服权限时说明原因并转人工。"
    ),
    "safety": (
        "你是家电电商平台的售后客服助手，负责冰箱、彩电、显示器等品类的售后咨询。"
        "只能指导用户做断电、免拆机的外部检查；涉及拆机、打开后盖、高压部件、压缩机、制冷剂或带电检测时必须拒绝并引导专业售后。"
        "出现冒烟、焦味、漏电、异响或燃烧迹象时，先让用户断电停用并远离设备。"
        "不得编造维修结论、故障原因或产品参数。"
    ),
    "tools": (
        "你是家电电商平台的售后客服助手，可以调用订单系统查询订单、物流与退款状态，"
        "并检索知识库获取保修、退换货、发票与安装政策。"
        "信息不足时先索要必要信息；查询无结果或接口异常时如实说明并给出替代路径，不得猜测状态或承诺时效。"
        "涉及赔付、加急、特批等超出权限的事项转人工处理。"
    ),
    "legacy_smoke": (
        "你是专业、耐心、克制的电商客服。先确认问题或承接情绪，再说明所需信息，最后给出下一步。"
        "不得编造订单、物流、库存或退款状态。"
    ),
}

PRODUCTION_SYSTEM_KEYS = ("base", "safety", "tools")

# ---------------------------------------------------------------------------
# 枚举
# ---------------------------------------------------------------------------

SPLITS = ("train", "validation", "test")

CATEGORIES = (
    "refrigerator",
    "television",
    "monitor",
    "order_logistics",
    "return_refund",
    "warranty_service",
    "complaint_escalation",
    "safety_refusal",
    "injection_degradation",
)

CATEGORY_LABELS = {
    "refrigerator": "冰箱维修咨询",
    "television": "彩电维修咨询",
    "monitor": "显示器维修咨询",
    "order_logistics": "订单查询与物流异常",
    "return_refund": "退货退款与换货",
    "warranty_service": "保修、安装预约、发票与支付",
    "complaint_escalation": "投诉、情绪安抚与转人工",
    "safety_refusal": "安全边界与危险操作拒绝",
    "injection_degradation": "提示注入、越权与异常降级",
}

# 每个类别都必须覆盖下列全部场景类型。
SCENARIOS = (
    "normal",  # 正常问题
    "insufficient_info",  # 信息不足，需要澄清追问
    "vague",  # 模糊表达
    "typo",  # 错别字或口语
    "angry",  # 用户情绪激动
    "multi_intent",  # 多意图
    "boundary",  # 边界条件
    "unverifiable",  # 无法确认的事实
    "multi_turn",  # 多轮上下文、指代、纠正、需求变化
)

REQUIRED_SCENARIOS = SCENARIOS  # 九种场景类型全部为必需覆盖项

RISK_LEVELS = ("low", "medium", "high")

_NEED_MAP = {
    "-": (False, False),
    "r": (True, False),
    "t": (False, True),
    "rt": (True, True),
}

# 需要 Tool 的样本统一指向 Mastra 侧的订单查询工具。
# 该元数据只用于审计与 Agent 评测，不代表 assistant 可以凭空生成订单结果。
DEFAULT_EXPECTED_TOOL = "queryOrderTool"

# 训练数据里禁止出现的订单号：它们是 Mock 后端与 Agent 集成测试的固定用例，
# 一旦进入 QLoRA 数据就会被模型当成静态事实记住。
RESERVED_ORDER_IDS = ("ORD1001", "ORD1002", "ORD1003", "ORD9999")

# 工具返回块的标记。带该标记的用户轮表示“订单系统已经把结果交给客服”，
# 此时 assistant 复述其中的状态属于有依据的转述，而不是编造。
TOOL_RESULT_MARK = "[订单系统返回]"


def I(uid, split, category, scenario, risk, need, system_key, *turns):
    """声明一条样本。

    uid         唯一编号
    split       train / validation / test
    category    见 CATEGORIES
    scenario    见 SCENARIOS
    risk        low / medium / high
    need        "-" 无外部依赖 / "r" 需要 RAG / "t" 需要 Tool / "rt" 两者都要
    system_key  base / safety / tools
    turns       user, assistant, user, assistant ... 交替，必须成对
    """
    if split not in SPLITS:
        raise ValueError(f"{uid}: 非法 split {split!r}")
    if category not in CATEGORIES:
        raise ValueError(f"{uid}: 非法 category {category!r}")
    if scenario not in SCENARIOS:
        raise ValueError(f"{uid}: 非法 scenario {scenario!r}")
    if risk not in RISK_LEVELS:
        raise ValueError(f"{uid}: 非法 risk {risk!r}")
    if need not in _NEED_MAP:
        raise ValueError(f"{uid}: 非法 need {need!r}")
    if system_key not in PRODUCTION_SYSTEM_KEYS:
        raise ValueError(f"{uid}: 非法 system_key {system_key!r}")
    if not turns or len(turns) % 2 != 0:
        raise ValueError(f"{uid}: turns 必须为 user/assistant 成对出现")

    requires_rag, requires_tool = _NEED_MAP[need]
    turns = list(turns)
    item = {
        "uid": uid,
        "split": split,
        "category": category,
        "scenario": scenario,
        "risk_level": risk,
        "requires_rag": requires_rag,
        "requires_tool": requires_tool,
        "system_key": system_key,
        "turns": turns,
        # 用户轮里带工具返回块的样本，训练的是“依据工具输出组织回复”，
        # 而不是让模型记住某个订单的状态。
        "tool_result_grounded": any(TOOL_RESULT_MARK in t for t in turns[::2]),
    }
    if requires_tool:
        item["expected_tool"] = DEFAULT_EXPECTED_TOOL
    return item


def to_record(item):
    """把样本转换为 ShareGPT/messages 训练格式。"""
    messages = [{"role": "system", "content": SYSTEM_PROMPTS[item["system_key"]]}]
    for index, text in enumerate(item["turns"]):
        role = "user" if index % 2 == 0 else "assistant"
        messages.append({"role": role, "content": text})
    return {"messages": messages}
