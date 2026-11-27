@echo off
setlocal
cd /d "%~dp0"
set "KRAFLR_NODE=%~dp0.tools\node-v26.13.1-win-x64\node.exe"
if not exist "%KRAFLR_NODE%" set "KRAFLR_NODE=node.exe"
"%KRAFLR_NODE%" bin\kraflr.mjs %*
exit /b %errorlevel%
