#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tokenized 校验的纯逻辑测试（不需要 datasets / transformers / 模型）。

用构造出来的 input_ids / labels 覆盖：
  正常、长度不一致、labels 全 mask、observation 区未被 mask、
  observation 区定位失败、条数不符、出现 test split、截断率统计、
  observation 第 65 token 泄漏、尾部 token 泄漏、相同前缀多轮顺序定位、
  交错消息顺序定位（system→user→obs→assistant→user→obs 不回退）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import verify_tokenized as VT  # noqa: E402

IGN = VT.IGNORE_INDEX
FAILED = []


def check(name, cond, detail=""):
    print(f"    {'ok  ' if cond else 'FAIL'} {name}" + (f" :: {detail}" if detail and not cond else ""))
    if not cond:
        FAILED.append(name)


def rec(ids, labels):
    return {"input_ids": list(ids), "labels": list(labels)}


# 一条"正常"记录：前 10 个 token 是 source（含 observation 片段 [7,8,9,11]），后 5 个是 target
OBS = [7, 8, 9, 11]
GOOD = rec(list(range(1, 7)) + OBS + [20, 21, 22, 23, 24],
           [IGN] * 10 + [20, 21, 22, 23, 24])

# 1) 正常
p, obs_ok = VT.check_one(GOOD, [{"role": "observation", "tokens": OBS}], 1536)
check("正常记录无问题", p == [], str(p))
check("observation 验证成功计数=1", obs_ok == 1, str(obs_ok))

# 2) 长度不一致
p, _ = VT.check_one(rec([1, 2, 3], [IGN, 1]), [], 1536)
check("input_ids/labels 长度不一致被发现", any("长度不一致" in x for x in p), str(p))

# 3) labels 全 IGNORE
p, _ = VT.check_one(rec([1, 2, 3], [IGN] * 3), [], 1536)
check("labels 全 IGNORE 被发现", any("不产生任何梯度" in x for x in p), str(p))

# 4) observation 区域未被 mask（label 泄漏到 observation token 上）
leaky = rec(list(range(1, 7)) + OBS + [20, 21],
            [IGN] * 6 + [7, 8, 9, 11] + [20, 21])
p, obs_ok = VT.check_one(leaky, [{"role": "observation", "tokens": OBS}], 1536)
check("observation 区未被 mask 被发现", any("未被 mask" in x for x in p), str(p))
check("泄漏时 observation_verified=0", obs_ok == 0, str(obs_ok))

# 5) observation token 序列无法定位 → 必须 FAIL，不能静默跳过
p, obs_ok = VT.check_one(GOOD, [{"role": "observation", "tokens": [91, 92, 93, 94]}], 1536)
check("observation 区无法定位时判 FAIL", any("未能在 input_ids 中定位" in x for x in p), str(p))
check("无法定位时 observation_verified=0", obs_ok == 0, str(obs_ok))

# 6) 缺字段
check("缺 input_ids 被发现", VT.check_one({"labels": [1]}, [], 1536)[0] != [])
check("缺 labels 被发现", VT.check_one({"input_ids": [1]}, [], 1536)[0] != [])

# 7) 条数校验 + 多余 split
by_split = {"train": [GOOD] * 640, "validation": [GOOD] * 80}
spans = {"train": {i: [{"role": "observation", "tokens": OBS}] for i in range(640)},
         "validation": {i: [{"role": "observation", "tokens": OBS}] for i in range(80)}}
res = VT.check_records(by_split, spans, 1536)
check("640/80 条通过", res["problems"] == [], str(res["problems"][:3]))
check("统计含 train/validation", set(res["stats"]) == {"train", "validation"})
check("observation 验证 720 轮全部成功", res["obs_verified"] == 720, str(res["obs_verified"]))

bad_counts = {"train": [GOOD] * 639, "validation": [GOOD] * 80}
res = VT.check_records(bad_counts, spans, 1536)
check("train 639 条被拒", any("条数不符" in x for x in res["problems"]), str(res["problems"][:2]))

with_test = {"train": [GOOD] * 640, "validation": [GOOD] * 80, "test": [GOOD] * 80}
res = VT.check_records(with_test, spans, 1536)
check("出现 test split 被拒", any("预期之外的 split" in x for x in res["problems"]),
      str(res["problems"][:2]))

missing = {"train": [GOOD] * 640}
res = VT.check_records(missing, spans, 1536)
check("缺 validation 被拒", any("缺少 split" in x for x in res["problems"]))

# 8) 截断率统计
long_rec = rec(list(range(2000)), [IGN] * 1999 + [5])
mixed = {"train": [GOOD] * 639 + [long_rec], "validation": [GOOD] * 80}
spans2 = {"train": {i: [] for i in range(640)}, "validation": {i: [] for i in range(80)}}
res = VT.check_records(mixed, spans2, 1536)
st = res["stats"]["train"]
check("超 cutoff 计数正确", st["over_cutoff_count"] == 1, str(st))
check("截断率正确", abs(st["truncation_rate"] - round(1 / 640, 4)) < 1e-9, str(st))
check("max 反映最长样本", st["max"] == 2000, str(st))

