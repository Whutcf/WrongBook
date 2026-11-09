@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" (
  echo.
  echo [WrongBook] Local runtime not found.
  echo Please run "install.bat" first.
  echo.
  pause
  exit /b 1
)

start "" /D "%~dp0" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0app.py"
exit /b 0
