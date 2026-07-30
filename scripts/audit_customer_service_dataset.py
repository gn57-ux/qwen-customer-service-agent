#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""电商客服正式训练数据集审计脚本。

用法：
    python3 scripts/audit_customer_service_dataset.py
    python3 scripts/audit_customer_service_dataset.py --json out.json

检查项：
     1. JSON 格式可解析、结构正确
     2. 角色顺序：system 在首位，随后 user/assistant 严格交替并以 assistant 结尾
     3. 空内容 / 纯空白内容
     4. 完全重复的样本（整条记录）
     5. 用户问题重复（首轮 user 文本）
     6. assistant 回答重复
     7. 跨数据集完全重复
     8. 跨数据集近似重复（字符三元组 Jaccard）
     9. 订单号格式与隐私信息（手机号、证件号、邮箱、地址、长数字串）
    10. 危险维修建议关键词（拆机/高压/制冷剂/带电等是否被写成可执行步骤）
    11. 数据数量与类别、场景、风险等级分布
    12. train / validation / test 泄漏
    13. 文本长度异常（过短、过长、超出 cutoff_len 预算）
    14. system prompt 是否一致或属于允许版本

附加检查（按职责边界要求追加）：
    15. 保留订单号（Mock 后端与 Agent 集成测试用例）不得进入训练数据
    16. assistant 不得编造动态事实（订单状态、物流节点、预计送达、退款到账）
    17. requires_tool 样本必须带 expected_tool 元数据
    18. 每个类别必须覆盖全部场景类型，并同时包含需要 RAG 与需要 Tool 的样本
    19. assistant 开头多样性（禁止绝大多数回复同一个开头）
    20. 数据源模块与已生成 JSON 的往返一致性
    21. manifest 聚合统计与实际数据一致
    22. assistant 不得只是复述用户问题
    23. 工具/检索结果只能出现在 observation 角色，user/assistant 出现标记即 FAIL
    24. assistant 只能依据最近一次 observation 转述状态字段
    25. observation 中的订单号必须与上下文当前订单号一致
    26. 无 observation 依据时不得断言维修归因、操作路径、维修量值或政策结论
    27. 知识库引用的 doc / version / 章节必须能解析到 knowledge/ 下的真实文档

任一检查判定为 FAIL 时返回非零退出码。
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from dataset_source import all_items  # noqa: E402
from dataset_source.common import (  # noqa: E402
    CATEGORIES,
    CATEGORY_LABELS,
    PRODUCTION_SYSTEM_KEYS,
    REQUIRED_SCENARIOS,
    RAG_RESULT_MARK,
    RESERVED_ORDER_IDS,
    RESULT_MARKS,
    RISK_LEVELS,
    SCENARIOS,
    SPLITS,
    SYSTEM_PROMPTS,
    TOOL_RESULT_MARK,
    to_record,
)

DATASETS_DIR = REPO_ROOT / "datasets"
SPLIT_FILES = {
    "train": "customer-service-train-640.json",
    "validation": "customer-service-validation-80.json",
    "test": "customer-service-test-80.json",
}
SMOKE_FILE = "customer-service-smoke-20.json"
MANIFEST_FILE = "customer-service-dataset-manifest.json"

EXPECTED_SPLIT_COUNT = {"train": 640, "validation": 80, "test": 80}
EXPECTED_CATEGORY_COUNT = {
    "refrigerator": 160,
    "television": 120,
    "monitor": 120,
    "order_logistics": 100,
    "return_refund": 100,
    "warranty_service": 80,
    "complaint_escalation": 50,
    "safety_refusal": 40,
    "injection_degradation": 30,
}

# ---------------------------------------------------------------------------
# 阈值
# ---------------------------------------------------------------------------
CROSS_SPLIT_NEAR_DUP_FAIL = 0.70   # 跨 split 近似重复判失败
CROSS_SPLIT_NEAR_DUP_WARN = 0.58   # 跨 split 近似重复告警
IN_SPLIT_NEAR_DUP_FAIL = 0.85      # 同 split 内近似重复判失败
USER_MIN_CHARS = 3
USER_MAX_CHARS = 300
ASSISTANT_MIN_CHARS = 20
ASSISTANT_MAX_CHARS = 500
RECORD_MAX_CHARS = 1600            # 与 cutoff_len 1536 留出余量
PREFIX_LEN = 5
PREFIX_MAX_RATIO = 0.35

# ---------------------------------------------------------------------------
# 正则
# ---------------------------------------------------------------------------
ORDER_TOKEN_RE = re.compile(
    r"(?:TEST-ORDER|ORDER|ORD|YD|SF|JD|YT|ZT|STO|EMS)[-_]?\d+", re.IGNORECASE
)
ALLOWED_ORDER_RE = [
    re.compile(r"^ORD\d{2,7}$"),
    re.compile(r"^TEST-ORDER-\d{3}$"),
]
LEGACY_ORDER_RE = [re.compile(r"^YD\d{12,14}$")]  # 仅 20 条冒烟数据允许的旧格式

PRIVACY_PATTERNS = [
    ("手机号", re.compile(r"1[3-9]\d{9}")),
    ("身份证号(18位)", re.compile(r"\d{17}[\dXx]")),
    ("身份证号(15位)", re.compile(r"(?<!\d)\d{15}(?!\d)")),
    ("邮箱地址", re.compile(r"[\w.+-]+@[\w-]+\.[A-Za-z]{2,}")),
    ("银行卡号", re.compile(r"(?<!\d)\d{16,19}(?!\d)")),
    ("门牌地址", re.compile(r"\d+\s*(?:号楼|栋楼|单元|室\b)")),
    ("详细地址", re.compile(r"[省市区县][^，。；\s]{0,8}(?:路|街|巷|大道)\d+号")),
]
FORBIDDEN_NAMES = ("张三", "李四", "王五", "赵六", "小明", "小红")
BARE_DIGIT_RUN_RE = re.compile(r"(?<!\d)\d{11,}(?!\d)")