# 9) 子序列定位边界
check("find_subsequence 命中", VT.find_subsequence([1, 2, 3, 4], [2, 3]) == 1)
check("find_subsequence 未命中", VT.find_subsequence([1, 2, 3], [9]) == -1)
check("find_subsequence 空 needle", VT.find_subsequence([1], []) == -1)
check("find_subsequence 从 start 开始", VT.find_subsequence([1, 2, 1, 2], [1, 2], 2) == 2)

# ===========================================================================
# 10) observation 第 65 token 泄漏（验证不再只用前 64 token）
# ===========================================================================
OBS_LONG = list(range(100, 200))  # 100 tokens
SRC_LEN = 10
TGT_LEN = 5
ids_long = list(range(1, SRC_LEN + 1)) + OBS_LONG + list(range(300, 300 + TGT_LEN))
labels_long = [IGN] * SRC_LEN + [IGN] * len(OBS_LONG) + list(range(300, 300 + TGT_LEN))
good_long = rec(ids_long, labels_long)
p, obs_ok = VT.check_one(good_long, [{"role": "observation", "tokens": OBS_LONG}], 1536)
check("完整 100-token observation 全部 mask 通过", p == [], str(p[:2]))
check("100-token observation 验证计数=1", obs_ok == 1, str(obs_ok))

# 第 65 token（下标 64，即 SRC_LEN + 64）泄漏为非 -100
labels_leak_65 = list(labels_long)
labels_leak_65[SRC_LEN + 64] = 999
leak_rec = rec(ids_long, labels_leak_65)
p, obs_ok = VT.check_one(leak_rec, [{"role": "observation", "tokens": OBS_LONG}], 1536)
check("observation 第 65 token 泄漏必须失败",
      any("未被 mask" in x for x in p), str(p))
check("第 65 token 泄漏时 obs_verified=0", obs_ok == 0, str(obs_ok))

# ===========================================================================
# 11) observation 尾部最后一个 token 泄漏
# ===========================================================================
labels_tail_leak = list(labels_long)
labels_tail_leak[SRC_LEN + len(OBS_LONG) - 1] = 999
tail_leak_rec = rec(ids_long, labels_tail_leak)
p, obs_ok = VT.check_one(tail_leak_rec, [{"role": "observation", "tokens": OBS_LONG}], 1536)
check("observation 尾部 token 泄漏必须失败",
      any("未被 mask" in x for x in p), str(p))
check("尾部 token 泄漏时 obs_verified=0", obs_ok == 0, str(obs_ok))

# ===========================================================================
# 12) 两段具有相同前缀的 observation 能按消息顺序分别定位
# ===========================================================================
OBS_A = [7, 8, 9, 11, 30, 31]   # 前缀 [7,8,9,11] 相同
OBS_B = [7, 8, 9, 11, 40, 41]   # 后缀不同
OBS_C = [7, 8, 9, 11, 50, 51]   # 第三段，同前缀

ids_seq = (list(range(1, 6))            # source 1 (5 tokens)
           + OBS_A                       # obs_a at pos 5
           + [20, 21, 22]                # assistant (3 tokens)
           + OBS_B                       # obs_b at pos 5+6+3 = 14
           + [24, 25, 26]                # assistant (3 tokens)
           + OBS_C                       # obs_c at pos 14+6+3 = 23
           + [28, 29])                   # assistant (2 tokens)

labels_seq = ([IGN] * 5
              + [IGN] * len(OBS_A)
              + [20, 21, 22]
              + [IGN] * len(OBS_B)
              + [24, 25, 26]
              + [IGN] * len(OBS_C)
              + [28, 29])

seq_rec = rec(ids_seq, labels_seq)

span_seq = [
    {"role": "observation", "tokens": OBS_A},
    {"role": "observation", "tokens": OBS_B},
    {"role": "observation", "tokens": OBS_C},
]
p, obs_ok = VT.check_one(seq_rec, span_seq, 1536)
check("相同前缀三段 observation 全部定位通过", p == [], str(p))
check("三段 observation 全部验证成功", obs_ok == 3, str(obs_ok))

# OBS_B 位置泄漏，验证错误下标指向正确位置 (14) 而非 OBS_A (5)
labels_seq_order = list(labels_seq)
labels_seq_order[14] = 999   # 泄漏 OBS_B 第一个 token (pos=14)
seq_rec_order = rec(ids_seq, labels_seq_order)
p_order, obs_ok_order = VT.check_one(seq_rec_order, span_seq, 1536)
check("OBS_B 泄漏时下标指向正确位置 14（非 pos=5）",
      any("14" in x for x in p_order if "未被 mask" in x),
      str(p_order))

