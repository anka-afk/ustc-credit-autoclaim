@echo off
chcp 65001 >nul
cd /d "%~dp0"
call runner.cmd bot.js
echo.
echo 监控已退出(出错或被关闭)。
pause