@echo off
chcp 65001 >nul
setlocal
rem 一键安装：把云端同步面板装进本机 DSH（Windows）
rem
rem 用法：
rem   1) 在克隆好的仓库里双击本文件；
rem   2) 或先克隆，再在终端执行 install\一键安装.cmd；
rem   3) 如果还没有克隆，也可以直接带公开仓库地址运行：
rem      install\一键安装.cmd https://github.com/neigjborFrank/dsh-cloud-sync-tools.git
rem
rem 安装脚本会先备份 profile，再写入插件依赖；默认不登记任何同步仓库。

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