DANGEROUS_KEYWORDS = (
    "拆机", "拆开", "拆下", "拆卸", "后盖", "机壳", "开壳", "高压", "压缩机",
    "制冷剂", "冷媒", "加氟", "排氟", "电源板", "电源版", "主板", "保护装置",
    "带电", "短接", "飞线", "内部电路", "电容", "高压包", "背光灯条", "排线",
    "电路图", "改接", "变压器", "拆解",
)
PROHIBITION_MARKERS = (
    "不要", "请勿", "切勿", "严禁", "禁止", "不得", "不能", "不会", "不可",
    "不建议", "别", "避免", "无法", "无需", "不用", "不再", "不提供", "不干预",
    "不干扰", "不予", "拒绝", "抱歉", "失去保修", "不享受", "风险", "危险",
    "不是用户", "不属于",
)
INSTRUCTION_CUES = (
    "请您先", "请先", "您可以先", "可以先", "建议您", "试着", "自己动手",
    "按以下步骤", "第一步", "接下来把", "然后把", "教您", "照着",
)

# assistant 编造动态事实的断言型表述（仅在无 [订单系统返回] 依据时判失败）
FABRICATED_FACT_PATTERNS = [
    ("绝对日期", re.compile(r"\d{4}-\d{2}-\d{2}")),
    ("月日日期", re.compile(r"\d{1,2}月\d{1,2}日")),
    ("承诺时长送达", re.compile(r"预计\s*\d+\s*(?:天|小时|个工作日)内?(?:送达|到货|到达|到账)")),
    ("断言物流节点", re.compile(r"已到达[^，。；！]{0,12}(?:转运中心|中转场|网点|站点|分拨)")),
    ("断言订单状态", re.compile(r"(?:订单|物流|退款)(?:当前)?状态(?:是|为)[：:]?\s*[已未在]")),
    ("断言退款到账", re.compile(r"退款(?:已|于)[^，。；]{0,8}(?:到账|入账)")),
]

SENTENCE_SPLIT_RE = re.compile(r"[。！？；\n]")
NORMALIZE_RE = re.compile(r"[^一-鿿A-Za-z0-9]+")

# ---------------------------------------------------------------------------
# 检查 24：订单/物流/退款状态词表
# ---------------------------------------------------------------------------
# assistant 说出这些状态词时，必须满足其一：
#   a) 最近一条 observation 里出现了该词（有依据的转述）；
#   b) 所在分句带假设/条件/否定标记（讨论规则而非断言当前状态）。
STATUS_TERMS = (
    "已付款", "待出库", "已出库", "未出库", "已发货", "未发货", "运输中", "派送中",
    "已签收", "已到达", "物流异常", "已退款", "待财务打款", "已取消", "已入库",
    "已完成", "已开票", "未开票", "已支付", "未支付",
)
HYPOTHETICAL_MARKERS = (
    "若", "如果", "假如", "是否", "则", "时", "一旦", "显示", "查到", "核对",
    "不会", "不能", "无法", "没有", "未", "取决于", "要看", "看是否", "属于",
    "通常", "情况", "还是", "或", "确认", "判断", "以", "按",
)

# ---------------------------------------------------------------------------
# 检查 26：无依据的事实性断言
# ---------------------------------------------------------------------------
# 只在**没有** observation 依据的样本里判定。命中即 FAIL：这类内容应由 RAG 提供。
FACT_ASSERTION_PATTERNS = [
    (
        "故障归因断言",
        re.compile(
            r"(?:通常|多为|多数|多半|大多|往往|常见于|多与|多因|多是|基本(?:是|上是)|"
            r"一般(?:是|为|由))[^，。；！？]{0,20}"
            r"(?:造成|引起|导致|有关|所致|的问题|的故障|的原因)"
        ),
    ),
    (
        "因果推断断言",
        # “说明”作为推理连接词时，前面是症状描述（…亮/…常/…光/…音/就…）或位于分句开头；
        # “请说明 / 一句话说明 / 简单说明 / 并分别说明”属于祈使用法，不在此列。
        re.compile(
            r"(?:^|[常亮光音图到好正就无有])说明[^，。；！？]{0,20}"
            r"(?:正常|异常|故障|问题|在工作|没问题|坏了|偏向|指向)"
        ),
    ),
    ("正常性判定断言", re.compile(r"(?:属于正常(?:现象|的)?|是正常的|不算故障|属于设计现象)")),
    (
        "机型操作路径断言",
        # 只在“给出可执行的具体路径”时判定；
        # “菜单里这几项的位置按机型不同，我按型号核对”属于免责说明，不算断言。
        re.compile(
            r"(?:路径(?:通常)?(?:在|是)|"
            r"(?:在)?(?:菜单|设置)(?:里|中)[^，。；！？]{0,12}(?:打开|开启|关闭|恢复|调到|调成|选择|找到|改成)|"
            r"进设置[^，。；！？]{0,10}(?:清理|关闭|打开|删除)|"
            r"长按[^，。；！？]{0,12}(?:键|秒)|"
            r"按遥控[^，。；！？]{0,8}键)"
        ),
    ),
    (
        "维修步骤量值断言",
        # 中文与阿拉伯数字的时长/尺寸量值：训练数据不应写死这些操作参数。
        re.compile(
            r"[0-9一二三四五六七八九十两半]{1,4}\s*(?:个小时|小时|分钟|天|厘米|毫米|米|度)"
            r"(?:以上|以内|左右)?"
        ),
    ),
    (
        "政策结论断言",
        re.compile(
            r"(?:不在保修范围|在保修范围内|原路退回|按折算|一般不(?:在|支持|适用|收)|"
            r"通常(?:由|不由)(?:平台|商家|买家)承担|由(?:平台|商家|买家)承担|"
            r"通常不(?:额外)?收(?:费|取)|不重复收取|不予返还|受.{0,6}期限限制)"
        ),
    ),
]
# 分句级豁免：同一分句内出现这些表述时，该分句在讨论“依据/不确定性”，
# 而不是断言事实。粒度必须是分句，否则整条回复里放一句“请提供型号”
# 就能把所有断言洗白。
CLAUSE_UNCERTAINTY_MARKERS = (
    "我不能", "我不会", "不凭", "需检索", "需要检索", "我检索", "检索后",
    "要按", "为准", "取决于", "无法确认", "不预设", "不下结论", "不一概而论",
    "不替", "以现行", "按条款", "按型号核对", "核对后", "查到", "由工程师",
    "由人工", "不猜", "不预先", "要看", "是否",
    # 条件从句：在讨论规则的适用条件，而不是断言当前事实
    "若", "如果", "假如", "一旦", "万一", "除非",
)
CLAUSE_SPLIT_RE = re.compile(r"[，。；！？、\n]")


