@echo off
title Mastra Studio - Port 4111
cd /d Z:\AI\customer-service-ai\mastra-agent

echo Starting Mastra Studio on http://localhost:4111
call npm run dev

echo.
echo Mastra Studio stopped. Error level: %ERRORLEVEL%
pause
