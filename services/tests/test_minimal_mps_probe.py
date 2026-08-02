"""受控最小验证脚本的纯逻辑测试：不加载模型、不涉及 MPS/看门狗。

核心断言：minimal_mps_probe 构造的消息必须先经过 app.ensure_system_prompt()，
不能绕过服务端不可替换的安全 Prompt —— 与 /v1/chat/completions、/chat 走同一套规则。
"""

import inspect

import app as app_module
import minimal_mps_probe as probe


def test_prepare_probe_messages_goes_through_ensure_system_prompt():
    prepared = probe.prepare_probe_messages()
    assert prepared[0].role == "system"
    assert prepared[0].content == app_module.DEFAULT_SYSTEM_PROMPT
    assert [m.role for m in prepared] == ["system", "user"]
    assert prepared[1].content == probe.QUESTION


def test_prepare_probe_messages_uses_chat_message_type():
    """必须是 app.ChatMessage（真正走 ensure_system_prompt 的类型），
    不是探测脚本自己拼的替身对象。"""
    prepared = probe.prepare_probe_messages()
    assert all(isinstance(m, app_module.ChatMessage) for m in prepared)


def test_main_calls_prepare_probe_messages_before_build_prompt():
    """架构性断言：main() 里 prepare_probe_messages() 必须先于 build_prompt() 调用，
    且不存在绕过 ensure_system_prompt 的手写消息字典/替身类。"""
    source = inspect.getsource(probe.main)
    idx_prepare = source.find("prepare_probe_messages()")
    idx_build = source.find("build_prompt(")
    assert idx_prepare != -1, "main() 必须调用 prepare_probe_messages()"
    assert idx_build != -1, "main() 必须调用 build_prompt()"
    assert idx_prepare < idx_build, "必须先经过 ensure_system_prompt 再构造 prompt"
    assert "class _Msg" not in source, "不得用手写替身对象绕过 ChatMessage/ensure_system_prompt"


def test_no_hardcoded_system_prompt_bypass_in_module_source():
    """整个模块源码里不应再出现旧版那种手写的简化 system 文案，
    防止将来有人加回一条绕过服务端规则的捷径。"""
    source = inspect.getsource(probe)
    assert '"你是家电电商平台的售后客服助手。"' not in source
