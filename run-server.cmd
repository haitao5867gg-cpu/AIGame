@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
rem Local image server (GPU). Exits by itself if one is already running on port 8790.
set IMG_PY=D:\AIGame-img\venv\Scripts\python.exe
if exist "%IMG_PY%" (
  start "" /b cmd /c "set HF_HOME=E:\SDXLModel&& set IMG_LORA=D:\AIGame-img\lightning4.safetensors&& "%IMG_PY%" scripts\imgserver.py >> logs\imgserver.log 2>&1"
)
node server.js >> logs\server.log 2>&1
