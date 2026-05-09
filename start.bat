@echo off
setlocal enabledelayedexpansion
title Video Uploader

echo ==============================================
echo    Video Uploader v1.0
echo ==============================================
echo.
echo Checking environment...
echo.

cd /d "%~dp0"

call :auto_update
call :check_files  || goto :die
call :check_node   || goto :die
call :check_deps   || goto :die
call :check_chrome
call :check_ffmpeg
call :check_dirs
call :check_port   || goto :die

echo.
echo ==============================================
echo    All checks passed, starting...
echo ==============================================
echo.

if defined CHROME_PATH (
    start "" "!CHROME_PATH!" "http://localhost:3000"
) else (
    start "" "http://localhost:3000"
)

echo Access: http://localhost:3000
echo Press Ctrl+C to stop
echo.

node server.js

echo.
echo Server stopped.
pause
exit /b 0

:die
echo.
echo ==============================================
echo    Startup failed!
echo    Fix the issues above and retry.
echo ==============================================
pause
exit /b 1

rem --------------------------------------------------
rem  Auto update from GitHub
rem --------------------------------------------------
:auto_update
echo [....] Checking for updates...

if not exist "update-from-github.ps1" (
    echo [WARN] update-from-github.ps1 not found, skip auto update.
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-from-github.ps1" -Prompt
if errorlevel 1 (
    echo [WARN] Auto update failed. Continue with local version.
    exit /b 0
)
exit /b 0

rem --------------------------------------------------
rem  Required files check
rem --------------------------------------------------
:check_files
echo [....] Checking package files...

set "MISSING_FILES="
for %%f in (
    "server.js"
    "batch-upload.js"
    "accounts.js"
    "package.json"
    "public\app.js"
) do (
    if not exist "%%~f" set "MISSING_FILES=!MISSING_FILES! %%~f"
)

if defined MISSING_FILES (
    echo [FAIL] Package is incomplete. Missing:
    for %%f in (!MISSING_FILES!) do echo        %%~f
    echo.
    echo   Please extract the whole wechat-channels-uploader folder first.
    echo   start.bat, server.js, node_modules, public, and installers must be in the same folder.
    echo.
    exit /b 1
)

echo [ OK ] Package files
exit /b 0

rem --------------------------------------------------
rem  Node.js check
rem --------------------------------------------------
:check_node
echo [....] Checking Node.js...

if exist "%~dp0runtime\nodejs\node.exe" (
    set "PATH=%~dp0runtime\nodejs;%PATH%"
)
if exist "%~dp0nodejs\node.exe" (
    set "PATH=%~dp0nodejs;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
    echo [INFO] Node.js not found, checking local installers...
    call :install_node || exit /b 1
)

for /f %%a in ('node -e "console.log(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
    echo [FAIL] Cannot determine Node.js version.
    exit /b 1
)

if !NODE_MAJOR! LSS 18 (
    echo [FAIL] Detected Node.js v!NODE_MAJOR!, need v18 or later.
    echo   Download LTS: https://nodejs.org/
    exit /b 1
)

echo [ OK ] Node.js v!NODE_MAJOR!
exit /b 0

:install_node
set "NODE_INSTALLER="
for %%f in (
    "installers\node-v*-x64.msi"
    "installers\node-*-x64.msi"
    "node-v*-x64.msi"
    "node-*-x64.msi"
) do (
    if not defined NODE_INSTALLER (
        for %%g in (%%f) do if exist "%%~fg" set "NODE_INSTALLER=%%~fg"
    )
)

if not defined NODE_INSTALLER (
    echo [FAIL] Node.js not found.
    echo.
    echo   Put Node.js 18+ x64 MSI installer here:
    echo   installers\node-v20.x.x-x64.msi
    echo.
    exit /b 1
)

echo [INFO] Installing Node.js from:
echo        !NODE_INSTALLER!
msiexec /i "!NODE_INSTALLER!" /qn /norestart
if errorlevel 1 (
    echo [FAIL] Node.js install failed.
    exit /b 1
)

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js installed but node.exe was not found.
    echo   Please restart this bat or restart Windows, then try again.
    exit /b 1
)

echo [ OK ] Node.js installed
exit /b 0

rem --------------------------------------------------
rem  npm dependencies check
rem --------------------------------------------------
:check_deps
echo [....] Checking npm dependencies...

for %%p in (express playwright ws csv-parse xlsx) do (
    if not exist "node_modules\%%p\package.json" (
        echo [INFO] Dependencies missing, installing...
        goto :install_deps
    )
)

for %%a in ("%~dp0package.json") do set "PKG_DT=%%~ta"
for %%a in ("%~dp0node_modules\express\package.json") do set "DEP_DT=%%~ta"
if "!PKG_DT!" gtr "!DEP_DT!" (
    echo [INFO] package.json updated, reinstalling...
    goto :install_deps
)

