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

call :backup_local_secrets
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-from-github.ps1" -Strict
call :restore_local_secrets
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

:backup_local_secrets
if exist "%~dp0ark-api-key.txt" (
    if not exist "%~dp0.local-backup" mkdir "%~dp0.local-backup" >nul 2>nul
    copy /Y "%~dp0ark-api-key.txt" "%~dp0.local-backup\ark-api-key.txt" >nul 2>nul
)
exit /b 0

:restore_local_secrets
if not exist "%~dp0ark-api-key.txt" (
    if exist "%~dp0.local-backup\ark-api-key.txt" (
        copy /Y "%~dp0.local-backup\ark-api-key.txt" "%~dp0ark-api-key.txt" >nul 2>nul
        echo [INFO] Restored local ark-api-key.txt
    )
)
exit /b 0