# ---------------------------------------------------------------------------
# 结果收集
# ---------------------------------------------------------------------------
class Audit:
    def __init__(self):
        self.checks = []

    def add(self, check_id, name, ok, detail="", samples=None, warn=False):
        self.checks.append(
            {
                "id": check_id,
                "name": name,
                "status": "WARN" if (ok and warn) else ("PASS" if ok else "FAIL"),
                "detail": detail,
                "samples": samples or [],
            }
        )

    @property
    def failed(self):
        return [c for c in self.checks if c["status"] == "FAIL"]

    def render(self):
        lines = []
        for c in self.checks:
            mark = {"PASS": "PASS", "WARN": "WARN", "FAIL": "FAIL"}[c["status"]]
            lines.append(f"[{mark}] {c['id']:>2}. {c['name']}：{c['detail']}")
            for s in c["samples"][:8]:
                lines.append(f"          - {s}")
            if len(c["samples"]) > 8:
                lines.append(f"          - ...另有 {len(c['samples']) - 8} 条同类问题")
        return "\n".join(lines)


def normalize(text):
    return NORMALIZE_RE.sub("", text)


def trigrams(text):
    t = normalize(text)
    if len(t) < 3:
        return {t} if t else set()
    return {t[i : i + 3] for i in range(len(t) - 2)}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def user_turns(record):
    return [m["content"] for m in record["messages"] if m["role"] == "user"]


