@echo off
rem Runs the dev server on Node 22 (nvm-windows install) and restarts it when src/ changes.
setlocal
if exist "%LOCALAPPDATA%\nvm\v22.23.3\node.exe" set "PATH=%LOCALAPPDATA%\nvm\v22.23.3;%PATH%"
cd /d "%~dp0.."
if not defined PORT set PORT=8787
node --no-warnings=ExperimentalWarning --watch-path=src src/server.js
