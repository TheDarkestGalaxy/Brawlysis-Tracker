@echo off
SETLOCAL EnableDelayedExpansion

:: Ensure we are in the script's directory
cd /d "%~dp0"

:: Check if Python is installed
python --version >nul 2>&1
if !errorlevel! neq 0 (
    exit /b 1
)

:: Clear existing proxy instances to prevent port conflicts
taskkill /F /IM python.exe /FI "WINDOWTITLE eq Brawl Stars API Proxy" 2>nul

:: Start the server
start /min "Brawl Stars API Proxy" python server.py

:: Give the server a moment to initialize
timeout /t 2 /nobreak >nul

:: Open the Dashboard in the default browser
start http://127.0.0.1:8000

exit
