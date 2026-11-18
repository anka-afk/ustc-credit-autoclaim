@echo off
setlocal
where node.exe >nul 2>nul
if %errorlevel%==0 (
  node.exe %*
  goto :eof
)
if exist "%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe" %*
  goto :eof
)
echo [ERROR] 未找到 Node.js 或 Qoder CN,无法运行脚本。
exit /b 1