echo [ OK ] npm dependencies
exit /b 0

:install_deps
echo [INFO] Running npm install...
call npm install
if errorlevel 1 (
    echo [FAIL] npm install failed.
    echo   Check network and try: npm install
    exit /b 1
)
echo [ OK ] npm install complete
exit /b 0

rem --------------------------------------------------
rem  Google Chrome check
rem --------------------------------------------------
:check_chrome
echo [....] Checking Google Chrome...
set "CHROME_PATH="

call :detect_chrome
if defined CHROME_PATH goto :chrome_ok

echo [WARN] Google Chrome not found (optional)
echo   Upload needs Chrome browser.
echo   Download: https://www.google.com/chrome/
echo.
call :install_chrome_local
if defined CHROME_PATH goto :chrome_ok

choice /c YN /n /m "    Install Google Chrome now with winget? [y/N]: "
if errorlevel 2 exit /b 0

where winget >nul 2>&1
if errorlevel 1 (
    echo [WARN] winget not found. Please install Chrome manually.
    echo.
    exit /b 0
)

echo [INFO] Installing Google Chrome...
winget install --id Google.Chrome -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo [WARN] Chrome install failed. Please install Chrome manually.
    echo.
    exit /b 0
)

call :detect_chrome
if defined CHROME_PATH goto :chrome_ok

echo [WARN] Chrome installed but chrome.exe was not found.
echo   Please restart start.bat. If it still fails, send upload.log back.
echo.
exit /b 0

:detect_chrome
if exist "%~dp0runtime\chrome\chrome.exe" (
    set "CHROME_PATH=%~dp0runtime\chrome\chrome.exe"
    exit /b 0
)
if exist "%~dp0chrome\chrome.exe" (
    set "CHROME_PATH=%~dp0chrome\chrome.exe"
    exit /b 0
)
if exist "%~dp0chrome-win64\chrome.exe" (
    set "CHROME_PATH=%~dp0chrome-win64\chrome.exe"
    exit /b 0
)

where chrome.exe >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%a in ('where chrome.exe 2^>nul') do (
        if exist "%%a" set "CHROME_PATH=%%a"
    )
    if defined CHROME_PATH exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    exit /b 0
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    exit /b 0
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    exit /b 0
)

for /f "skip=2 tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    if exist "%%b" set "CHROME_PATH=%%b"
)
if defined CHROME_PATH exit /b 0

for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    if exist "%%b" set "CHROME_PATH=%%b"
)
if defined CHROME_PATH exit /b 0
exit /b 0

:install_chrome_local
set "CHROME_INSTALLER="
set "CHROME_INSTALLER_TYPE="

for %%f in (
    "installers\GoogleChromeStandaloneEnterprise64.msi"
    "installers\googlechromestandaloneenterprise64.msi"
    "GoogleChromeStandaloneEnterprise64.msi"
    "googlechromestandaloneenterprise64.msi"
) do (
    if not defined CHROME_INSTALLER (
        for %%g in (%%f) do if exist "%%~fg" (
            set "CHROME_INSTALLER=%%~fg"
            set "CHROME_INSTALLER_TYPE=msi"
        )
    )
)

for %%f in (
    "installers\ChromeSetup.exe"
    "installers\ChromeStandaloneSetup64.exe"
    "installers\GoogleChromeStandaloneEnterprise64.exe"
    "ChromeSetup.exe"
    "ChromeStandaloneSetup64.exe"
    "GoogleChromeStandaloneEnterprise64.exe"
) do (
    if not defined CHROME_INSTALLER (
        for %%g in (%%f) do if exist "%%~fg" (
            set "CHROME_INSTALLER=%%~fg"
            set "CHROME_INSTALLER_TYPE=exe"
        )
    )
)

if not defined CHROME_INSTALLER (
    echo [INFO] No local Chrome installer found.
    exit /b 0
)

echo [INFO] Installing Google Chrome from:
echo        !CHROME_INSTALLER!
if /i "!CHROME_INSTALLER_TYPE!"=="msi" (
    msiexec /i "!CHROME_INSTALLER!" /qn /norestart
) else (
    "!CHROME_INSTALLER!" /silent /install
)

call :detect_chrome
if defined CHROME_PATH exit /b 0

echo [WARN] Chrome install finished but chrome.exe was not found.
echo   Please restart this bat or install Chrome manually.
exit /b 0

:chrome_ok
echo [ OK ] Chrome installed
exit /b 0

rem --------------------------------------------------
rem  FFmpeg check
rem --------------------------------------------------
:check_ffmpeg
echo [....] Checking FFmpeg...

