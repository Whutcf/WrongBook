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

echo     Waiting for server to come up...
set READY=0
set LPORT=8765
for /L %%i in (1,1,25) do (
    for /L %%p in (8765,1,8775) do (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%%p/api/health' -UseBasicParsing -TimeoutSec 1).StatusCode } catch { 0 }" | findstr /r "200" >nul && set READY=1 && set LPORT=%%p && goto :done
    )
    timeout /t 1 /nobreak >nul
)
:done

if "%READY%"=="1" (
    echo.
    echo Done. Server is ready at: http://127.0.0.1:%LPORT%
) else (
    echo.
    echo Server did not respond within 25s. Check data/app.log for errors.
    echo It may still be starting (first model load can be slow).
)
echo.
pause
