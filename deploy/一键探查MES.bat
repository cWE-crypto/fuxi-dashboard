@echo off
chcp 65001 >nul
title MES 探查 - 推广链接数据采集准备
cd /d "%~dp0"

echo ============================================================
echo   MES 推广链接探查 + 登录 + 下载 + 解析
echo   首次运行需要用微信扫码登录一次,后续会自动复用 cookie
echo ============================================================
echo.

"C:\Users\liuxiaoxiao11\.workbuddy\binaries\python\envs\default\Scripts\python.exe" mes_explore.py

echo.
echo ============================================================
echo   运行完成,日志/截图/下载文件在 logs\ 目录
echo ============================================================
echo.
pause