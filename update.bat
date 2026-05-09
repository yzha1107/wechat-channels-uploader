@echo off
setlocal
title Video Uploader Update

cd /d "%~dp0"

echo ==============================================
echo    Video Uploader Updater
echo ==============================================
echo.

if not exist "update-from-github.ps1" (
    echo [FAIL] update-from-github.ps1 not found.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-from-github.ps1" -Strict
if errorlevel 1 (
    echo.
    echo ==============================================
    echo    Update failed
    echo ==============================================
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [WARN] npm was not found. Code updated, dependencies not checked.
    pause
    exit /b 0
)

echo [INFO] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [FAIL] npm install failed.
    pause
    exit /b 1
)

echo.
echo ==============================================
echo    Update complete
echo ==============================================
pause
exit /b 0
