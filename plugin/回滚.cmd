@echo off
rem 一键回滚 DSH profile（插件导致无法启动时用）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0回滚.ps1"
pause
