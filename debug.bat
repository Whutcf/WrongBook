@echo off
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0"

echo ============================================
echo   WrongBook - debug launcher
echo   Close this window to stop the local server.
echo ============================================
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv not found. Please run install.bat first.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" "app.py"
echo.
echo Server stopped.
pause
