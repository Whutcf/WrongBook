@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   WrongBook - Restart local server
echo ============================================
echo.

echo [1/2] Stopping running server (if any)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.

echo     Waiting for port to release...
timeout /t 2 /nobreak >nul

echo [2/2] Starting server in background...
call "%~dp0auto_start.bat"
echo.

echo     Waiting for server to come up (single probe loop)...
set LPORT=
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait_health.ps1"`) do set LPORT=%%p

if defined LPORT if not "%LPORT%"=="FAIL" (
    echo.
    echo Done. Server is ready at: http://127.0.0.1:%LPORT%
) else (
    echo.
    echo Server did not respond within 30s. Check data/app.log for errors.
    echo It may still be starting (first model load can be slow).
)
echo.
pause
