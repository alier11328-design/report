@echo off
rem 万能班长报告工坊 - 本地服务一键启动
cd /d "%~dp0"
echo Starting AI report server at http://127.0.0.1:3000 ...
node server.js
pause
