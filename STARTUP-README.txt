电商客服 AI 系统一键启动说明
==============================

使用顺序：

1. 双击 start-model-api.bat
   等待出现：
   Application startup complete
   Uvicorn running on http://127.0.0.1:8000

2. 双击 start-mock-backend.bat
   等待出现：
   Uvicorn running on http://127.0.0.1:8001

3. 双击 start-mastra-studio.bat
   等待出现：
   Studio: http://localhost:4111

4. 使用浏览器打开：
   http://localhost:4111/agents

健康检查：
   QLoRA API:   http://127.0.0.1:8000/health
   Mock Backend: http://127.0.0.1:8001/health

关闭服务：
   在对应的黑色命令窗口中按 Ctrl+C。

注意：
   start-model-api.bat 已包含 Windows 下避免模型加载访问冲突的参数：
   HF_ENABLE_PARALLEL_LOADING=false
   SAFETENSORS_FAST_GPU=0
   TOKENIZERS_PARALLELISM=false

目录要求：
   项目：Z:\AI\customer-service-ai
   虚拟环境：Z:\AI\customer-service-ai\.venv
   基础模型：C:\AI\models\Qwen3-4B-Instruct-2507
   适配器：C:\AI\adapters\qwen3-4b\customer-service-smoke
