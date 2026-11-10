@echo off
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    exit /b 1
)
rem WrongBook local server - silent launch (no browser popup, no console window).
rem app.py detects an already-running instance and exits; always stop first via restart.bat.
"%~dp0.venv\Scripts\pythonw.exe" "%~dp0app.py" --no-browser
exit /b 0
