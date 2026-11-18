@echo off
cd /d "%~dp0"
if not exist stats.html (
  echo 还没有统计数据。请先运行「2-启动监控.bat」,等待第一次轮询(约 30 秒)后再打开。
  pause
  exit /b
)
start "" "%~dp0stats.html"
