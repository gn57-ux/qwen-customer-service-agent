import asyncio
import json
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from peft import PeftModel
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig


BASE_MODEL_PATH = os.getenv(
    "BASE_MODEL_PATH",
    r"C:\AI\models\Qwen3-4B-Instruct-2507",
)
ADAPTER_PATH = os.getenv(
    "ADAPTER_PATH",
    r"C:\AI\adapters\qwen3-4b\customer-service-smoke",
)
MODEL_NAME = os.getenv("MODEL_NAME", "qwen3-4b-customer-service")

tokenizer = None
model = None
generation_lock = asyncio.Lock()


class ChatMessage(BaseModel):
    role: str
    content: Any = None
    tool_call_id: str | None = None
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class ChatCompletionRequest(BaseModel):
    model: str = MODEL_NAME
    messages: list[ChatMessage]
    temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, gt=0.0, le=1.0)
    max_tokens: int = Field(default=256, ge=1, le=1024)
    stream: bool = False
    tools: list[dict[str, Any]] | None = None
    tool_choice: Any = None


def load_qlora_model() -> None:
    global tokenizer, model

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用，请检查 PyTorch 和 NVIDIA 驱动。")

    print(f"正在加载基础模型：{BASE_MODEL_PATH}")
    tokenizer = AutoTokenizer.from_pretrained(
        BASE_MODEL_PATH,
        trust_remote_code=True,
    )

    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    base_model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_PATH,
        trust_remote_code=True,
        quantization_config=quantization_config,
        device_map={"": 0},
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )

    print(f"正在加载 QLoRA 适配器：{ADAPTER_PATH}")
    model = PeftModel.from_pretrained(base_model, ADAPTER_PATH)
    model.eval()
    print(f"模型加载完成：{MODEL_NAME}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_qlora_model()
    yield


app = FastAPI(
    title="Customer Service QLoRA API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.get("/v1/models")
def list_models():
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_NAME,
                "object": "model",
                "created": now,
                "owned_by": "local",
            }
        ],
    }


def parse_tool_calls(content: str) -> tuple[str, list[dict[str, Any]] | None]:
    matches = re.findall(
        r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
        content,
        flags=re.DOTALL,
    )
    if not matches:
        return content, None

    tool_calls = []
    for raw_call in matches:
        try:
            call = json.loads(raw_call)
            name = call.get("name")
            arguments = call.get("arguments", {})
            if not name:
                continue
            if isinstance(arguments, str):
                arguments_json = arguments
            else:
                arguments_json = json.dumps(arguments, ensure_ascii=False)
            tool_calls.append(
                {
                    "id": f"call_{uuid.uuid4().hex}",
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments_json,
                    },
                }
            )
        except (json.JSONDecodeError, TypeError):
            continue

    if not tool_calls:
        return content, None

    cleaned_content = re.sub(
        r"<tool_call>\s*\{.*?\}\s*</tool_call>",
        "",
        content,
        flags=re.DOTALL,
    ).strip()
    return cleaned_content, tool_calls


def generate_reply(
    request: ChatCompletionRequest,
) -> tuple[str, list[dict[str, Any]] | None, int, int]:
    message_dicts = [
        message.model_dump(exclude_none=True) for message in request.messages
    ]
    template_kwargs = {
        "tokenize": False,
        "add_generation_prompt": True,
    }
    if request.tools:
        template_kwargs["tools"] = request.tools

    prompt = tokenizer.apply_chat_template(message_dicts, **template_kwargs)
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    prompt_tokens = inputs["input_ids"].shape[-1]

    generation_kwargs = {
        **inputs,
        "max_new_tokens": request.max_tokens,
        "do_sample": request.temperature > 0,
        "top_p": request.top_p,
        "pad_token_id": tokenizer.eos_token_id,
    }
    if request.temperature > 0:
        generation_kwargs["temperature"] = request.temperature

    with torch.inference_mode():
        output_ids = model.generate(**generation_kwargs)

    generated_ids = output_ids[0, prompt_tokens:]
    content = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()
    content, tool_calls = parse_tool_calls(content)
    return content, tool_calls, prompt_tokens, generated_ids.shape[-1]


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    if not request.messages:
        raise HTTPException(status_code=400, detail="messages 不能为空。")

    if request.stream:
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        async def event_stream():
            async with generation_lock:
                (
                    content,
                    tool_calls,
                    prompt_tokens,
                    completion_tokens,
                ) = await asyncio.to_thread(generate_reply, request)

            role_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant"},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"

            response_delta = (
                {"tool_calls": [
                    {
                        "index": index,
                        **tool_call,
                    }
                    for index, tool_call in enumerate(tool_calls)
                ]}
                if tool_calls
                else {"content": content}
            )
            content_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": response_delta,
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"

            final_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls" if tool_calls else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            }
            yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    async with generation_lock:
        (
            content,
            tool_calls,
            prompt_tokens,
            completion_tokens,
        ) = await asyncio.to_thread(generate_reply, request)

    response_message = {
        "role": "assistant",
        "content": content or None,
    }
    if tool_calls:
        response_message["tool_calls"] = tool_calls

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [
            {
                "index": 0,
                "message": response_message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