# 颠倒顺序：OBS_B 先、OBS_A 后 → OBS_A 无法回退查找
p_jump, obs_ok_jump = VT.check_one(seq_rec, [
    {"role": "observation", "tokens": OBS_B},
    {"role": "observation", "tokens": OBS_A},
], 1536)
check("OBS_B 先定位后 OBS_A 无法回退查找（start 参数生效）",
      any("未能在 input_ids 中定位" in x for x in p_jump), str(p_jump))
check("OBS_B 正常验证通过", obs_ok_jump == 1, str(obs_ok_jump))

# ===========================================================================
# 13) 完整 observation 序列无法定位时必须失败
# ===========================================================================
OBS_NOT_IN = [91, 92, 93, 94, 95, 96]
p_big, obs_ok_big = VT.check_one(good_long, [{"role": "observation", "tokens": OBS_NOT_IN}], 1536)
check("完整 6-token 序列无法定位时失败",
      any("未能在 input_ids 中定位" in x for x in p_big), str(p_big))
check("无法定位时 obs_verified=0", obs_ok_big == 0, str(obs_ok_big))

# 能定位到一部分但完整序列不匹配（后缀不同）
OBS_PARTIAL = OBS_LONG[:10] + [99999]
p_part, obs_ok_part = VT.check_one(good_long, [{"role": "observation", "tokens": OBS_PARTIAL}], 1536)
check("部分匹配但完整序列不匹配时失败",
      any("未能在 input_ids 中定位" in x for x in p_part), str(p_part))

# ===========================================================================
# 14) input_ids 与 labels 长度不一致时失败（回归验证）
# ===========================================================================
mismatch = rec([1, 2, 3, 4, 5], [IGN, IGN, IGN])
p_m, obs_ok_m = VT.check_one(mismatch, [], 1536)
check("长度不一致时发现问题", any("长度不一致" in x for x in p_m), str(p_m))
check("长度不一致时 obs_verified=0", obs_ok_m == 0, str(obs_ok_m))

# ===========================================================================
# 15) 交错消息按原始顺序定位：system → user → obs → user → obs → assistant
#   后半段 user/obs 必须定位到正确位置，不能回退匹配前半段
# ===========================================================================
SYS_T = [1, 2, 3]
USR1_T = [10, 11, 12]
OBS1_T = [20, 21, 22]
USR2_T = [10, 11, 12, 99]   # 前缀与 USR1 相同，后缀不同
OBS2_T = [20, 21, 22, 77]   # 前缀与 OBS1 相同，后缀不同

ids_interleaved = (
    SYS_T                                    # system      at 0
    + USR1_T                                 # user1       at 3
    + OBS1_T                                 # obs1        at 6
    + [30, 31, 32]                           # assistant   at 9
    + USR2_T                                 # user2       at 12
    + OBS2_T                                 # obs2        at 16
    + [40, 41, 42]                           # assistant   at 20
)

labels_interleaved = (
    [IGN] * len(SYS_T)
    + [IGN] * len(USR1_T)
    + [IGN] * len(OBS1_T)
    + [30, 31, 32]
    + [IGN] * len(USR2_T)
    + [IGN] * len(OBS2_T)
    + [40, 41, 42]
)

interleaved_rec = rec(ids_interleaved, labels_interleaved)
interleaved_spans = [
    {"role": "system", "tokens": SYS_T},
    {"role": "user", "tokens": USR1_T},
    {"role": "observation", "tokens": OBS1_T},
    {"role": "user", "tokens": USR2_T},
    {"role": "observation", "tokens": OBS2_T},
]
p_il, obs_ok_il = VT.check_one(interleaved_rec, interleaved_spans, 1536)
check("交错消息全部按原始顺序通过", p_il == [], str(p_il))
check("交错消息 obs 验证=2", obs_ok_il == 2, str(obs_ok_il))

# 第二个 user 泄漏 → 错误下标必须在后半段 (pos=12)，不能回退到 USR1 (pos=3)
labels_il_leak2 = list(labels_interleaved)
labels_il_leak2[12] = 999   # 泄漏 USR2_T 位置
il_leak2_rec = rec(ids_interleaved, labels_il_leak2)
p_il2, _ = VT.check_one(il_leak2_rec, interleaved_spans, 1536)
check("USR2 泄漏下标指向 12（非 USR1 的 pos=3）",
      any("12" in x for x in p_il2 if "未被 mask" in x),
      str(p_il2))

# 第二个 obs 泄漏 → 错误下标必须在后半段 (pos=16)，不能回退到 OBS1 (pos=6)
labels_il_obs2 = list(labels_interleaved)
labels_il_obs2[16] = 999
il_obs2_rec = rec(ids_interleaved, labels_il_obs2)
p_il3, _ = VT.check_one(il_obs2_rec, interleaved_spans, 1536)
check("OBS2 泄漏下标指向 16（非 OBS1 的 pos=6）",
      any("16" in x for x in p_il3 if "未被 mask" in x),
      str(p_il3))

print(f"\n    小结：{'全部通过' if not FAILED else f'{len(FAILED)} 项失败 {FAILED}'}")
sys.exit(1 if FAILED else 0)
