@echo off
setlocal
chcp 65001 >nul
set "SCRIPT=%~dp0update.ps1"
if not exist "%SCRIPT%" (
  echo [x] 找不到 update.ps1（应与一键更新.cmd 同目录）
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo [x] 更新失败，退出码 %CODE%
) else (
  echo [ok] 更新完成，请完全退出并重新启动 DSH。
)
pause
exit /b %CODE%
