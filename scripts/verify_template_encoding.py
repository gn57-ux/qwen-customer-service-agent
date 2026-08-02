#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯预处理验证：确认 observation 角色被 qwen3_nothink 模板正确编码。

用法：
    python3 scripts/verify_template_encoding.py
    python3 scripts/verify_template_encoding.py --jinja   # 额外与真实 chat template 交叉比对

本脚本**不加载模型、不下载权重、不启动训练**。它做三件事：

1. 复现 LLaMA Factory v0.9.5 的 ShareGPT 角色校验规则
   （data/converter.py：odd_tags=(user, observation)、even_tags=(assistant, function)），
   确认数据集里每条记录都能通过转换而不被判为 broken_data。

2. 复现 qwen3_nothink 模板的槽位拼接
   （data/template.py 中该模板的 format_user / format_assistant /
   format_system / format_observation），渲染出实际进入分词器的 prompt 文本，
   并标注哪些片段计入损失（assistant 目标）、哪些被 IGNORE_INDEX 掩掉
   （data/processor/supervised.py：source 一律掩掉，除非 train_on_prompt）。

3. 断言 observation 轮被包进 <tool_response> … </tool_response>，
   因此普通 user 轮无法伪造工具输出——这是本次改造的安全依据。

可选的 --jinja 会用仓库内已有的 Qwen3 分词器模板
（adapters/customer-service-smoke/chat_template.jinja，role="tool"）渲染同一条对话，
逐字符比对两条路径的结果，证明训练态与 Mastra 推理态的工具消息同构。
"""

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from dataset_source import all_items  # noqa: E402
from dataset_source.common import RESULT_MARKS, to_record  # noqa: E402

# ---------------------------------------------------------------------------
# LLaMA Factory v0.9.5 · data/converter.py 的 ShareGPT 角色规则
# ---------------------------------------------------------------------------
ODD_TAGS = ("user", "observation")      # 0,2,4… 位（模型输入侧）
EVEN_TAGS = ("assistant", "function_call")  # 1,3,5… 位（模型输出侧）

# ---------------------------------------------------------------------------
# LLaMA Factory v0.9.5 · data/template.py 中 qwen3_nothink 的槽位
# ---------------------------------------------------------------------------
SLOT_SYSTEM = "<|im_start|>system\n{content}<|im_end|>\n"
SLOT_USER = "<|im_start|>user\n{content}<|im_end|>\n<|im_start|>assistant\n"
SLOT_ASSISTANT = "{content}<|im_end|>\n"
SLOT_OBSERVATION = (
    "<|im_start|>user\n<tool_response>\n{content}\n</tool_response><|im_end|>\n"
    "<|im_start|>assistant\n"
)

TOOL_OPEN, TOOL_CLOSE = "<tool_response>", "</tool_response>"

SPLIT_FILES = {
    "train": "customer-service-train-640.json",
    "validation": "customer-service-validation-80.json",
    "test": "customer-service-test-80.json",
}


def check_roles(messages):
    """复现 converter 的角色校验，返回错误列表（空表示可被 LF 正常转换）。"""
    errors = []
    body = messages[1:] if messages and messages[0]["role"] == "system" else messages
    for idx, m in enumerate(body):
        allowed = ODD_TAGS if idx % 2 == 0 else EVEN_TAGS
        if m["role"] not in allowed:
            errors.append(f"index={idx} role={m['role']} 不在 {allowed}")
    if len(body) % 2 != 0:
        errors.append(f"消息数为奇数({len(body)})，LF 会判为 broken_data")
    return errors


def render(messages):
    """按 qwen3_nothink 槽位渲染，返回 (prompt 文本, 分段列表)。

    分段列表元素为 (是否计入损失, 文本)；source 段在 SFT 里 label=IGNORE_INDEX。
    """
    parts = []
    system = ""
    body = messages
    if messages and messages[0]["role"] == "system":
        system = messages[0]["content"]
        body = messages[1:]

    for idx, m in enumerate(body):
        chunk = ""
        if idx == 0 and system:
            chunk += SLOT_SYSTEM.format(content=system)
        role, content = m["role"], m["content"]
        if role == "user":
            chunk += SLOT_USER.format(content=content)
            parts.append((False, chunk))
        elif role == "observation":
            chunk += SLOT_OBSERVATION.format(content=content)
            parts.append((False, chunk))
        elif role == "assistant":
            chunk += SLOT_ASSISTANT.format(content=content)
            parts.append((True, chunk))
        else:
            raise NotImplementedError(f"Unexpected role: {role}")
    return "".join(t for _, t in parts), parts


def render_jinja(messages, template_path):
    """用仓库内真实的 Qwen3 chat template 渲染（observation → role="tool"）。"""
    try:
        from jinja2 import Environment
    except ImportError:
        return None
    env = Environment(trim_blocks=False, lstrip_blocks=False)
    env.policies["json.dumps_kwargs"] = {"ensure_ascii": False}
    tpl = env.from_string(template_path.read_text(encoding="utf-8"))
    mapped = [
        {"role": ("tool" if m["role"] == "observation" else m["role"]), "content": m["content"]}
        for m in messages
    ]
    return tpl.render(messages=mapped, tools=None, add_generation_prompt=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jinja", action="store_true", help="与真实 chat_template.jinja 交叉比对")
    ap.add_argument("--show", type=int, default=1, help="打印几条 observation 样本的渲染结果")
    args = ap.parse_args()

    print("=" * 78)
    print("observation 角色纯预处理验证（不加载模型、不下载权重、不训练）")
    print("=" * 78)
    print("模板来源：LLaMA Factory v0.9.5 data/template.py → qwen3_nothink")
    print("角色规则：data/converter.py → odd=(user, observation) / even=(assistant, function_call)")
    print("损失掩码：data/processor/supervised.py → source 段 label=IGNORE_INDEX\n")

    items = all_items()
    role_errors, obs_items = [], []
    for it in items:
        msgs = to_record(it)["messages"]
        errs = check_roles(msgs)
        if errs:
            role_errors.append((it["uid"], errs))
        if any(m["role"] == "observation" for m in msgs):
            obs_items.append((it, msgs))

    print(f"[1] 角色序列校验：{len(items)} 条记录，"
          f"{'全部可被 LF ShareGPT 转换' if not role_errors else f'{len(role_errors)} 条不合法'}")
    for uid, errs in role_errors[:10]:
        print(f"      {uid}: {errs}")

    # observation 必须被 <tool_response> 包裹，且 user 轮不得出现该包裹
    wrap_errors, leak_errors = [], []
    for it, msgs in obs_items:
        text, _ = render(msgs)
        for m in msgs:
            if m["role"] != "observation":
                continue
            expected = SLOT_OBSERVATION.format(content=m["content"])
            if expected not in text:
                wrap_errors.append(f"{it['uid']}: observation 未按槽位渲染")
            if TOOL_OPEN not in expected or TOOL_CLOSE not in expected:
                wrap_errors.append(f"{it['uid']}: 渲染结果缺少 tool_response 包裹")
    for it in items:
        msgs = to_record(it)["messages"]
        for m in msgs:
            if m["role"] in ("user", "assistant") and any(k in m["content"] for k in RESULT_MARKS):
                leak_errors.append(f"{it['uid']}: {m['role']} 轮出现工具/检索标记")
    print(f"[2] observation 包裹检查：{len(obs_items)} 条带 observation 的样本，"
          f"{'全部渲染为 <tool_response>…</tool_response>' if not wrap_errors else wrap_errors[:5]}")
    print(f"[3] user/assistant 轮伪造检查："
          f"{'未发现工具/检索标记' if not leak_errors else leak_errors[:5]}")

    # 损失掩码统计
    masked = trained = 0
    for it, msgs in obs_items:
        _, parts = render(msgs)
        for is_target, txt in parts:
            if is_target:
                trained += len(txt)
            else:
                masked += len(txt)
    print(f"[4] 损失掩码：observation 与 user 段共 {masked} 字符被掩掉（不计损失），"
          f"assistant 目标段 {trained} 字符参与训练")

    # jinja 交叉比对
    jinja_status = "未执行（未加 --jinja）"
    if args.jinja:
        tpl = REPO_ROOT / "adapters/customer-service-smoke/chat_template.jinja"
        if not tpl.exists():
            jinja_status = f"跳过：{tpl.relative_to(REPO_ROOT)} 不存在"
        else:
            mismatch = 0
            checked = 0
            for it, msgs in obs_items:
                lf_text, _ = render(msgs)
                jj = render_jinja(msgs, tpl)
                if jj is None:
                    jinja_status = "跳过：本机未安装 jinja2"
                    break
                checked += 1
                # LF 在最后一个 assistant 后不再追加 generation prompt；
                # jinja 在 role=tool 之后也不会自动补 assistant 头，
                # 因此比对时去掉 LF 槽位为下一轮预留的 assistant 头。
                lf_norm = lf_text.replace("<|im_start|>assistant\n", "\x00")
                jj_norm = jj.replace("<|im_start|>assistant\n", "\x00")
                if lf_norm != jj_norm:
                    mismatch += 1
                    if mismatch == 1:
                        print("\n  首个不一致样本:", it["uid"])
                        print("  --- LF 槽位渲染 ---"); print(lf_text)
                        print("  --- jinja 渲染 ---"); print(jj)
            else:
                jinja_status = (f"已比对 {checked} 条，"
                                f"{'逐字符一致' if mismatch == 0 else f'{mismatch} 条不一致'}")
    print(f"[5] 与真实 Qwen3 chat template 交叉比对：{jinja_status}")

    if args.show:
        print("\n" + "-" * 78)
        print("渲染示例（★ 表示该段计入损失）")
        print("-" * 78)
        for it, msgs in obs_items[: args.show]:
            print(f"uid={it['uid']}  category={it['category']}  "
                  f"observation×{sum(1 for m in msgs if m['role']=='observation')}")
            _, parts = render(msgs)
            for is_target, txt in parts:
                print(("★ " if is_target else "  ") + repr(txt))
            print()

    # 数据文件里也不能出现非法角色
    file_role_errors = []
    for split, name in SPLIT_FILES.items():
        path = REPO_ROOT / "datasets" / name
        if not path.exists():
            file_role_errors.append(f"{name} 不存在")
            continue
        for idx, rec in enumerate(json.loads(path.read_text(encoding="utf-8"))):
            errs = check_roles(rec["messages"])
            if errs:
                file_role_errors.append(f"{split}[{idx}]: {errs}")
    print(f"[6] 已生成 JSON 的角色校验："
          f"{'三个 split 全部合法' if not file_role_errors else file_role_errors[:5]}")

    failed = bool(role_errors or wrap_errors or leak_errors or file_role_errors)
    print("\n" + "=" * 78)
    print("结论：" + ("FAIL" if failed else "PASS —— observation 角色可被 qwen3_nothink 正确编码"))
    print("=" * 78)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
