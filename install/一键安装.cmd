# 一键安装：把云端同步面板装进本机的 DSH（Windows）
#
# 用法（在克隆好的仓库里）：
#   双击运行本文件，或在 cmd 里执行：
#     _repo\install\一键安装.cmd
#
# 如果还没有克隆仓库，也可以直接带上仓库地址运行：
#     _repo\install\一键安装.cmd git@github.com:you/repo.git
#   （此时脚本会先克隆到 %USERPROFILE%\Documents\deepseek-harness\<仓库名>，再安装）
#
# 可选参数直接透传给 install.ps1，例如：
#     一键安装.cmd "" -DryRun
@echo off
setlocal
chcp 65001 >nul
set "REPO_URL=%~1"
set "SCRIPT=%~dp0install.ps1"
if not exist "%SCRIPT%" (
  echo [x] 找不到 install.ps1（应与一键安装.cmd 同目录）
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -RepoUrl "%REPO_URL%"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo [x] 安装失败，退出码 %CODE%
) else (
  echo [ok] 安装完成，请完全退出并重新启动 DSH。
)
pause
exit /b %CODE%