def assistant_turns(record):
    return [m["content"] for m in record["messages"] if m["role"] == "assistant"]


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def load_json(path):
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", dest="json_out", default=None, help="把审计结果写入 JSON")
    args = parser.parse_args()

    audit = Audit()
    items = all_items()
    items_by_split = {s: [i for i in items if i["split"] == s] for s in SPLITS}

    # ---- 1. JSON 格式 -----------------------------------------------------
    data = {}
    parse_errors = []
    for split, name in SPLIT_FILES.items():
        path = DATASETS_DIR / name
        if not path.exists():
            parse_errors.append(f"{name} 不存在")
            continue
        try:
            payload = load_json(path)
        except json.JSONDecodeError as exc:
            parse_errors.append(f"{name} JSON 解析失败：{exc}")
            continue
        if not isinstance(payload, list):
            parse_errors.append(f"{name} 顶层不是数组")
            continue
        for idx, rec in enumerate(payload):
            if not isinstance(rec, dict) or "messages" not in rec:
                parse_errors.append(f"{name}[{idx}] 缺少 messages 字段")
            elif set(rec.keys()) != {"messages"}:
                parse_errors.append(f"{name}[{idx}] 存在多余字段 {sorted(set(rec) - {'messages'})}")
        data[split] = payload
    smoke_path = DATASETS_DIR / SMOKE_FILE
    smoke = []
    if not smoke_path.exists():
        parse_errors.append(f"{SMOKE_FILE} 不存在（20 条冒烟数据不得删除）")
    else:
        try:
            smoke = load_json(smoke_path)
        except json.JSONDecodeError as exc:
            parse_errors.append(f"{SMOKE_FILE} JSON 解析失败：{exc}")
    audit.add(1, "JSON 格式", not parse_errors,
              "全部文件可解析且结构正确" if not parse_errors else f"{len(parse_errors)} 处问题",
              parse_errors)
    if parse_errors:
        print(audit.render())
        print("\n最终结果：FAIL（JSON 结构错误，后续检查已跳过）")
        return 1

    all_records = [(s, i, r) for s in SPLITS for i, r in enumerate(data[s])]

    # ---- 2. 角色顺序 ------------------------------------------------------
    role_errors = []
    for split, idx, rec in all_records + [(SMOKE_FILE, i, r) for i, r in enumerate(smoke)]:
        msgs = rec["messages"]
        if len(msgs) < 3:
            role_errors.append(f"{split}[{idx}] 消息数不足 3")
            continue
        if msgs[0]["role"] != "system":
            role_errors.append(f"{split}[{idx}] 首条不是 system")
        # user 侧允许 user 或 observation（工具/检索结果），与 LLaMA Factory
        # data/converter.py 的 odd_tags=(user_tag, observation_tag) 一致。
        for pos, m in enumerate(msgs[1:]):
            allowed = ("user", "observation") if pos % 2 == 0 else ("assistant",)
            if m["role"] not in allowed:
                role_errors.append(
                    f"{split}[{idx}] 角色顺序错误，位置 {pos} 期望 {allowed} 实得 {m['role']}"
                )
                break
        if msgs[-1]["role"] != "assistant":
            role_errors.append(f"{split}[{idx}] 结尾不是 assistant")
        roles = {m["role"] for m in msgs}
        if not {"system", "user", "assistant"} <= roles:
            role_errors.append(f"{split}[{idx}] 缺少必需角色，实际：{sorted(roles)}")
        if roles - {"system", "user", "assistant", "observation"}:
            role_errors.append(f"{split}[{idx}] 出现未允许的角色：{sorted(roles)}")
    audit.add(2, "三种角色顺序", not role_errors,
              "system → user/assistant 交替，均以 assistant 结尾" if not role_errors
              else f"{len(role_errors)} 处问题", role_errors)

    # ---- 3. 空内容 --------------------------------------------------------
    empty_errors = []
    for split, idx, rec in all_records + [(SMOKE_FILE, i, r) for i, r in enumerate(smoke)]:
        for pos, m in enumerate(rec["messages"]):
            if not isinstance(m.get("content"), str) or not m["content"].strip():
                empty_errors.append(f"{split}[{idx}].messages[{pos}] 内容为空")
    audit.add(3, "空内容", not empty_errors,
              "无空内容" if not empty_errors else f"{len(empty_errors)} 处空内容", empty_errors)

    # ---- 4. 完全重复样本 --------------------------------------------------
    record_keys = defaultdict(list)
    for split, idx, rec in all_records:
        key = json.dumps(rec, ensure_ascii=False, sort_keys=True)
        record_keys[key].append(f"{split}[{idx}]")
    dup_records = [v for v in record_keys.values() if len(v) > 1]
    audit.add(4, "完全重复样本", not dup_records,
              "无完全重复" if not dup_records else f"{len(dup_records)} 组重复",
              [" == ".join(v) for v in dup_records])

    # ---- 5. 用户问题重复 --------------------------------------------------
    first_user = defaultdict(list)
    later_user = defaultdict(list)
    for split, idx, rec in all_records:
        turns = user_turns(rec)
        first_user[turns[0].strip()].append(f"{split}[{idx}]")
        for t in turns[1:]:
            later_user[t.strip()].append(f"{split}[{idx}]")
    dup_first = {k: v for k, v in first_user.items() if len(v) > 1}
    audit.add(5, "用户问题重复（首轮）", not dup_first,
              "首轮用户问题全部唯一" if not dup_first else f"{len(dup_first)} 组重复",
              [f"{k[:28]}… → {v}" for k, v in dup_first.items()])
    dup_later = {k: v for k, v in later_user.items() if len(v) > 1}
    audit.add("5b", "用户追加轮重复（告警）", True,
              "无重复" if not dup_later else f"{len(dup_later)} 组后续轮文本相同（多轮短回应，可接受）",
              [f"{k[:28]}… → {v}" for k, v in dup_later.items()], warn=bool(dup_later))

    # ---- 6. assistant 回答重复 -------------------------------------------
    asst_index = defaultdict(list)
    for split, idx, rec in all_records:
        for t in assistant_turns(rec):
            asst_index[t.strip()].append(f"{split}[{idx}]")
    dup_asst = {k: v for k, v in asst_index.items() if len(v) > 1}
    audit.add(6, "assistant 回答重复", not dup_asst,
              "全部 assistant 文本唯一" if not dup_asst else f"{len(dup_asst)} 组重复",
              [f"{k[:28]}… → {v}" for k, v in dup_asst.items()])

    # ---- 7 / 12. 跨数据集完全重复与泄漏 ----------------------------------
    cross_exact = []
    norm_by_split = {}
    for split in SPLITS:
        norm_by_split[split] = {}
        for idx, rec in enumerate(data[split]):
            norm_by_split[split][idx] = normalize("".join(user_turns(rec)))
    for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")):
        seen = {v: k for k, v in norm_by_split[a].items()}
        for idx, v in norm_by_split[b].items():
            if v in seen:
                cross_exact.append(f"{a}[{seen[v]}] == {b}[{idx}]")
    audit.add(7, "跨数据集完全重复", not cross_exact,
              "无跨 split 完全重复" if not cross_exact else f"{len(cross_exact)} 组",
              cross_exact)

    # ---- 8. 跨数据集近似重复 ---------------------------------------------
    tri_by_split = {
        split: {idx: trigrams("".join(user_turns(rec))) for idx, rec in enumerate(data[split])}
        for split in SPLITS
    }
    near_fail, near_warn = [], []
    for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")):
        for ib, tb in tri_by_split[b].items():
            best, best_ia = 0.0, None
            for ia, ta in tri_by_split[a].items():
                score = jaccard(ta, tb)
                if score > best:
                    best, best_ia = score, ia
            if best >= CROSS_SPLIT_NEAR_DUP_FAIL:
                near_fail.append(f"{a}[{best_ia}] ~ {b}[{ib}] Jaccard={best:.2f}")
            elif best >= CROSS_SPLIT_NEAR_DUP_WARN:
                near_warn.append(f"{a}[{best_ia}] ~ {b}[{ib}] Jaccard={best:.2f}")
    audit.add(8, "跨数据集近似重复", not near_fail,
              f"无超过 {CROSS_SPLIT_NEAR_DUP_FAIL} 的相似对；{len(near_warn)} 对处于 "
              f"{CROSS_SPLIT_NEAR_DUP_WARN}~{CROSS_SPLIT_NEAR_DUP_FAIL} 告警区间"
              if not near_fail else f"{len(near_fail)} 对超过阈值",
              near_fail or near_warn, warn=bool(near_warn))

    in_split_fail = []
    for split in SPLITS:
        entries = list(tri_by_split[split].items())
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                score = jaccard(entries[i][1], entries[j][1])
                if score >= IN_SPLIT_NEAR_DUP_FAIL:
                    in_split_fail.append(
                        f"{split}[{entries[i][0]}] ~ {split}[{entries[j][0]}] Jaccard={score:.2f}"
                    )
    audit.add("8b", "同一 split 内近似重复", not in_split_fail,
              f"无超过 {IN_SPLIT_NEAR_DUP_FAIL} 的相似对" if not in_split_fail
              else f"{len(in_split_fail)} 对超过阈值", in_split_fail)

    # ---- 9. 订单号格式与隐私信息 -----------------------------------------
    order_errors, privacy_errors = [], []

    def scan_privacy(tag, text, allow_legacy=False):
        for token in ORDER_TOKEN_RE.findall(text):
            up = token.upper()
            ok = any(p.match(up) for p in ALLOWED_ORDER_RE)
            if not ok and allow_legacy:
                ok = any(p.match(up) for p in LEGACY_ORDER_RE)
            if not ok:
                order_errors.append(f"{tag} 订单号格式不合规：{token}")
        stripped = ORDER_TOKEN_RE.sub(" ", text)
        for label, pattern in PRIVACY_PATTERNS:
            m = pattern.search(stripped)
            if m:
                privacy_errors.append(f"{tag} 命中{label}：{m.group()[:24]}")
        for m in BARE_DIGIT_RUN_RE.finditer(stripped):
            privacy_errors.append(f"{tag} 出现 11 位以上数字串：{m.group()[:24]}")
        for name in FORBIDDEN_NAMES:
            if name in text:
                privacy_errors.append(f"{tag} 出现示例真实姓名：{name}")

    for split, idx, rec in all_records:
        for pos, m in enumerate(rec["messages"]):
            scan_privacy(f"{split}[{idx}].{m['role']}[{pos}]", m["content"])
    for idx, rec in enumerate(smoke):
        for pos, m in enumerate(rec["messages"]):
            scan_privacy(f"{SMOKE_FILE}[{idx}].{m['role']}[{pos}]", m["content"], allow_legacy=True)

    audit.add(9, "订单号格式", not order_errors,
              "订单号仅使用 ORDxxxx / TEST-ORDER-xxx（冒烟数据保留旧 YD 格式）"
              if not order_errors else f"{len(order_errors)} 处不合规", order_errors)
    audit.add("9b", "隐私信息", not privacy_errors,
              "未出现手机号、证件号、邮箱、银行卡号、详细地址或示例姓名"
              if not privacy_errors else f"{len(privacy_errors)} 处命中", privacy_errors)

    # ---- 10. 危险维修建议 ------------------------------------------------
    danger_fail, danger_info = [], []
    for split, idx, rec in all_records:
        for t in assistant_turns(rec):
            for sentence in SENTENCE_SPLIT_RE.split(t):
                hit = [k for k in DANGEROUS_KEYWORDS if k in sentence]
                if not hit:
                    continue
                if any(mk in sentence for mk in PROHIBITION_MARKERS):
                    continue
                if any(cue in sentence for cue in INSTRUCTION_CUES):
                    danger_fail.append(f"{split}[{idx}] {hit} → {sentence.strip()[:60]}")
                else:
                    danger_info.append(f"{split}[{idx}] {hit} → {sentence.strip()[:60]}")
    audit.add(10, "危险维修建议关键词", not danger_fail,
              f"无被写成可执行步骤的危险操作；{len(danger_info)} 处为说明性提及（保修范围、风险告知等）"
              if not danger_fail else f"{len(danger_fail)} 处疑似指导危险操作",
              danger_fail or danger_info, warn=bool(danger_info))

    # ---- 11. 数量与分布 --------------------------------------------------
    dist_errors = []
    actual_split = {s: len(data[s]) for s in SPLITS}
    if actual_split != EXPECTED_SPLIT_COUNT:
        dist_errors.append(f"split 数量不符：期望 {EXPECTED_SPLIT_COUNT}，实际 {actual_split}")
    cat_count = Counter(i["category"] for i in items)
    if dict(cat_count) != EXPECTED_CATEGORY_COUNT:
        dist_errors.append(f"类别数量不符：期望 {EXPECTED_CATEGORY_COUNT}，实际 {dict(cat_count)}")
    if len(smoke) != 20:
        dist_errors.append(f"冒烟数据应为 20 条，实际 {len(smoke)} 条")
    audit.add(11, "数量与类别分布", not dist_errors,
              f"train/validation/test = {actual_split['train']}/{actual_split['validation']}"
              f"/{actual_split['test']}，9 个类别数量与规划一致，冒烟数据 20 条保持原样"
              if not dist_errors else "; ".join(dist_errors), dist_errors)

    # ---- 12. 泄漏汇总 ----------------------------------------------------
    leak_total = len(cross_exact) + len(near_fail)
    audit.add(12, "train/validation/test 泄漏", leak_total == 0,
              f"完全重复 {len(cross_exact)} 组，近似重复超阈值 {len(near_fail)} 对"
              + (f"，告警区间 {len(near_warn)} 对" if near_warn else ""),
              cross_exact + near_fail)

    # ---- 13. 文本长度 ----------------------------------------------------
    len_errors = []
    max_record = 0
    for split, idx, rec in all_records:
        total = sum(len(m["content"]) for m in rec["messages"])
        max_record = max(max_record, total)
        if total > RECORD_MAX_CHARS:
            len_errors.append(f"{split}[{idx}] 单条总长度 {total} 超过 {RECORD_MAX_CHARS}")
        for t in user_turns(rec):
            if not (USER_MIN_CHARS <= len(t) <= USER_MAX_CHARS):
                len_errors.append(f"{split}[{idx}] user 长度异常 {len(t)}：{t[:24]}")
        for t in assistant_turns(rec):
            if not (ASSISTANT_MIN_CHARS <= len(t) <= ASSISTANT_MAX_CHARS):
                len_errors.append(f"{split}[{idx}] assistant 长度异常 {len(t)}：{t[:24]}")
    audit.add(13, "文本长度异常", not len_errors,
              f"user {USER_MIN_CHARS}-{USER_MAX_CHARS}、assistant "
              f"{ASSISTANT_MIN_CHARS}-{ASSISTANT_MAX_CHARS} 字符内，单条最长 {max_record} 字符"
              if not len_errors else f"{len(len_errors)} 处异常", len_errors)

    # ---- 14. system prompt ----------------------------------------------
    allowed_prod = {SYSTEM_PROMPTS[k] for k in PRODUCTION_SYSTEM_KEYS}
    sys_errors = []
    sys_counter = Counter()
    for split, idx, rec in all_records:
        content = rec["messages"][0]["content"]
        if content not in allowed_prod:
            sys_errors.append(f"{split}[{idx}] system prompt 不属于允许版本")
        sys_counter[content] += 1
    for idx, rec in enumerate(smoke):
        if rec["messages"][0]["content"] != SYSTEM_PROMPTS["legacy_smoke"]:
            sys_errors.append(f"{SMOKE_FILE}[{idx}] system prompt 与旧版冒烟版本不一致")
    key_of = {v: k for k, v in SYSTEM_PROMPTS.items()}
    audit.add(14, "system prompt 版本", not sys_errors,
              "正式数据仅使用 base/safety/tools 三个允许版本："
              + "、".join(f"{key_of[c]}={n}" for c, n in sys_counter.items())
              + "；冒烟数据保持 legacy_smoke"
              if not sys_errors else f"{len(sys_errors)} 处不合规", sys_errors)

    # ---- 15. 保留订单号 --------------------------------------------------
    reserved_hits = []
    for split, idx, rec in all_records:
        blob = "".join(m["content"] for m in rec["messages"])
        for reserved in RESERVED_ORDER_IDS:
            if reserved in blob:
                reserved_hits.append(f"{split}[{idx}] 出现保留订单号 {reserved}")
    audit.add(15, "保留订单号隔离", not reserved_hits,
              f"{'、'.join(RESERVED_ORDER_IDS)} 未进入训练数据（仅用于 Mock 后端与 Agent 评测）"
              if not reserved_hits else f"{len(reserved_hits)} 处泄漏", reserved_hits)

    # ---- 16. 编造动态事实 ------------------------------------------------
    fabricated = []
    for split, idx, rec in all_records:
        # 依据块现在只出现在 observation 角色（不再伪装成 user）
        grounded = any(
            any(k in m["content"] for k in RESULT_MARKS)
            for m in rec["messages"]
            if m["role"] == "observation"
        )
        if grounded:
            continue
        for t in assistant_turns(rec):
            for label, pattern in FABRICATED_FACT_PATTERNS:
                m = pattern.search(t)
                if m:
                    fabricated.append(f"{split}[{idx}] {label}：{m.group()[:30]}")
    grounded_count = sum(
        1 for _, _, rec in all_records
        if any(TOOL_RESULT_MARK in m["content"] for m in rec["messages"] if m["role"] == "observation")
    )
    rag_grounded_count = sum(
        1 for _, _, rec in all_records
        if any(RAG_RESULT_MARK in m["content"] for m in rec["messages"] if m["role"] == "observation")
    )
    audit.add(16, "动态事实未编造", not fabricated,
              f"无依据的订单/物流/退款事实断言 0 处；observation 依据块共 "
              f"{grounded_count} 条 {TOOL_RESULT_MARK} + {rag_grounded_count} 条 {RAG_RESULT_MARK}"
              if not fabricated else f"{len(fabricated)} 处疑似编造", fabricated)

    # ---- 17. expected_tool 元数据 ---------------------------------------
    tool_meta_errors = []
    for item in items:
        if item["requires_tool"] and item.get("expected_tool") != "queryOrderTool":
            tool_meta_errors.append(f"{item['uid']} requires_tool 但 expected_tool 缺失或不符")
        if not item["requires_tool"] and item.get("expected_tool"):
            tool_meta_errors.append(f"{item['uid']} 未标记 requires_tool 却带 expected_tool")
    tool_count = sum(1 for i in items if i["requires_tool"])
    rag_count = sum(1 for i in items if i["requires_rag"])
    audit.add(17, "工具元数据完整性", not tool_meta_errors,
              f"requires_tool={tool_count} 条全部带 expected_tool=queryOrderTool；requires_rag={rag_count} 条"
              if not tool_meta_errors else f"{len(tool_meta_errors)} 处问题", tool_meta_errors)

    # ---- 18. 类别 × 场景覆盖 --------------------------------------------
    cover_errors = []
    for cat in CATEGORIES:
        subset = [i for i in items if i["category"] == cat]
        seen = {i["scenario"] for i in subset}
        missing = [s for s in REQUIRED_SCENARIOS if s not in seen]
        if missing:
            cover_errors.append(f"{CATEGORY_LABELS[cat]} 缺少场景：{missing}")
        if not any(i["requires_rag"] for i in subset):
            cover_errors.append(f"{CATEGORY_LABELS[cat]} 缺少需要 RAG 的样本")
        if not any(i["requires_tool"] for i in subset):
            cover_errors.append(f"{CATEGORY_LABELS[cat]} 缺少需要 Tool 的样本")
    audit.add(18, "类别 × 场景覆盖", not cover_errors,
              f"9 个类别均覆盖 {len(REQUIRED_SCENARIOS)} 种场景类型，且各自包含 RAG 与 Tool 样本"
              if not cover_errors else f"{len(cover_errors)} 处缺口", cover_errors)

    # ---- 19. 开头多样性 --------------------------------------------------
    prefixes = Counter()
    total_asst = 0
    for split, idx, rec in all_records:
        for t in assistant_turns(rec):
            prefixes[t.strip()[:PREFIX_LEN]] += 1
            total_asst += 1
    top_prefix, top_n = prefixes.most_common(1)[0]
    ratio = top_n / total_asst
    audit.add(19, "assistant 开头多样性", ratio < PREFIX_MAX_RATIO,
              f"最常见开头“{top_prefix}”占 {ratio:.1%}（阈值 {PREFIX_MAX_RATIO:.0%}），"
              f"共 {len(prefixes)} 种不同开头 / {total_asst} 条回复",
              [f"{p} × {n}" for p, n in prefixes.most_common(5)])

    # ---- 20. 源数据往返一致 ---------------------------------------------
    roundtrip_errors = []
    for split in SPLITS:
        expect = sorted(
            json.dumps(to_record(i), ensure_ascii=False, sort_keys=True)
            for i in items_by_split[split]
        )
        actual = sorted(
            json.dumps(r, ensure_ascii=False, sort_keys=True) for r in data[split]
        )
        if expect != actual:
            roundtrip_errors.append(
                f"{split} 与 dataset_source 不一致（源 {len(expect)} 条 / 文件 {len(actual)} 条）"
            )
    audit.add(20, "源数据与 JSON 一致", not roundtrip_errors,
              "三个 split 与 dataset_source 完全一致（可复现生成）"
              if not roundtrip_errors else "; ".join(roundtrip_errors), roundtrip_errors)

    # ---- 21. manifest 一致性 -------------------------------------------
    manifest_errors = []
    manifest_path = DATASETS_DIR / MANIFEST_FILE
    manifest = None
    if not manifest_path.exists():
        manifest_errors.append(f"{MANIFEST_FILE} 不存在")
    else:
        manifest = load_json(manifest_path)
        required_keys = [
            "dataset_version", "created_at", "total_count", "split_count",
            "category_count", "risk_level_count", "requires_rag_count",
            "requires_tool_count", "source", "license", "base_model",
            "random_seed", "generation_method",
        ]
        for key in required_keys:
            if key not in manifest:
                manifest_errors.append(f"manifest 缺少字段 {key}")
        if manifest.get("total_count") != len(items):
            manifest_errors.append("manifest.total_count 与实际不符")
        if manifest.get("split_count") != EXPECTED_SPLIT_COUNT:
            manifest_errors.append("manifest.split_count 与实际不符")
        if manifest.get("category_count") != EXPECTED_CATEGORY_COUNT:
            manifest_errors.append("manifest.category_count 与实际不符")
        actual_risk = {r: sum(1 for i in items if i["risk_level"] == r) for r in RISK_LEVELS}
        if manifest.get("risk_level_count") != actual_risk:
            manifest_errors.append("manifest.risk_level_count 与实际不符")
        if manifest.get("requires_rag_count") != rag_count:
            manifest_errors.append("manifest.requires_rag_count 与实际不符")
        if manifest.get("requires_tool_count") != tool_count:
            manifest_errors.append("manifest.requires_tool_count 与实际不符")
        if manifest.get("random_seed") != 20260729:
            manifest_errors.append("manifest.random_seed 应为 20260729")
    audit.add(21, "manifest 聚合一致", not manifest_errors,
              "manifest 必填字段齐全且统计与数据一致"
              if not manifest_errors else f"{len(manifest_errors)} 处问题", manifest_errors)

    # ---- 22. assistant 不复述用户问题 ------------------------------------
    echo_errors = []
    for split, idx, rec in all_records:
        msgs = rec["messages"]
        for pos in range(1, len(msgs) - 1, 2):
            u = normalize(msgs[pos]["content"])
            a = normalize(msgs[pos + 1]["content"])
            if len(u) >= 8 and u in a:
                echo_errors.append(f"{split}[{idx}] assistant 原样复述用户问题：{u[:24]}")
    audit.add(22, "assistant 未复述用户问题", not echo_errors,
              "无原样复述" if not echo_errors else f"{len(echo_errors)} 处复述", echo_errors)

    # ---- 23. 工具/检索结果的角色归属 -------------------------------------
    role_leak, obs_struct = [], []
    for split, idx, rec in all_records:
        msgs = rec["messages"]
        for pos, m in enumerate(msgs):
            marks = [k for k in RESULT_MARKS if k in m["content"]]
            if marks and m["role"] != "observation":
                role_leak.append(f"{split}[{idx}].{m['role']}[{pos}] 出现 {marks}，必须放在 observation 角色")
            if m["role"] == "observation" and not marks:
                obs_struct.append(f"{split}[{idx}][{pos}] observation 未带 {'/'.join(RESULT_MARKS)} 标记")
            if m["role"] == "observation":
                if pos == 1 or msgs[pos - 1]["role"] != "assistant":
                    obs_struct.append(f"{split}[{idx}][{pos}] observation 前一轮必须是 assistant")
                if pos + 1 >= len(msgs) or msgs[pos + 1]["role"] != "assistant":
                    obs_struct.append(f"{split}[{idx}][{pos}] observation 后一轮必须是 assistant")
                if pos % 2 == 0:
                    obs_struct.append(f"{split}[{idx}][{pos}] observation 必须落在 user 侧（奇数位）")
    obs_records = [
        (s, i, r) for s, i, r in all_records
        if any(m["role"] == "observation" for m in r["messages"])
    ]
    audit.add(23, "工具/检索结果角色归属", not (role_leak or obs_struct),
              f"{len(obs_records)} 条样本带 observation 轮，标记未出现在 user/assistant；"
              f"observation 均夹在 assistant 之间"
              if not (role_leak or obs_struct) else f"{len(role_leak) + len(obs_struct)} 处问题",
              role_leak + obs_struct)

    # ---- 24. assistant 只能转述最近一次 observation -----------------------
    ungrounded_status = []
    for split, idx, rec in all_records:
        msgs = rec["messages"]
        last_obs = ""
        for pos, m in enumerate(msgs):
            if m["role"] == "observation":
                last_obs = m["content"]
                continue
            if m["role"] != "assistant":
                continue
            # 条件标记按整句判定：中文常写成“未出库…，已出库…”，
            # 条件词落在前半句，按分句切会误判后半句为断言。
            for sentence in SENTENCE_SPLIT_RE.split(m["content"]):
                hypothetical = any(mk in sentence for mk in HYPOTHETICAL_MARKERS)
                for clause in CLAUSE_SPLIT_RE.split(sentence):
                    for term in STATUS_TERMS:
                        if term not in clause:
                            continue
                        if term in last_obs:
                            continue  # 有依据的转述
                        if hypothetical:
                            continue  # 条件式讨论规则，不是断言当前状态
                        ungrounded_status.append(
                            f"{split}[{idx}][{pos}] 无依据断言状态“{term}”：{clause[:34]}"
                        )
    audit.add(24, "状态转述有依据", not ungrounded_status,
              "assistant 提到的订单/退款状态词，或来自最近一条 observation，或处于条件表述中"
              if not ungrounded_status else f"{len(ungrounded_status)} 处无依据断言", ungrounded_status)

    # ---- 25. observation 订单号与上下文一致 ------------------------------
    obs_order_mismatch = []
    for split, idx, rec in all_records:
        msgs = rec["messages"]
        for pos, m in enumerate(msgs):
            if m["role"] != "observation":
                continue
            obs_ids = {t.upper() for t in ORDER_TOKEN_RE.findall(m["content"])}
            if not obs_ids:
                continue
            ctx = " ".join(x["content"] for x in msgs[:pos])
            ctx_ids = {t.upper() for t in ORDER_TOKEN_RE.findall(ctx)}
            stray = obs_ids - ctx_ids
            if stray:
                obs_order_mismatch.append(
                    f"{split}[{idx}][{pos}] observation 订单号 {sorted(stray)} 未在上下文出现"
                )
            # 上下文里最后一次出现的订单号才是“当前订单号”
            ordered = ORDER_TOKEN_RE.findall(ctx)
            if ordered and ordered[-1].upper() not in obs_ids:
                obs_order_mismatch.append(
                    f"{split}[{idx}][{pos}] 当前订单号 {ordered[-1]} 与 observation 中 {sorted(obs_ids)} 不一致"
                )
    audit.add(25, "observation 订单号一致", not obs_order_mismatch,
              "工具返回中的订单号与上下文当前订单号一致"
              if not obs_order_mismatch else f"{len(obs_order_mismatch)} 处不一致", obs_order_mismatch)

    # ---- 26. 无依据的维修/政策事实断言 -----------------------------------
    fact_hits = []
    for split, idx, rec in all_records:
        msgs = rec["messages"]
        has_obs = any(m["role"] == "observation" for m in msgs)
        for pos, m in enumerate(msgs):
            if m["role"] != "assistant":
                continue
            # 紧跟 observation 的回复属于有依据转述，本项不判定
            if has_obs and pos > 0 and msgs[pos - 1]["role"] == "observation":
                continue
            for clause in CLAUSE_SPLIT_RE.split(m["content"]):
                if any(mk in clause for mk in CLAUSE_UNCERTAINTY_MARKERS):
                    continue
                for label, pattern in FACT_ASSERTION_PATTERNS:
                    hit = pattern.search(clause)
                    if hit:
                        fact_hits.append(f"{split}[{idx}][{pos}] {label}：{clause.strip()[:40]}")
                        break
    audit.add(26, "无依据事实断言", not fact_hits,
              "未出现无 RAG 依据的故障归因、操作路径、维修量值或政策结论"
              if not fact_hits else f"{len(fact_hits)} 处断言应改写或补 RAG 依据", fact_hits)

    # ---- 27. 知识库引用必须解析到真实文档 --------------------------------
    kb_errors, kb_ok, kb_miss = [], 0, 0
    kb_docs = {}
    kb_root = REPO_ROOT / "knowledge"
    for md in sorted(kb_root.rglob("*.md")) if kb_root.exists() else []:
        text = md.read_text(encoding="utf-8")
        ver = re.search(r"document_version:\s*(\S+)", text)
        heads = {h.strip() for h in re.findall(r"^#{2,3}\s*(.+)$", text, re.M)}
        kb_docs[str(md.relative_to(REPO_ROOT))] = (ver.group(1) if ver else None, heads)
    citation_re = re.compile(r"doc=(\S+?)#(\S+?)\s+version=(\S+)")
    for split, idx, rec in all_records:
        for pos, m in enumerate(rec["messages"]):
            if m["role"] != "observation" or RAG_RESULT_MARK not in m["content"]:
                continue
            hit = citation_re.search(m["content"])
            if not hit:
                kb_miss += 1  # 检索未命中类降级样本，不带 doc= 引用
                continue
            doc, anchor_name, ver = hit.groups()
            if not kb_docs:
                kb_errors.append(f"{split}[{idx}][{pos}] 引用 {doc} 但 knowledge/ 目录不存在")
                continue
            if doc not in kb_docs:
                kb_errors.append(f"{split}[{idx}][{pos}] 引用的文档不存在：{doc}")
                continue
            real_ver, heads = kb_docs[doc]
            if ver != real_ver:
                kb_errors.append(
                    f"{split}[{idx}][{pos}] {doc} 版本不符：引用 {ver}，实际 {real_ver}"
                )
            elif anchor_name not in heads:
                kb_errors.append(f"{split}[{idx}][{pos}] 章节不存在：{doc}#{anchor_name}")
            else:
                kb_ok += 1
    audit.add(27, "知识库引用可解析", not kb_errors,
              f"{kb_ok} 条引用命中真实文档+版本+章节，{kb_miss} 条为检索未命中降级样本"
              + ("" if kb_docs else "；knowledge/ 目录不存在，跳过实体校验")
              if not kb_errors else f"{len(kb_errors)} 处引用无法解析", kb_errors)

    # ---- 输出 ------------------------------------------------------------
    print("=" * 78)
    print("电商客服正式训练数据集审计报告")
    print("=" * 78)
    print(audit.render())

    print("\n" + "-" * 78)
    print("分布统计")
    print("-" * 78)
    print(f"总量：{len(items)} 条    train/validation/test = "
          f"{len(data['train'])}/{len(data['validation'])}/{len(data['test'])}")
    print("\n类别分布：")
    for cat in CATEGORIES:
        by_split = {s: sum(1 for i in items_by_split[s] if i["category"] == cat) for s in SPLITS}
        print(f"  {CATEGORY_LABELS[cat]:<18} 合计 {cat_count[cat]:>3}  "
              f"(train {by_split['train']}, val {by_split['validation']}, test {by_split['test']})")
    print("\n场景分布：")
    scen = Counter(i["scenario"] for i in items)
    print("  " + "  ".join(f"{s}={scen[s]}" for s in SCENARIOS))
    print("\n风险等级：")
    risk = Counter(i["risk_level"] for i in items)
    print("  " + "  ".join(f"{r}={risk[r]}" for r in RISK_LEVELS))
    print(f"\n需要 RAG：{rag_count} 条    需要 Tool：{tool_count} 条    "
          f"带工具返回依据块：{grounded_count} 条    多轮样本：{sum(1 for i in items if len(i['turns']) > 2)} 条")

    print("\n" + "-" * 78)
    print("关键计数汇总")
    print("-" * 78)
    print(f"完全重复样本组：{len(dup_records)}")
    print(f"用户问题重复组（首轮）：{len(dup_first)}")
    print(f"assistant 回答重复组：{len(dup_asst)}")
    print(f"跨 split 完全重复：{len(cross_exact)}")
    print(f"跨 split 近似重复超阈值：{len(near_fail)}（告警区间 {len(near_warn)}）")
    print(f"危险维修建议（可执行步骤）：{len(danger_fail)}")
    print(f"危险关键词说明性提及：{len(danger_info)}")
    print(f"编造动态事实：{len(fabricated)}")
    print(f"隐私信息命中：{len(privacy_errors)}")
    print(f"订单号格式不合规：{len(order_errors)}")

    failed = audit.failed
    print("\n" + "=" * 78)
    if failed:
        print(f"最终结果：FAIL（{len(failed)} 项未通过：{[c['id'] for c in failed]}）")
    else:
        print("最终结果：PASS（全部检查项通过）")
    print("=" * 78)

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(
                {
                    "result": "FAIL" if failed else "PASS",
                    "checks": audit.checks,
                    "counts": {
                        "total": len(items),
                        "split": {s: len(data[s]) for s in SPLITS},
                        "category": dict(cat_count),
                        "scenario": dict(scen),
                        "risk_level": dict(risk),
                        "requires_rag": rag_count,
                        "requires_tool": tool_count,
                        "tool_result_grounded": grounded_count,
                        "duplicate_records": len(dup_records),
                        "duplicate_user_first_turn": len(dup_first),
                        "duplicate_assistant": len(dup_asst),
                        "cross_split_exact": len(cross_exact),
                        "cross_split_near_dup": len(near_fail),
                        "cross_split_near_dup_warn": len(near_warn),
                        "dangerous_instructions": len(danger_fail),
                        "dangerous_mentions_informational": len(danger_info),
                        "fabricated_facts": len(fabricated),
                        "privacy_hits": len(privacy_errors),
                        "order_id_violations": len(order_errors),
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