if exist "%~dp0runtime\ffmpeg\bin\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
    echo [ OK ] Bundled FFmpeg found
    exit /b 0
)
if exist "%~dp0runtime\ffmpeg\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg;%PATH%"
    echo [ OK ] Bundled FFmpeg found
    exit /b 0
)

echo [INFO] Bundled FFmpeg not found, extracting from installers...
call :install_ffmpeg_local

if exist "%~dp0runtime\ffmpeg\bin\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
    echo [ OK ] Bundled FFmpeg ready
) else if exist "%~dp0runtime\ffmpeg\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg;%PATH%"
    echo [ OK ] Bundled FFmpeg ready
) else (
    echo [FAIL] Bundled FFmpeg is required.
    echo   Put ffmpeg*.zip in installers\ and run start.bat again.
    echo   Example: installers\ffmpeg-release-essentials.zip
    echo.
    exit /b 1
)
exit /b 0

:install_ffmpeg_local
set "FFMPEG_ZIP="
set "FFMPEG_ZIP_SIZE=0"
for %%g in ("installers\ffmpeg*.zip" "ffmpeg*.zip") do (
    if exist "%%~fg" (
        if %%~zg GTR !FFMPEG_ZIP_SIZE! (
            set "FFMPEG_ZIP=%%~fg"
            set "FFMPEG_ZIP_SIZE=%%~zg"
        )
    )
)

if not defined FFMPEG_ZIP (
    echo [INFO] No local FFmpeg zip found.
    exit /b 0
)

echo [INFO] Extracting FFmpeg from:
echo        !FFMPEG_ZIP!
if not exist "runtime\" mkdir "runtime"
if exist "runtime\ffmpeg_tmp\" rmdir /s /q "runtime\ffmpeg_tmp"
mkdir "runtime\ffmpeg_tmp"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '!FFMPEG_ZIP!' -DestinationPath '%CD%\runtime\ffmpeg_tmp' -Force"
if errorlevel 1 (
    echo [WARN] FFmpeg zip extraction failed.
    exit /b 0
)

set "FOUND_FFMPEG="
for /r "runtime\ffmpeg_tmp" %%f in (ffmpeg.exe) do (
    if not defined FOUND_FFMPEG set "FOUND_FFMPEG=%%~dpf"
)

if not defined FOUND_FFMPEG (
    echo [WARN] ffmpeg.exe not found inside zip.
    exit /b 0
)

if exist "runtime\ffmpeg\" rmdir /s /q "runtime\ffmpeg"
mkdir "runtime\ffmpeg"
xcopy /e /i /y "!FOUND_FFMPEG!..\*" "runtime\ffmpeg\" >nul

if exist "runtime\ffmpeg\bin\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
    echo [ OK ] FFmpeg extracted
) else if exist "runtime\ffmpeg\ffmpeg.exe" (
    set "PATH=%~dp0runtime\ffmpeg;%PATH%"
    echo [ OK ] FFmpeg extracted
) else (
    echo [WARN] FFmpeg extracted but ffmpeg.exe was not found.
)
exit /b 0

rem --------------------------------------------------
rem  Directory check
rem --------------------------------------------------
:check_dirs
echo [....] Checking directories...

if not exist "uploads\"         (mkdir "uploads"         && echo        Created uploads/)
if not exist "screenshots\"     (mkdir "screenshots"     && echo        Created screenshots/)
if not exist "browser-profile\" (mkdir "browser-profile" && echo        Created browser-profile/)

echo [ OK ] Directories ready
exit /b 0

rem --------------------------------------------------
rem  Port check
rem --------------------------------------------------
:check_port
echo [....] Checking port 3000...

netstat -ano 2>nul | findstr ":3000 " >nul 2>&1
if errorlevel 1 (
    echo [ OK ] Port 3000 available
    exit /b 0
)

echo [WARN] Port 3000 is in use.
set "PORT_PIDS="
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo !PORT_PIDS! | findstr /c:" %%p " >nul 2>&1
    if errorlevel 1 set "PORT_PIDS=!PORT_PIDS! %%p "
)

for %%p in (!PORT_PIDS!) do (
    for /f "tokens=1,* delims==" %%a in ('wmic process where "ProcessId=%%p" get CommandLine /value 2^>nul ^| findstr "CommandLine="') do (
        echo %%b | findstr /i /c:"node.exe" >nul 2>&1
        if not errorlevel 1 (
            echo %%b | findstr /i /c:"server.js" >nul 2>&1
            if not errorlevel 1 (
                echo [INFO] Stopping old server process %%p...
                taskkill /F /PID %%p >nul 2>&1
            )
        )
    )
)

netstat -ano 2>nul | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [ OK ] Port 3000 released
    exit /b 0
)

echo [FAIL] Port 3000 is still in use by another program.
echo   Close the program using port 3000 and retry.
exit /b 1
