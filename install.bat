@echo off
REM install.bat — OBSTriCloner installer for Windows
REM Idempotent: safe to re-run at any time.

setlocal

cd /d "%~dp0"

echo.
echo ============================================
echo   OBSTriCloner Installer (Windows)
echo ============================================
echo.

REM ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Download from https://nodejs.org/  ^(v18 or later^)
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
    echo [ERROR] Node.js is too old ^(need v18+^). Download from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

REM ── npm install ──────────────────────────────────────────────────────────────
echo.
echo [INFO] Running npm install...
call npm install
if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )
echo [OK] Node dependencies installed

REM ── Python deps (optional) ───────────────────────────────────────────────────
where pip3 >nul 2>&1
if not errorlevel 1 (
    if exist "python\requirements.txt" (
        echo.
        echo [INFO] Installing Python dependencies...
        pip3 install -r python\requirements.txt --quiet
        echo [OK] Python dependencies installed
    )
)

REM ── Run setup wizard ─────────────────────────────────────────────────────────
echo.
echo [INFO] Starting OBSTriCloner setup wizard...
echo.
node setup.js

pause
