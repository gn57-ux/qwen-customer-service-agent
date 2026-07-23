@echo off
title Customer Service QLoRA API - Port 8000
cd /d Z:\AI\customer-service-ai
call .venv\Scripts\activate.bat

set HF_ENABLE_PARALLEL_LOADING=false
set SAFETENSORS_FAST_GPU=0
set TOKENIZERS_PARALLELISM=false

echo Starting QLoRA API on http://127.0.0.1:8000
python -X faulthandler -m uvicorn app:app --app-dir Z:\AI\customer-service-ai\services --host 127.0.0.1 --port 8000

echo.
echo QLoRA API stopped. Error level: %ERRORLEVEL%
pause
