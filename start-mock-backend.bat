@echo off
title Customer Service Mock Backend - Port 8001
cd /d Z:\AI\customer-service-ai
call .venv\Scripts\activate.bat

echo Starting Mock Backend on http://127.0.0.1:8001
python -m uvicorn mock_backend:app --app-dir Z:\AI\customer-service-ai\services --host 127.0.0.1 --port 8001

echo.
echo Mock Backend stopped. Error level: %ERRORLEVEL%
pause
