@echo off
rem ── pi-weixin-hub deploy ─────────────────────────────────────────────
rem Build + restart the daemon so committed code goes live.
rem Usage: scripts\deploy.cmd   (also run automatically by the post-commit hook)

cd /d %~dp0\..

echo [deploy] building...
call npm run build
if errorlevel 1 (
  echo [deploy] BUILD FAILED - daemon NOT restarted
  exit /b 1
)

echo [deploy] restarting daemon...
node dist\main.js stop
timeout /t 3 /nobreak >nul
node dist\main.js --fork
echo [deploy] done - new daemon started
