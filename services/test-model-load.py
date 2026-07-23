import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_PATH = r"C:\AI\models\Qwen3-4B-Instruct-2507"

print("1. PyTorch:", torch.__version__, flush=True)
print("2. CUDA:", torch.cuda.is_available(), flush=True)
print("3. GPU:", torch.cuda.get_device_name(0), flush=True)
print("4. 显存:", torch.cuda.mem_get_info(), flush=True)

print("5. 开始加载 tokenizer", flush=True)
tokenizer = AutoTokenizer.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
)
print("6. tokenizer 加载成功", flush=True)

print("7. 开始把模型加载到 CPU", flush=True)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH,
    dtype=torch.bfloat16,
    device_map=None,
    low_cpu_mem_usage=False,
    trust_remote_code=True,
)
print("8. CPU 模型加载成功", flush=True)

print("9. 开始把模型移动到 GPU", flush=True)
model = model.to("cuda")
model.eval()
print("10. GPU 模型加载成功", flush=True)

messages = [{"role": "user", "content": "你是谁？请用一句话回答。"}]
inputs = tokenizer.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
).to("cuda")

print("11. 开始生成", flush=True)
with torch.inference_mode():
    outputs = model.generate(**inputs, max_new_tokens=64)

answer = tokenizer.decode(
    outputs[0][inputs["input_ids"].shape[-1]:],
    skip_special_tokens=True,
)

print("12. 回答：", answer, flush=True)