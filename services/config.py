"""集中配置：环境变量驱动，无硬编码路径。

所有默认值假设仓库标准布局：
  <repo_root>/models/Qwen3-8B
  <repo_root>/models/adapters/customer-service-production-v1

可通过环境变量覆盖，便于未来切换到其他机器或路径。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

EXPECTED_BASE_REVISION_DEFAULT = "b968826d9c46dd6066d109eabc6255188de91218"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


@dataclass(frozen=True)
class Settings:
    # ---- 后端选择 ----
    # "llama_cpp" 是 Mac 上的默认长期路径（PyTorch+MPS 全精度经受控探测证明不可安全
    # 运行，见 services/MPS-FAILURE-REPORT.md）。"pytorch_peft" 必须显式设置才启用，
    # 不会因为某次请求失败就静默切换到另一个 backend。
    llm_backend: str = field(default_factory=lambda: os.getenv("LLM_BACKEND", "llama_cpp"))

    # ---- llama.cpp backend ----
    llama_cpp_base_url: str = field(
        default_factory=lambda: os.getenv("LLAMA_CPP_BASE_URL", "http://127.0.0.1:8002")
    )
    llama_cpp_health_timeout_s: float = field(
        default_factory=lambda: float(os.getenv("LLAMA_CPP_HEALTH_TIMEOUT_S", "3"))
    )
    llama_cpp_request_timeout_s: float = field(
        default_factory=lambda: float(os.getenv("LLAMA_CPP_REQUEST_TIMEOUT_S", "120"))
    )
    gguf_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv("GGUF_DIR", str(REPO_ROOT / "models" / "gguf" / "qwen3-8b-production-v1"))
        )
    )
    # 受控、可提交的 manifest 是**唯一证据源**——models/gguf/ 下的副本仅供本机加速核对
    # （避免每次都重算大文件哈希），换机器 clone 后只有这份文件保证还在。
    gguf_manifest_path: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "GGUF_MANIFEST_PATH",
                str(REPO_ROOT / "services" / "manifests" / "customer-service-production-v1.gguf.json"),
            )
        )
    )
    adapter_scale: float = field(
        default_factory=lambda: float(os.getenv("ADAPTER_SCALE", "1.0"))
    )

    # ---- 模型资产（pytorch_peft backend 使用） ----
    base_model_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("BASE_MODEL_PATH", str(REPO_ROOT / "models" / "Qwen3-8B"))
        )
    )
    adapter_path: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "ADAPTER_PATH",
                str(REPO_ROOT / "models" / "adapters" / "customer-service-production-v1"),
            )
        )
    )
    expected_base_revision: str = field(
        default_factory=lambda: os.getenv(
            "EXPECTED_BASE_REVISION", EXPECTED_BASE_REVISION_DEFAULT
        )
    )
    # manifest 里记录的 adapter 版本名，仅用于展示/health，不参与校验逻辑
    adapter_version_name: str = field(
        default_factory=lambda: os.getenv(
            "ADAPTER_VERSION_NAME", "customer-service-production-v1"
        )
    )

    # ---- 设备与精度 ----
    # "auto" -> MPS 可用则用 MPS，否则 CPU；CUDA 支持保留为未来兼容能力，
    # 本阶段不在 Mac 上验证，可通过 DEVICE=cuda 显式启用（前提是环境本身有 CUDA）。
    device_preference: str = field(default_factory=lambda: os.getenv("DEVICE", "auto"))
    # "auto" -> 启动时实测 bf16，不可用才显式降级 fp16；也可强制 DTYPE=bfloat16/float16
    dtype_preference: str = field(default_factory=lambda: os.getenv("DTYPE", "auto"))

    # ---- 生成默认值（确定性优先）----
    default_temperature: float = field(
        default_factory=lambda: float(os.getenv("DEFAULT_TEMPERATURE", "0.0"))
    )
    default_top_p: float = field(
        default_factory=lambda: float(os.getenv("DEFAULT_TOP_P", "1.0"))
    )
    default_max_tokens: int = field(
        default_factory=lambda: _env_int("DEFAULT_MAX_TOKENS", 512)
    )
    max_tokens_ceiling: int = field(
        default_factory=lambda: _env_int("MAX_TOKENS_CEILING", 1024)
    )
    # 输入 prompt 的最大 token 数上限（防止单请求把上下文撑爆内存）
    max_input_tokens: int = field(
        default_factory=lambda: _env_int("MAX_INPUT_TOKENS", 4096)
    )
    max_messages: int = field(default_factory=lambda: _env_int("MAX_MESSAGES", 64))
    enable_thinking: bool = field(
        default_factory=lambda: _env_bool("ENABLE_THINKING", False)
    )

    # ---- 服务身份 ----
    model_name: str = field(
        default_factory=lambda: os.getenv(
            "MODEL_NAME", "qwen3-8b-customer-service-production-v1"
        )
    )

    # ---- 测试/生产开关 ----
    # 只能显式打开，且必须是非生产环境；生产路径永远严格加载 Base+Adapter，
    # 不会因为忘记设置什么而"悄悄"跳过加载。
    skip_model_load: bool = field(
        default_factory=lambda: _env_bool("CS_SKIP_MODEL_LOAD", False)
    )
    environment: str = field(default_factory=lambda: os.getenv("APP_ENV", "production"))

    def is_test_mode(self) -> bool:
        return self.skip_model_load and self.environment != "production"


def get_settings() -> Settings:
    return Settings()
