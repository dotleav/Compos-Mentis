@echo off
title OSCE AI Simulator
cd /d "%~dp0"

if not exist "node_modules" (
    echo ============================================
    echo  First-time setup - this only happens once.
    echo  Installing required files, please wait...
    echo ============================================
    call npm install
    echo.
)

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo A .env file was created for you. Edit it later if you want to add API keys.
    echo.
)

echo Starting OSCE AI Simulator...
echo Your browser will open automatically in a few seconds.
echo.
echo IMPORTANT: Keep this window open while using the app.
echo Closing this window will stop the simulator.
echo.

start "" cmd /c "timeout /t 3 >nul && start http://localhost:3000"

call npm start

echo.
echo Simulator stopped.
pause
