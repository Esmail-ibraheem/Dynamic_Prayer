@echo off
rem Starts the server on Node 22 (nvm-windows install).
setlocal
if exist "%LOCALAPPDATA%\nvm\v22.23.3\node.exe" set "PATH=%LOCALAPPDATA%\nvm\v22.23.3;%PATH%"
cd /d "%~dp0.."
node --no-warnings=ExperimentalWarning src/server.js
